import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createIncidentEvent } from '@ykurilov/remontnik-core/incident'
import { createCaseBook } from '../case-book/index.js'
import { createControls } from '../ledgers/controls.js'
import { createMemoryRecordStore, type RecordStore } from '../records/index.js'
import { testRemontnikConfig } from '../testing/config.js'
import { createFakeDeployApp, type FakeDeployApp } from '../testing/fake-deploy-app.js'
import type { AppCommands } from './app-commands.js'
import { createDeployer, type DeployRequest, type Deployment } from './deploy-sequence.js'
import { createDeployLock } from './lock.js'

// Порядок выкатки (contracts/deploy-commands.md) и её доведение до конца после падения врача на любом шаге.
// Часы подменены: сон выкатки (`sleep`) сразу переводит часы на время пробуждения.

const PREV = 'a'.repeat(40)
const OLDER = 'b'.repeat(40)
const CAND = 'c'.repeat(40)
const START = Date.parse('2026-10-26T12:00:00Z')
const MINUTE = 60_000
const request: DeployRequest = { caseId: 7, appName: 'patient', fingerprint: 'fp-case', candidateVersion: CAND, candidateDir: '/srv/copies/7' }

class Crash extends Error {}

interface RigOptions {
  app?: FakeDeployApp
  request?: DeployRequest
  /** После команды приложения: подставить событие мира (стоп-кран, человек, ошибки). */
  afterCommand?: (name: keyof AppCommands, rig: Rig) => void | Promise<void>
  /** Перед каждым шагом выкатки (после сна). */
  beforeStep?: (rig: Rig) => void | Promise<void>
}

interface Rig {
  app: FakeDeployApp
  records: RecordStore
  lockPath: string
  tags: Array<[string, string]>
  now(): number
  /** Падение врача сразу после N-го внешнего действия или записи. */
  crashAfter(effect: number): void
  effects(): number
  crashes(): number
  drive(maxSteps?: number): Promise<Deployment>
}

function rig(options: RigOptions = {}): Rig {
  const { app: given } = options
  const app = given ?? createFakeDeployApp({ running: PREV, previous: OLDER })
  const memory = createMemoryRecordStore()
  const lockPath = join(mkdtempSync(join(tmpdir(), 'remontnik-deploy-')), '.remontnik', 'deploy.lock')
  const tags: Array<[string, string]> = []
  const config = testRemontnikConfig()
  let clock = START
  let effects = 0
  let crashAt = Infinity
  let crashes = 0

  async function effect<T>(action: () => Promise<T>): Promise<T> {
    const result = await action()
    effects += 1
    if (effects === crashAt) {
      crashes += 1
      throw new Crash()
    }
    return result
  }

  const store: RecordStore = {
    transaction: (change) => effect(() => memory.transaction(change)),
    read: (collection, key) => memory.read(collection, key),
  }

  const self: Rig = {
    app,
    records: memory,
    lockPath,
    tags,
    now: () => clock,
    crashAfter: (effect) => {
      crashAt = effect
    },
    effects: () => effects,
    crashes: () => crashes,
    async drive(maxSteps = 2000) {
      const commands = Object.fromEntries(
        Object.entries(app.commands).map(([name, command]) => [
          name,
          async (...args: unknown[]) =>
            effect(async () => {
              const result = await (command as (...args: unknown[]) => Promise<unknown>)(...args)
              await options.afterCommand?.(name as keyof AppCommands, self)
              return result
            }),
        ]),
      ) as unknown as AppCommands
      const deployer = () =>
        createDeployer({
          loadConfig: async () => config,
          commandsFor: () => commands,
          lockFor: () => {
            const lock = createDeployLock(lockPath)
            return {
              acquire: (...args) => effect(() => lock.acquire(...args)),
              release: (id) => effect(() => lock.release(id)),
            }
          },
          tagPreDeploy: (name, commit) =>
            effect(async () => {
              const same = tags.find(([tag]) => tag === name)
              if (same && same[1] !== commit) return { ok: false as const, reason: 'метка на другом коммите' }
              if (!same) tags.push([name, commit])
              return { ok: true as const }
            }),
        })
      let current = deployer()
      for (let steps = 0; steps < maxSteps; steps += 1) {
        await options.beforeStep?.(self)
        let step
        try {
          step = await current.step(options.request ?? request, { store, now: () => clock })
        } catch (error) {
          if (!(error instanceof Crash)) throw error
          // Врач упал: новый процесс, те же записи и тот же сервер.
          current = deployer()
          continue
        }
        if (step.kind === 'done') return step.deployment
        clock = Math.max(clock, step.until)
      }
      throw new Error('выкатка не закончилась')
    },
  }
  return self
}

