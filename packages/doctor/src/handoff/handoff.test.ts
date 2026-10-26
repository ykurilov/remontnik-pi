import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Wake } from '@earendil-works/pi-durable'
import type { RemontnikConfig } from '@ykurilov/remontnik-core/config'
import { createIncidentEvent } from '@ykurilov/remontnik-core/incident'
import { startFakeTelegram, type FakeTelegramServer } from '@ykurilov/remontnik-core/testing'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { CaseState } from '../case-book/index.js'
import { createDeployer, createDeployLock } from '../deployer/index.js'
import { createGitGuard } from '../git-guard/index.js'
import type { ReportType } from '../reports/index.js'
import { startDoctorService, type DoctorService } from '../service/index.js'
import { testRemontnikConfig } from '../testing/config.js'
import { createFakeDeployApp, type FakeDeployApp } from '../testing/fake-deploy-app.js'
import { startFakePaseoBridge, type FakePaseoBridge } from '../testing/fake-paseo-bridge.js'
import { callTool, createScriptedModel, type ScriptedModel } from '../testing/scripted-model.js'
import { createLocalRunner } from '../workbench/index.js'

// Режим «сначала Paseo» (T116): врач передаёт случай агенту через мост и сам его не лечит, пока агент работает.
// Мост не ответил за 3 с — врач лечит сам с пометкой «Paseo недоступен». Агент не взял случай, не уложился,
// не смог или мост пропал — врач отменяет задачу и забирает случай (`reclaimed`, `owner: doctor`). Итог агента после
// этого — только `lateResult`. Часы врача перескакивают на время пробуждения спящей задачи.

const BRIDGE_SECRET = 'bridge-secret-for-tests'
const APP = 'test-app'
const FINAL_STATES: CaseState[] = ['healed', 'healed_by_paseo', 'rolled_back', 'not_helped', 'report_only', 'needs_human', 'no_cause_found', 'stand_broken']

const dirs: string[] = []
const cleanups: (() => Promise<void>)[] = []
let telegram: FakeTelegramServer

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' } }).trim()
}

function repo() {
  const root = mkdtempSync(join(tmpdir(), 'remontnik-handoff-'))
  dirs.push(root)
  const origin = join(root, 'origin.git')
  const repoDir = join(root, 'main')
  git(root, 'init', '--bare', '--initial-branch=main', origin)
  git(root, 'clone', origin, repoDir)
  git(repoDir, 'config', 'user.email', 'owner@example.com')
  git(repoDir, 'config', 'user.name', 'Owner')
  writeFileSync(join(repoDir, '.gitignore'), '.remontnik/\n')
  writeFileSync(join(repoDir, 'price.mjs'), 'export const price = () => 1\n')
  git(repoDir, 'add', '-A')
  git(repoDir, 'commit', '-m', 'начало')
  git(repoDir, 'push', 'origin', 'main')
  return { root, repoDir, base: git(repoDir, 'rev-parse', 'HEAD'), stateDir: join(root, 'state'), worktreesDir: join(root, 'worktrees'), lockPath: join(repoDir, '.remontnik', 'deploy.lock') }
}

type Repo = ReturnType<typeof repo>

/** Часы врача: перед каждым пробуждением — ход агента (`beforeWake`), потом часы перескакивают на время пробуждения. */
function fakeClock() {
  let offset = 0
  const clock = {
    now: () => Date.now() + offset,
    beforeWake: async () => {},
    onWake(wake: Wake, resume: () => void) {
      if (wake.active || wake.at === undefined) return
      const at = wake.at
      setImmediate(() => {
        void clock
          .beforeWake()
          .then(() => {
            offset += Math.max(0, at - clock.now())
            resume()
          })
          .catch(() => {})
      })
    },
  }
  return clock
}

type Clock = ReturnType<typeof fakeClock>

function handoffConfig(paseo: Partial<NonNullable<RemontnikConfig['handoff']['paseo']>> = {}): RemontnikConfig {
  const base = testRemontnikConfig()
  return testRemontnikConfig({
    app: { name: APP, timeZone: 'UTC' },
    repo: { mainBranch: 'main', mainline: 'pull-request' },
    workbench: { image: 'node:22', install: 'true', bashTimeoutMs: 30_000 },
    checks: { test: 'true' },
    observe: { ...base.observe, windowMinutes: 2, healthWindowTicks: 3 },
    handoff: {
      mode: 'paseo-first',
      paseo: { bridgeUrlEnv: 'REMONTNIK_PASEO_BRIDGE_URL', bridgeSecretEnv: 'REMONTNIK_PASEO_BRIDGE_SECRET', listenEnv: 'REMONTNIK_PASEO_LISTEN', acceptTimeoutMs: 300_000, workTimeoutMs: 600_000, ...paseo },
    },
  })
}

