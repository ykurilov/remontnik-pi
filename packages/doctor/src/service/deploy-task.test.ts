import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { defineExtension, defineTask, type TaskId } from '@earendil-works/pi-durable'
import { createDeployer, readDeployment, type DeployOutcome, type DeployRequest } from '../deployer/deploy-sequence.js'
import { createDeployLock } from '../deployer/lock.js'
import { testRemontnikConfig } from '../testing/config.js'
import { createFakeDeployApp, type FakeDeployApp } from '../testing/fake-deploy-app.js'
import { openDoctorHarness, runDeploymentInTask, type DoctorHarness } from './harness.js'

// Выкатка внутри настоящей задачи pi-durable: сон между тиками — `sleepUntil`, записи — в фиксациях задачи,
// после перезапуска врача задача продолжает выкатку с сохранённого шага, не выкатывая второй раз.

const PREV = 'a'.repeat(40)
const CAND = 'c'.repeat(40)
const request: DeployRequest = { caseId: 3, appName: 'patient', fingerprint: 'fp-case', candidateVersion: CAND, candidateDir: '/srv/copies/3' }

type DeployCheckpoint = { phase: 'deploying' }

function deployTask(app: FakeDeployApp, lockPath: string) {
  const deployer = createDeployer({
    loadConfig: async () => testRemontnikConfig(),
    commandsFor: () => app.commands,
    mainCopyFor: () => app.mainCopy,
    lockFor: () => createDeployLock(lockPath),
    tagPreDeploy: async () => ({ ok: true }),
  })
  return defineTask<{ caseId: number }, DeployCheckpoint, { outcome: DeployOutcome; deploymentId: number }>({
    name: 'test.deploy',
    version: 1,
    initial: () => ({ phase: 'deploying' }),
    phases: {
      async deploying(_task, runtime, context) {
        const step = await runDeploymentInTask(runtime, deployer, request, { phase: 'deploying' }, context)
        if (step.kind === 'sleep') return
        const { outcome, deploymentId } = step.deployment
        await runtime.commit(() => ({ status: 'terminal', outcome: { status: 'completed', result: { outcome, deploymentId } } }), context)
      },
    },
    abort: (_task, runtime, context) => runtime.commit(() => ({ status: 'terminal', outcome: { status: 'aborted' } }), context),
  })
}

/** Часы врача, которые при сне задачи сами переходят на время пробуждения. */
function fakeClock() {
  let now = Date.parse('2026-10-26T12:00:00Z')
  let opened: DoctorHarness | undefined
  let sleeps = 0
  return {
    now: () => now,
    sleeps: () => sleeps,
    attach(harness: DoctorHarness) {
      opened = harness
    },
    onWake(wake: { active: boolean; at?: number }) {
      if (wake.active || wake.at === undefined) return
      const at = wake.at
      sleeps += 1
      setImmediate(() => {
        now = Math.max(now, at)
        opened?.harness.resume()
      })
    },
  }
}

async function open(stateDir: string, app: FakeDeployApp, lockPath: string, clock: ReturnType<typeof fakeClock>) {
  const opened = await openDoctorHarness({ stateDir, onReport: () => {}, now: clock.now, onWake: (wake) => clock.onWake(wake) })
  clock.attach(opened)
  const task = deployTask(app, lockPath)
  opened.registry.install(defineExtension({ name: 'test.deploy', tasks: [task] }))
  return { opened, task }
}

describe('выкатка в задаче pi-durable', () => {
  it('задача спит между тиками наблюдения и доводит выкатку до «держится»', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'remontnik-deploy-task-'))
    const lockPath = join(stateDir, 'app', '.remontnik', 'deploy.lock')
    const app = createFakeDeployApp({ running: PREV })
    const clock = fakeClock()
    const { opened, task } = await open(stateDir, app, lockPath, clock)

    const taskId = await opened.harness.commit(async (tx) => {
      const conversation = await tx.createConversation({ ownership: { kind: 'ownerless' } })
      return tx.createTask(task, { caseId: 3 }, { ownership: { kind: 'conversation' }, conversationId: conversation.id, background: true })
    }, BACKGROUND_CONTEXT)
    opened.harness.resume()
    const settled = await opened.harness.waitForTask(taskId, BACKGROUND_CONTEXT)

    expect(settled.state.outcome).toMatchObject({ status: 'completed', result: { outcome: 'holding' } })
    expect(app.promotes).toBe(1)
    expect(app.running).toBe(CAND)
    expect(clock.sleeps()).toBeGreaterThan(10)
    const result = (settled.state.outcome as { result: { deploymentId: number } }).result
    expect(await readDeployment(opened.records, result.deploymentId)).toMatchObject({ stage: 'done', outcome: 'holding', taskId })
    await opened.close()
  })

  it('врач перезапустился посреди наблюдения: задача продолжает ту же выкатку без второго promote', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'remontnik-deploy-task-'))
    const lockPath = join(stateDir, 'app', '.remontnik', 'deploy.lock')
    const app = createFakeDeployApp({ running: PREV })
    const clock = fakeClock()
    const first = await open(stateDir, app, lockPath, clock)
    const taskId: TaskId = await first.opened.harness.commit(async (tx) => {
      const conversation = await tx.createConversation({ ownership: { kind: 'ownerless' } })
      return tx.createTask(first.task, { caseId: 3 }, { ownership: { kind: 'conversation' }, conversationId: conversation.id, background: true })
    }, BACKGROUND_CONTEXT)
    // Врач гаснет после третьего тика наблюдения.
    let ticks = 0
    const health = app.commands.health
    app.commands.health = async () => {
      ticks += 1
      if (ticks === 3) void first.opened.close()
      return health()
    }
    first.opened.harness.resume()
    await first.opened.closed
    expect(app.promotes).toBe(1)

    app.commands.health = health
    const second = await open(stateDir, app, lockPath, clock)
    second.opened.harness.resume()
    const settled = await second.opened.harness.waitForTask(taskId, BACKGROUND_CONTEXT)

    expect(settled.state.outcome).toMatchObject({ status: 'completed', result: { outcome: 'holding' } })
    expect(app.promotes).toBe(1)
    expect(app.rollbacks).toBe(0)
    expect(app.calls.filter((call) => call.startsWith('build'))).toHaveLength(1)
    await second.opened.close()
  })
})