const sickAfterPromote = (app: FakeDeployApp) => app.setHealth((running) => (running === CAND ? { ok: false, reason: 'страница отвечает 500' } : { ok: true }))
const count = (calls: string[], name: string) => calls.filter((call) => call === name).length

describe('порядок выкатки', () => {
  it('замок → current → метка на прежней версии → build → promote → current = кандидат → health → наблюдение → confirm → замок снят', async () => {
    const lockSeen: boolean[] = []
    const r = rig({ afterCommand: (name, self) => void (name === 'build' && lockSeen.push(existsSync(self.lockPath))) })
    const deployment = await r.drive()

    const firsts = ['current', `build ${CAND}`, 'promote', 'health', 'confirm'].map((call) => r.app.calls.indexOf(call))
    expect(firsts.every((index, i) => index >= 0 && (i === 0 || index > firsts[i - 1]!))).toBe(true)
    expect(r.app.calls[r.app.calls.indexOf('promote') + 1]).toBe('current')
    expect(lockSeen).toEqual([true])
    expect(existsSync(r.lockPath)).toBe(false)
    expect(r.tags).toEqual([[`remontnik/pre-deploy/2026-10-26-7-${deployment.deploymentId}`, PREV]])

    expect(deployment).toMatchObject({
      caseId: 7,
      outcome: 'holding',
      previousVersion: PREV,
      candidateVersion: CAND,
      preDeployTag: r.tags[0]![0],
      baseline: { errorsPerHour: 0, knownFingerprints7d: [] },
    })
    const promotedAt = Date.parse(deployment.promotedAt!)
    expect(Date.parse(deployment.observeUntil!)).toBe(promotedAt + 30 * MINUTE)
    expect(Date.parse(deployment.endedAt!)).toBeGreaterThanOrEqual(Date.parse(deployment.observeUntil!))
    expect(r.app.running).toBe(CAND)
    expect(r.app.previous).toBe(PREV)
    expect(count(r.app.calls, 'confirm')).toBe(1)
    expect(count(r.app.calls, 'rollback')).toBe(0)
  })

  it('повторный вызов после конца — тот же итог без новых действий', async () => {
    const r = rig()
    const first = await r.drive()
    const calls = r.app.calls.length
    expect(await r.drive()).toEqual(first)
    expect(r.app.calls.length).toBe(calls)
  })

  it('нет работающей версии — откатывать будет некуда: отказ до сборки', async () => {
    const r = rig({ app: createFakeDeployApp({ running: null }) })
    const deployment = await r.drive()
    expect(deployment).toMatchObject({ outcome: 'refused', refusal: 'no_previous_build' })
    expect(r.app.calls).toEqual(['current'])
    expect(r.tags).toEqual([])
    expect(existsSync(r.lockPath)).toBe(false)
  })

  it('current не отвечает до выкатки — отказ, ничего не выкачено', async () => {
    const app = createFakeDeployApp({ running: PREV })
    app.setCurrentBroken(true)
    const r = rig({ app })
    expect(await r.drive()).toMatchObject({ outcome: 'refused', refusal: 'current_unavailable' })
    expect(count(app.calls, 'promote') + count(app.calls, 'rollback')).toBe(0)
  })

  it('сборка упала — отказ, работающую версию не трогали', async () => {
    const app = createFakeDeployApp({ running: PREV })
    app.failNext('build')
    const r = rig({ app })
    expect(await r.drive()).toMatchObject({ outcome: 'refused', refusal: 'build_failed', detail: expect.stringContaining('сборка упала') })
    expect(count(app.calls, 'promote')).toBe(0)
    expect(existsSync(r.lockPath)).toBe(false)
  })

  it('promote упал, а работает всё ещё прежняя — отказ без отката', async () => {
    const app = createFakeDeployApp({ running: PREV, previous: OLDER })
    app.failNext('promote')
    const r = rig({ app })
    expect(await r.drive()).toMatchObject({ outcome: 'refused', refusal: 'promote_failed' })
    expect(count(app.calls, 'rollback')).toBe(0)
    expect(app.running).toBe(PREV)
  })

  it('стоп-кран: до начала — выкатки нет; нажат во время сборки — до promote не доходит', async () => {
    const stopped = rig()
    await createControls(stopped.records).set('stop', 'telegram:admin')
    expect(await stopped.drive()).toMatchObject({ outcome: 'refused', refusal: 'stop_switch' })
    expect(stopped.app.calls).toEqual([])
    expect(existsSync(stopped.lockPath)).toBe(false)

    const midway = rig({ afterCommand: async (name, self) => void (name === 'build' && (await createControls(self.records).set('stop', 'console'))) })
    expect(await midway.drive()).toMatchObject({ outcome: 'refused', refusal: 'stop_switch' })
    expect(count(midway.app.calls, 'promote')).toBe(0)
    expect(existsSync(midway.lockPath)).toBe(false)
  })
})