interface World {
  r: Repo
  doctor: DoctorService
  bridge: FakePaseoBridge
  model: ScriptedModel
  clock: Clock
  app?: FakeDeployApp
}

async function startWorld(options: { app?: FakeDeployApp; withBridge?: boolean } = {}): Promise<World> {
  const r = repo()
  const clock = fakeClock()
  const model = createScriptedModel()
  const config = handoffConfig()
  const loadConfig = async () => config
  const guard = createGitGuard({ repoDir: r.repoDir, worktreesDir: r.worktreesDir, mainBranch: 'main', mainline: 'pull-request', author: { name: 'Ремонтник', email: 'doctor@example.invalid' } })
  const app = options.app
  const bridge = await startFakePaseoBridge({ secret: BRIDGE_SECRET, appName: APP })
  cleanups.push(() => bridge.close())
  const deployer = app
    ? createDeployer({
        loadConfig,
        commandsFor: () => app.commands,
        mainCopyFor: () => app.mainCopy,
        lockFor: () => createDeployLock(r.lockPath),
        tagPreDeploy: async () => ({ ok: true }),
      })
    : undefined
  const doctor = await startDoctorService({
    stateDir: r.stateDir,
    sharedSecret: 'shared-test-secret',
    listen: { host: '127.0.0.1', port: 0 },
    telegram: { botToken: '123456:test-bot-token', chatId: 'owner-chat', apiBaseUrl: telegram.baseUrl },
    reportsFeed: { bridge: { listen: { host: '127.0.0.1', port: 0 }, secret: BRIDGE_SECRET, appName: APP } },
    ...(options.withBridge === false ? {} : { paseoBridge: { url: bridge.url } }),
    exit: () => {},
    log: () => {},
    now: clock.now,
    onWake: (wake, resume) => clock.onWake(wake, resume),
    treatment: {
      guard,
      loadConfig,
      currentVersion: async () => app?.running ?? r.base,
      worktreesDir: r.worktreesDir,
      models: model.models,
      model: model.model,
      runner: createLocalRunner(),
      allowUnisolatedRunner: true,
      ...(deployer ? { deployer } : {}),
    },
  })
  cleanups.push(() => doctor.close())
  bridge.connect(doctor.bridgeUrl!)
  return { r, doctor, bridge, model, clock, ...(app ? { app } : {}) }
}

/** Врач, если лечит сам, не находит причину: случай закрывается быстро. */
function noCause(model: ScriptedModel): void {
  model.script(callTool('finish_diagnosis', { found: false, cause: 'не нашёл', evidence: [], confidence: 'low' }))
}

async function openCase(doctor: DoctorService): Promise<void> {
  await doctor.receiveEvents([
    createIncidentEvent({ appName: APP, kind: 'crash', where: 'price.mjs:1:1', message: 'нет тарифа starter', stack: 'Error: нет тарифа starter', occurredAt: new Date() }),
  ])
}

async function settledCase(doctor: DoctorService, states: CaseState[] = FINAL_STATES, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const found = await doctor.caseBook.getCase(1)
    if (found && states.includes(found.state)) return found
    if (Date.now() > deadline) throw new Error(`случай не дошёл до ${states.join('/')}: ${found?.state}`)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

async function reportTypes(doctor: DoctorService): Promise<ReportType[]> {
  return (await doctor.reports.list({ after: 0, limit: 100 })).map((report) => report.type)
}

beforeEach(async () => {
  telegram = await startFakeTelegram()
})

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup().catch(() => {})
  await telegram.close()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('режим «сначала Paseo»', () => {
  it('мост не ответил на /health за 3 с: задачи нет, врач лечит сам, в отчёте «Paseo недоступен»', async () => {
    const world = await startWorld()
    world.bridge.health = 'hang'
    noCause(world.model)
    const startedAt = Date.now()
    await openCase(world.doctor)

    const settled = await settledCase(world.doctor)
    expect(settled.state).toBe('no_cause_found')
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(2_900)
    expect(world.bridge.tasks).toHaveLength(0)
    expect(world.model.requests.length).toBeGreaterThan(0)
    expect(await world.doctor.handoffOf(1)).toMatchObject({ owner: 'doctor' })
    const last = (await world.doctor.reports.list({ after: 0, limit: 100 })).at(-1)!
    expect(last.type).toBe('no_cause_found')
    expect(last.full).toContain('Paseo недоступен')
  }, 30_000)

  it('моста нет в настройке врача: тоже «Paseo недоступен», врач лечит сам', async () => {
    const world = await startWorld({ withBridge: false })
    noCause(world.model)
    await openCase(world.doctor)
    expect((await settledCase(world.doctor)).state).toBe('no_cause_found')
    expect((await world.doctor.reports.list({ after: 0, limit: 100 })).at(-1)!.full).toContain('Paseo недоступен')
  })

  it('передал агенту: модель врача не зовётся; агент сделал без выкатки — случай закрыт агентом', async () => {
    const world = await startWorld()
    let step = 0
    world.clock.beforeWake = async () => {
      if (world.bridge.tasks.length === 0) return
      if (step === 0) expect((await world.bridge.accept(1)).status).toBe(200)
      if (step === 1) expect((await world.bridge.done(1, { commit: 'abc1234' })).status).toBe(200)
      step += 1
    }
    await openCase(world.doctor)

    expect((await settledCase(world.doctor)).state).toBe('healed_by_paseo')
    expect(world.model.requests).toHaveLength(0)
    expect(world.bridge.tasks).toHaveLength(1)
    expect(world.bridge.tasks[0]).toMatchObject({ app: APP, caseId: 1, kind: 'crash' })
    expect(world.bridge.tasks[0]!.summary).not.toContain('starter')
    expect(world.bridge.cancels).toHaveLength(0)
    expect(await world.doctor.handoffOf(1)).toMatchObject({ owner: 'paseo', result: { kind: 'done', commit: 'abc1234', deployed: false } })
    const types = await reportTypes(world.doctor)
    expect(types).toContain('handed_off')
    expect(types.at(-1)).toBe('paseo_done')
  })

  it('агент не взял случай за acceptTimeoutMs: отмена, reclaimed, owner: doctor — дальше врач лечит сам', async () => {
    const world = await startWorld()
    noCause(world.model)
    await openCase(world.doctor)

    expect((await settledCase(world.doctor)).state).toBe('no_cause_found')
    const handoff = (await world.doctor.handoffOf(1))!
    expect(handoff).toMatchObject({ owner: 'doctor', reclaimReason: 'accept_timeout' })
    expect(Date.parse(handoff.reclaimedAt!) - Date.parse(handoff.sentAt!)).toBeGreaterThanOrEqual(300_000)
    expect(world.bridge.cancels).toEqual([{ taskId: handoff.taskId, reason: expect.any(String) }])
    expect(world.model.requests.length).toBeGreaterThan(0)
    expect(await reportTypes(world.doctor)).toEqual(expect.arrayContaining(['handed_off', 'reclaimed', 'no_cause_found']))
  })

  it('агент взял, но не уложился в workTimeoutMs: отмена и reclaimed', async () => {
    const world = await startWorld()
    noCause(world.model)
    let accepted = false
    world.clock.beforeWake = async () => {
      if (world.bridge.tasks.length === 0 || accepted) return
      accepted = true
      await world.bridge.accept(1)
    }
    await openCase(world.doctor)

    expect((await settledCase(world.doctor)).state).toBe('no_cause_found')
    const handoff = (await world.doctor.handoffOf(1))!
    expect(handoff).toMatchObject({ owner: 'doctor', reclaimReason: 'work_timeout' })
    expect(handoff.acceptedAt).toBeDefined()
    expect(Date.parse(handoff.reclaimedAt!) - Date.parse(handoff.sentAt!)).toBeGreaterThanOrEqual(600_000)
    expect(world.bridge.cancels).toHaveLength(1)
  })

  it('агент не смог (cannot): отмена и reclaimed, врач лечит сам', async () => {
    const world = await startWorld()
    noCause(world.model)
    let step = 0
    world.clock.beforeWake = async () => {
      if (world.bridge.tasks.length === 0) return
      if (step === 0) await world.bridge.accept(1)
      if (step === 1) await world.bridge.cannot(1, 'не нашёл, где считается цена')
      step += 1
    }
    await openCase(world.doctor)

    expect((await settledCase(world.doctor)).state).toBe('no_cause_found')
    expect(await world.doctor.handoffOf(1)).toMatchObject({ owner: 'doctor', reclaimReason: 'cannot', result: { kind: 'cannot' } })
    expect(world.bridge.cancels).toHaveLength(1)
    expect(world.model.requests.length).toBeGreaterThan(0)
  })

  it('мост пропал, пока агент работал: reclaimed, врач лечит сам', async () => {
    const world = await startWorld()
    noCause(world.model)
    let accepted = false
    world.clock.beforeWake = async () => {
      if (world.bridge.tasks.length === 0 || accepted) return
      accepted = true
      await world.bridge.accept(1)
      world.bridge.health = 'down'
    }
    await openCase(world.doctor)

    expect((await settledCase(world.doctor)).state).toBe('no_cause_found')
    const handoff = (await world.doctor.handoffOf(1))!
    expect(handoff).toMatchObject({ owner: 'doctor', reclaimReason: 'bridge_unreachable' })
    // Раньше срока работы агента: мост пропал — ждать его итога незачем.
    expect(Date.parse(handoff.reclaimedAt!) - Date.parse(handoff.sentAt!)).toBeLessThan(600_000)
  })

  it('агент сделал и выкатил: врач наблюдает его версию (observing), она держится — случай закрыт агентом', async () => {
    const app = createFakeDeployApp({ running: 'v1-working', previous: 'v0-old' })
    const world = await startWorld({ app })
    const states: CaseState[] = []
    let step = 0
    world.clock.beforeWake = async () => {
      const state = (await world.doctor.caseBook.getCase(1))?.state
      if (state && states.at(-1) !== state) states.push(state)
      if (world.bridge.tasks.length === 0) return
      if (step === 0) await world.bridge.accept(1)
      if (step === 1) {
        app.humanDeploys('agent-v2')
        await world.bridge.done(1, { commit: 'abc1234', version: 'agent-v2' })
      }
      step += 1
    }
    await openCase(world.doctor)

    expect((await settledCase(world.doctor)).state).toBe('healed_by_paseo')
    expect(states).toContain('observing')
    expect(world.model.requests).toHaveLength(0)
    expect(app.running).toBe('agent-v2')
    expect(app.rollbacks).toBe(0)
    expect(app.calls).toContain('confirm')
    expect(await reportTypes(world.doctor)).toEqual(expect.arrayContaining(['handed_off', 'paseo_done']))
  })

  it('итог агента после reclaimed — только lateResult: случай остаётся за врачом', async () => {
    const world = await startWorld()
    noCause(world.model)
    await openCase(world.doctor)
    expect((await settledCase(world.doctor)).state).toBe('no_cause_found')
    expect(await world.doctor.handoffOf(1)).toMatchObject({ owner: 'doctor', reclaimReason: 'accept_timeout' })

    expect((await world.bridge.accept(1)).status).toBe(409)
    const late = await world.bridge.done(1, { commit: 'abc1234' })
    expect(late.status).toBe(200)
    expect(late.body).toMatchObject({ ok: true, late: true })
    const handoff = (await world.doctor.handoffOf(1))!
    expect(handoff.owner).toBe('doctor')
    expect(handoff.result).toBeUndefined()
    expect(handoff.lateResult).toMatchObject({ kind: 'done', commit: 'abc1234', deployed: false })
    expect((await world.doctor.caseBook.getCase(1))!.state).toBe('no_cause_found')
  })

  it('чужая подпись на адресе для моста — отказ, итог не записан', async () => {
    const world = await startWorld()
    let accepted = false
    world.clock.beforeWake = async () => {
      if (world.bridge.tasks.length === 0 || accepted) return
      accepted = true
      expect((await world.bridge.done(1, {}, { secret: 'not-the-bridge-secret' })).status).toBe(401)
      await world.bridge.done(1, {})
    }
    await openCase(world.doctor)
    expect((await settledCase(world.doctor)).state).toBe('healed_by_paseo')
    expect(world.bridge.badSignatures).toBe(0)
  })
})