describe('откат', () => {
  it('сбой после promote (здоровье) — rollback, current = прежняя, причина записана', async () => {
    const app = createFakeDeployApp({ running: PREV, previous: OLDER })
    sickAfterPromote(app)
    const r = rig({ app })
    const deployment = await r.drive()
    expect(deployment).toMatchObject({ outcome: 'rolled_back', rollbackCause: 'health', healthyAfterRollback: true })
    expect(deployment.rollbackReason).toContain('страница отвечает 500')
    expect(app.running).toBe(PREV)
    expect(count(app.calls, 'rollback')).toBe(1)
    expect(count(app.calls, 'confirm')).toBe(0)
    // Три сбоя подряд, раз в 30 с: откат через минуту после выкатки.
    expect(Date.parse(deployment.endedAt!) - Date.parse(deployment.promotedAt!)).toBeLessThanOrEqual(2 * MINUTE)
    expect(existsSync(r.lockPath)).toBe(false)
  })

  it('current молчит после promote — откат; после него снова отвечает', async () => {
    const app = createFakeDeployApp({ running: PREV, previous: OLDER })
    const r = rig({
      app,
      afterCommand: (name) => {
        if (name === 'promote') app.setCurrentBroken(true)
        if (name === 'rollback') app.setCurrentBroken(false)
      },
    })
    expect(await r.drive()).toMatchObject({ outcome: 'rolled_back', rollbackCause: 'current_unavailable' })
    expect(app.running).toBe(PREV)
  })

  it('ошибок после выкатки больше, чем до неё (книга случаев), — откат', async () => {
    const r = rig({
      beforeStep: async (self) => {
        if (self.app.running !== CAND) return
        await createCaseBook(self.records).recordEvents([
          createIncidentEvent({ appName: 'patient', kind: 'crash', where: 'src/x.ts', message: 'сбой x', occurredAt: new Date(self.now()), context: { repeats: 4 } }),
        ])
      },
    })
    const deployment = await r.drive()
    expect(deployment).toMatchObject({ outcome: 'rolled_back', rollbackCause: 'error_rate' })
    expect(r.app.running).toBe(PREV)
  })

  it('откат не удался трижды — rollback_failed, замок снят', async () => {
    const app = createFakeDeployApp({ running: PREV, previous: OLDER })
    sickAfterPromote(app)
    app.failNext('rollback', 3)
    const r = rig({ app })
    expect(await r.drive()).toMatchObject({ outcome: 'rollback_failed', rollbackCause: 'health' })
    expect(count(app.calls, 'rollback')).toBe(3)
    expect(existsSync(r.lockPath)).toBe(false)
  })
})

describe('итоги наблюдения', () => {
  it('тот же сбой повторяется без ухудшения — не помогло, без отката, версия остаётся', async () => {
    const caseEvent = createIncidentEvent({ appName: 'patient', kind: 'crash', where: 'src/case.ts', message: 'сбой случая' })
    const r = rig({
      request: { ...request, fingerprint: caseEvent.fingerprint },
      beforeStep: async (self) => {
        if (self.app.running !== CAND || (self.now() - START) % (10 * MINUTE) !== 0) return
        const event = createIncidentEvent({ appName: 'patient', kind: 'crash', where: 'src/case.ts', message: 'сбой случая', occurredAt: new Date(self.now()) })
        await createCaseBook(self.records).recordEvents([event])
      },
    })
    const deployment = await r.drive()
    expect(deployment.outcome).toBe('not_helped')
    expect(r.app.running).toBe(CAND)
    expect(count(r.app.calls, 'rollback')).toBe(0)
    expect(count(r.app.calls, 'confirm')).toBe(1)
  })

  it('человек выкатил своё в окне наблюдения — superseded_by_human, чужую выкатку не откатываем', async () => {
    const app = createFakeDeployApp({ running: PREV, previous: OLDER })
    const r = rig({ app, beforeStep: (self) => void (self.now() - START >= 10 * MINUTE && app.running === CAND && app.humanDeploys('d'.repeat(40))) })
    const deployment = await r.drive()
    expect(deployment).toMatchObject({ outcome: 'superseded_by_human', supersededBy: 'd'.repeat(40) })
    expect(count(app.calls, 'rollback')).toBe(0)
    expect(app.running).toBe('d'.repeat(40))
    expect(existsSync(r.lockPath)).toBe(false)
  })
})

describe('общий замок', () => {
  it('ручная выкатка держит замок: врач спит и ждёт, потом выкатывает', async () => {
    let steps = 0
    const r = rig({
      beforeStep: (self) => {
        steps += 1
        if (steps === 3) rmSync(self.lockPath)
      },
    })
    mkdirSync(dirname(r.lockPath), { recursive: true })
    writeFileSync(r.lockPath, 'manual deploy\n', { flag: 'wx' })

    const deployment = await r.drive()
    expect(deployment.outcome).toBe('holding')
    expect(deployment.waitingLockSince).toBe(new Date(START).toISOString())
    expect(Date.parse(deployment.startedAt)).toBe(START)
    expect(Date.parse(deployment.promotedAt!)).toBeGreaterThan(START)
    expect(r.app.calls.indexOf('current')).toBeGreaterThanOrEqual(0)
    expect(existsSync(r.lockPath)).toBe(false)
  })

  it('пока выкатка идёт, файл замка — её, ручной скрипт с noclobber не начнёт свою', async () => {
    const seen: string[] = []
    const r = rig({ afterCommand: (name, self) => void (name === 'promote' && seen.push(readFileSync(self.lockPath, 'utf8'))) })
    const deployment = await r.drive()
    expect(seen[0]).toMatch(new RegExp(`^remontnik deployment ${deployment.deploymentId} `))
  })
})

describe('падение врача посреди выкатки', () => {
  const scenarios = {
    holding: { prepare: () => createFakeDeployApp({ running: PREV, previous: OLDER }), running: CAND, rollbacks: 0 },
    rolled_back: {
      prepare: () => {
        const app = createFakeDeployApp({ running: PREV, previous: OLDER })
        sickAfterPromote(app)
        return app
      },
      running: PREV,
      rollbacks: 1,
    },
  } as const

  for (const [outcome, scenario] of Object.entries(scenarios)) {
    it(`${outcome}: падение после каждого шага — тот же итог, одна выкатка, откат не потерян и не повторён`, async () => {
      const clean = rig({ app: scenario.prepare() })
      expect((await clean.drive()).outcome).toBe(outcome)
      const total = clean.effects()
      expect(total).toBeGreaterThan(10)

      for (let crashAt = 1; crashAt <= total; crashAt += 1) {
        const r = rig({ app: scenario.prepare() })
        r.crashAfter(crashAt)
        const deployment = await r.drive()
        const where = `падение после действия ${crashAt}`
        expect(r.crashes(), where).toBe(1)
        expect(deployment.outcome, where).toBe(outcome)
        expect(count(r.app.calls, 'promote'), where).toBe(1)
        expect(count(r.app.calls, 'rollback'), where).toBe(scenario.rollbacks)
        expect(r.app.running, where).toBe(scenario.running)
        expect(r.tags.length, where).toBe(1)
        expect(existsSync(r.lockPath), where).toBe(false)
      }
    })
  }
})
