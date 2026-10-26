import { execFileSync, spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createIncidentEvent } from '@ykurilov/remontnik-core/incident'
import { startFakeTelegram, type FakeTelegramServer } from '@ykurilov/remontnik-core/testing'
import {
  createGitGuard,
  createLocalRunner,
  createServerDeployer,
  startDoctorService,
  type Deployer,
  type Deployment,
  type DoctorService,
  type DoctorServiceOptions,
} from '@ykurilov/remontnik-doctor'
import { callTool, createScriptedModel, startFakePaseoBridge, testRemontnikConfig, type FakePaseoBridge, type ScriptedModel, type ScriptStep } from '@ykurilov/remontnik-doctor/testing'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

// История 11 на «Пациенте»: режим «сначала Paseo». Врач отдаёт случай агенту приложения через подставной мост и сам
// не лечит, пока агент работает. Агент выкатывает по правилам приложения — общий замок и команды выкатки «Пациента»
// на папках, — а врач наблюдает его выкатку и откатывает, если стало хуже. Мост выключен — врач лечит сам. Агент
// замолчал — врач забирает случай (`reclaimed`), правит один; поздняя выкатка агента — под наблюдение того же случая.
// Часы врача перескакивают на время пробуждения спящей задачи: сроки агента и окно наблюдения проходят за секунды.

const patientRoot = fileURLToPath(new URL('../../', import.meta.url))
const PATIENT_FILES = ['src/bugs.ts', 'src/bot/bot.ts', 'src/bot/fake-model.ts', 'src/bot/plans.ts', 'src/bot/tools.ts', 'deploy/remontnik-deploy.ts']
const PLANS = 'src/bot/plans.ts'
const BOT = 'src/bot/bot.ts'
const NEW_TEST = 'test/default-plan.test.ts'
const DEPLOY_SCRIPT = 'deploy/remontnik-deploy.ts'
const LOCK_FILE = '.remontnik/deploy.lock'
const SHARED_SECRET = 'shared-test-secret'
const CONTROL_SECRET = 'owner-test-secret'
const BRIDGE_SECRET = 'bridge-test-secret'
const ACCEPT_MINUTES = 5

const BOT_TEST = `import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createBot } from '../src/bot/bot.ts'
test('приветствие', async () => assert.match(await createBot({ bug: null }).reply('Привет!'), /Здравствуйте/))
`
const DEFAULT_PLAN_TEST = `import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createBot } from '../src/bot/bot.ts'
test('вопрос о цене без тарифа не падает', async () => assert.match(await createBot({ bug: null }).reply('Сколько стоит подписка?'), /₽|сайте/))
`

type Wake = Parameters<NonNullable<DoctorServiceOptions['onWake']>>[0]

const dirs: string[] = []
const cleanups: (() => Promise<void>)[] = []
let telegram: FakeTelegramServer

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' } }).trim()
}

function write(root: string, path: string, content: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true })
  writeFileSync(join(root, path), content)
}

/** Команда выкатки «Пациента», как её запускает владелец (или агент) на сервере. */
function deployCommand(r: SickPatient, command: string, cwd: string, env: Record<string, string> = {}): void {
  const result = spawnSync(process.execPath, [join(cwd, DEPLOY_SCRIPT), command], {
    cwd,
    env: { ...process.env, PATIENT_DEPLOY_ROOT: r.deployRoot, ...env },
    encoding: 'utf8',
  })
  if (result.status !== 0) throw new Error(`${command}: ${result.stdout}${result.stderr}`)
}

/** Копия бота «Пациента» в своём репозитории; ошибка заложена: тарифа по умолчанию `starter` нет. Она уже выкачена. */
function sickPatient() {
  const root = mkdtempSync(join(tmpdir(), 'remontnik-us11-'))
  dirs.push(root)
  const origin = join(root, 'origin.git')
  const repoDir = join(root, 'main')
  git(root, 'init', '--bare', '--initial-branch=main', origin)
  git(root, 'clone', origin, repoDir)
  git(repoDir, 'config', 'user.email', 'owner@example.com')
  git(repoDir, 'config', 'user.name', 'Owner')
  for (const file of PATIENT_FILES) {
    mkdirSync(dirname(join(repoDir, file)), { recursive: true })
    copyFileSync(join(patientRoot, file), join(repoDir, file))
  }
  const plans = readFileSync(join(repoDir, PLANS), 'utf8')
  expect(plans).toContain("DEFAULT_PLAN_ID = 'start'")
  write(repoDir, PLANS, plans.replace("DEFAULT_PLAN_ID = 'start'", "DEFAULT_PLAN_ID = 'starter'"))
  write(repoDir, 'package.json', '{ "name": "patient-copy", "private": true, "type": "module" }\n')
  // Замок выкатки лежит в рабочей копии сервера: git его не видит.
  write(repoDir, '.gitignore', 'node_modules\n.remontnik/\n')
  write(repoDir, 'test/bot.test.ts', BOT_TEST)
  git(repoDir, 'add', '-A')
  git(repoDir, 'commit', '-m', 'Пациент с ошибкой')
  git(repoDir, 'push', 'origin', 'main')
  const base = git(repoDir, 'rev-parse', 'HEAD')
  const r = { root, origin, repoDir, base, deployRoot: join(root, 'server'), stateDir: join(root, 'state'), worktreesDir: join(root, 'worktrees') }
  deployCommand(r, 'build', repoDir, { REMONTNIK_VERSION: base })
  deployCommand(r, 'promote', repoDir)
  deployCommand(r, 'confirm', repoDir)
  return r
}

type SickPatient = ReturnType<typeof sickPatient>

/** Какая версия работает на «сервере» и какая прежняя. */
function server(r: SickPatient) {
  const link = (name: string) => {
    try {
      return basename(readlinkSync(join(r.deployRoot, name)))
    } catch {
      return null
    }
  }
  return { current: link('current'), previous: link('previous') }
}

/** Правка агента Paseo в его собственной копии: коммит в ветку `paseo/fix` на origin. */
function agentFix(r: SickPatient, change: (plans: string) => string): { dir: string; version: string } {
  const dir = join(r.root, 'agent')
  git(r.root, 'clone', r.origin, dir)
  git(dir, 'config', 'user.email', 'agent@example.invalid')
  git(dir, 'config', 'user.name', 'Paseo agent')
  write(dir, PLANS, change(readFileSync(join(dir, PLANS), 'utf8')))
  git(dir, 'commit', '-am', 'Агент: тариф по умолчанию')
  git(dir, 'push', 'origin', 'HEAD:refs/heads/paseo/fix')
  return { dir, version: git(dir, 'rev-parse', 'HEAD') }
}

/**
 * Выкатка агента по правилам приложения: сначала общий замок выкатки (файл появляется, только если его нет),
 * затем `build` и `promote`; `confirm` — после окна наблюдения, его делает врач. Замок занят — выкатки нет.
 */
function agentDeploys(r: SickPatient, fix: { dir: string; version: string }): boolean {
  const lock = join(r.repoDir, LOCK_FILE)
  mkdirSync(dirname(lock), { recursive: true })
  try {
    writeFileSync(lock, `paseo agent ${fix.version}\n`, { flag: 'wx' })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false
    throw error
  }
  try {
    deployCommand(r, 'build', fix.dir, { REMONTNIK_VERSION: fix.version })
    deployCommand(r, 'promote', fix.dir)
  } finally {
    rmSync(lock)
  }
  return true
}

/** Часы врача: идут как настоящие, а когда задача засыпает, перескакивают на время её пробуждения. */
function fakeClock() {
  let offset = 0
  const clock = {
    now: () => Date.now() + offset,
    /** Перед каждым пробуждением: здесь агент и «Пациент» что-то делают между проверками врача. */
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

async function startDoctor(r: SickPatient, model: ScriptedModel, clock: Clock, bridge: FakePaseoBridge, deployments: Deployment[]): Promise<DoctorService> {
  const base = testRemontnikConfig()
  const config = testRemontnikConfig({
    app: { name: 'patient', timeZone: 'UTC' },
    repo: { mainBranch: 'main', mainline: 'merge' },
    workbench: { image: 'node:22', install: 'true', bashTimeoutMs: 60_000 },
    checks: { test: 'node --test test/*.test.ts' },
    evalScope: [],
    limits: { ...base.limits, diagnoseUsdPerCase: 1 },
    observe: { ...base.observe, windowMinutes: 2, healthWindowTicks: 3 },
    deploy: {
      commands: {
        build: `node ${DEPLOY_SCRIPT} build`,
        promote: `node ${DEPLOY_SCRIPT} promote`,
        confirm: `node ${DEPLOY_SCRIPT} confirm`,
        rollback: `node ${DEPLOY_SCRIPT} rollback`,
        current: `node ${DEPLOY_SCRIPT} current`,
        health: `node ${DEPLOY_SCRIPT} health`,
      },
      buildEnv: ['PATIENT_DEPLOY_ROOT'],
      lockFile: LOCK_FILE,
    },
    handoff: {
      mode: 'paseo-first',
      paseo: {
        bridgeUrlEnv: 'TEST_BRIDGE_URL',
        bridgeSecretEnv: 'TEST_BRIDGE_SECRET',
        listenEnv: 'TEST_BRIDGE_LISTEN',
        acceptTimeoutMs: ACCEPT_MINUTES * 60_000,
        workTimeoutMs: 60 * 60_000,
      },
    },
  })
  const guard = createGitGuard({ repoDir: r.repoDir, worktreesDir: r.worktreesDir, mainBranch: 'main', mainline: 'merge', author: { name: 'Ремонтник', email: 'doctor@example.invalid' } })
  const loadConfig = async () => config
  const serverDeployer = createServerDeployer({ guard, loadConfig, env: { ...process.env, PATIENT_DEPLOY_ROOT: r.deployRoot } })
  const deployer: Deployer = {
    async step(request, io) {
      const step = await serverDeployer.step(request, io)
      deployments.push(step.deployment)
      return step
    },
  }
  const doctor = await startDoctorService({
    stateDir: r.stateDir,
    sharedSecret: SHARED_SECRET,
    listen: { host: '127.0.0.1', port: 0 },
    controlSecret: CONTROL_SECRET,
    telegram: { botToken: '123456:test-bot-token', chatId: 'owner-chat', apiBaseUrl: telegram.baseUrl },
    reportsFeed: { bridge: { listen: { host: '127.0.0.1', port: 0 }, secret: BRIDGE_SECRET, appName: 'patient' } },
    paseoBridge: { url: bridge.url },
    exit: () => {},
    log: () => {},
    now: clock.now,
    onWake: (wake, resume) => clock.onWake(wake, resume),
    treatment: {
      guard,
      loadConfig,
      worktreesDir: r.worktreesDir,
      models: model.models,
      model: model.model,
      evalEnv: {},
      runner: createLocalRunner(),
      allowUnisolatedRunner: true,
      deployer,
    },
  })
  cleanups.push(() => doctor.close())
  bridge.connect(doctor.bridgeUrl!)
  return doctor
}

async function startBridge(): Promise<FakePaseoBridge> {
  const bridge = await startFakePaseoBridge({ secret: BRIDGE_SECRET, appName: 'patient' })
  cleanups.push(() => bridge.close())
  return bridge
}

/** Сбой «Пациента»; время — по часам врача: по нему врач считает ошибки окна наблюдения. */
function priceCrash(at = new Date()) {
  return createIncidentEvent({
    appName: 'patient',
    kind: 'crash',
    where: 'src/bot/bot.ts:53:43',
    message: "Cannot read properties of undefined (reading 'name')",
    stack: "TypeError: Cannot read properties of undefined (reading 'name')\n    at Object.reply (src/bot/bot.ts:53:43)",
    context: { processName: 'web' },
    occurredAt: at,
  })
}

const SETTLED = ['healed', 'healed_by_paseo', 'rolled_back', 'not_helped', 'report_only', 'needs_human', 'no_cause_found', 'stand_broken']

async function caseIn(doctor: DoctorService, states: string[], caseId = 1, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const found = await doctor.caseBook.getCase(caseId)
    if (found && states.includes(found.state)) return found
    if (Date.now() > deadline) throw new Error(`случай ${caseId} не дошёл до ${states.join('|')}: ${found?.state}`)
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

function cure(r: SickPatient): ScriptStep[] {
  const fixed = readFileSync(join(r.repoDir, PLANS), 'utf8').replace("'starter'", "'start'")
  return [
    callTool('read', { path: BOT }),
    callTool('read', { path: PLANS }),
    callTool('finish_diagnosis', {
      found: true,
      cause: 'Тарифа по умолчанию starter нет в списке: вопрос о цене без названия тарифа падает',
      evidence: [`${PLANS}: DEFAULT_PLAN_ID = 'starter'`, `${BOT}: plan.name у undefined`],
      confidence: 'high',
    }),
    callTool('write', { path: PLANS, content: fixed }),
    callTool('write', { path: NEW_TEST, content: DEFAULT_PLAN_TEST }),
    callTool('finish_fix', { summary: 'Тариф по умолчанию — start', testsAdded: [NEW_TEST] }),
  ]
}

const reportTypes = async (doctor: DoctorService) => (await doctor.reports.list({ after: 0, limit: 50 })).map((report) => report.type)

beforeEach(async () => {
  telegram = await startFakeTelegram()
})

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  await telegram.close()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('история 11 на «Пациенте»: сначала Paseo', () => {
  it('агент взял случай и выкатил хуже → врач наблюдал его выкатку, откатил и сообщил агенту; сам не лечил', async () => {
    const r = sickPatient()
    const model = createScriptedModel()
    const clock = fakeClock()
    const bridge = await startBridge()
    const deployments: Deployment[] = []
    const doctor = await startDoctor(r, model, clock, bridge, deployments)
    // «Правка» агента не трогает причину: тариф по-прежнему `starter`.
    const fix = agentFix(r, (plans) => `${plans}\n// агент: проверил тарифы\n`)
    let crashesSent = false
    clock.beforeWake = async () => {
      const state = (await doctor.caseBook.getCase(1))?.state
      if (state === 'handed_off') expect((await bridge.accept(1)).status).toBe(200)
      if (state === 'paseo_working' && server(r).current === r.base) {
        expect(agentDeploys(r, fix)).toBe(true)
        expect((await bridge.done(1, { commit: fix.version, version: fix.version })).status).toBe(200)
      }
      // Выкатка агента работает — «Пациент» падает чаще прежнего.
      if (state === 'observing' && !crashesSent) {
        crashesSent = true
        await doctor.receiveEvents(Array.from({ length: 6 }, () => priceCrash(new Date(clock.now()))))
      }
    }

    await doctor.receiveEvents([priceCrash()])
    const sick = await caseIn(doctor, SETTLED)

    expect(sick.state).toBe('rolled_back')
    expect(server(r).current).toBe(r.base)
    expect(model.requests).toHaveLength(0)
    expect(bridge.tasks).toHaveLength(1)
    expect(bridge.tasks[0]).toMatchObject({ app: 'patient', caseId: 1, kind: 'crash' })
    expect(bridge.cancels).toHaveLength(0)
    const ended = deployments.at(-1)!
    expect(ended).toMatchObject({ caseId: 1, candidateVersion: fix.version, previousVersion: r.base, outcome: 'rolled_back', rollbackCause: 'error_rate' })
    // Основная ветка — не дело врача при чужой выкатке; правка агента осталась в его ветке.
    expect(git(r.origin, 'rev-parse', 'main')).toBe(r.base)
    expect(await reportTypes(doctor)).toEqual(['case_received', 'handed_off', 'paseo_done', 'rolled_back'])
    // Агент узнаёт об откате из ленты отчётов, которую читает мост.
    const feed = await bridge.reports()
    const rolledBack = feed.find((report) => report.type === 'rolled_back')!
    expect(rolledBack.caseId).toBe(1)
    expect(rolledBack.short).toContain('Откатил выкатку агента Paseo')
  }, 120_000)

  it('мост выключен → врач лечит сам, отчёты говорят «Paseo недоступен», задачи агенту нет', async () => {
    const r = sickPatient()
    const model = createScriptedModel()
    model.script(...cure(r))
    const bridge = await startBridge()
    bridge.health = 'down'
    const doctor = await startDoctor(r, model, fakeClock(), bridge, [])

    await doctor.receiveEvents([priceCrash()])
    const healed = await caseIn(doctor, SETTLED)

    expect(healed.state).toBe('healed')
    expect(bridge.tasks).toHaveLength(0)
    expect(await doctor.handoffOf(1)).toMatchObject({ owner: 'doctor', reclaimReason: 'bridge_unreachable' })
    const reports = await doctor.reports.list({ after: 0, limit: 50 })
    expect(reports.map((report) => report.type)).not.toContain('handed_off')
    expect(reports.at(-1)!.type).toBe('deployed')
    expect(reports.at(-1)!.full).toContain('Paseo недоступен')
  }, 120_000)

  it(`агент молчит ${ACCEPT_MINUTES} минут → врач забирает случай и лечит сам; поздние «взял» и итог агента ничего не правят`, async () => {
    const r = sickPatient()
    const model = createScriptedModel()
    model.script(...cure(r))
    const bridge = await startBridge()
    const doctor = await startDoctor(r, model, fakeClock(), bridge, [])

    await doctor.receiveEvents([priceCrash()])
    const healed = await caseIn(doctor, SETTLED)

    expect(healed.state).toBe('healed')
    expect(bridge.tasks).toHaveLength(1)
    expect(bridge.cancels).toEqual([{ taskId: bridge.tasks[0]!.taskId, reason: expect.stringContaining('не взял') }])
    expect(await reportTypes(doctor)).toEqual(['case_received', 'handed_off', 'reclaimed', 'deployed', 'deployed'])
    const doctorFix = server(r).current

    // Агент проснулся: случай уже не его.
    expect(await bridge.accept(1)).toEqual({ status: 409, body: { error: 'reclaimed' } })
    expect(await bridge.done(1, { commit: 'abc1234' })).toEqual({ status: 200, body: { ok: true, late: true } })
    const handoff = await doctor.handoffOf(1)
    expect(handoff).toMatchObject({ owner: 'doctor', reclaimReason: 'accept_timeout', lateResult: { kind: 'done', deployed: false } })
    expect(handoff?.result).toBeUndefined()
    expect(handoff?.acceptedAt).toBeUndefined()
    // Правка одна — врача: случай закрыт им, выкатка та же, новых отчётов нет.
    expect((await doctor.caseBook.getCase(1))?.state).toBe('healed')
    expect(server(r).current).toBe(doctorFix)
    expect(await reportTypes(doctor)).toEqual(['case_received', 'handed_off', 'reclaimed', 'deployed', 'deployed'])
  }, 120_000)

  it('поздняя выкатка агента ждёт общий замок выкатки врача → врач наблюдает её под тем же случаем', async () => {
    const r = sickPatient()
    const model = createScriptedModel()
    model.script(...cure(r))
    const clock = fakeClock()
    const bridge = await startBridge()
    const deployments: Deployment[] = []
    const doctor = await startDoctor(r, model, clock, bridge, deployments)
    const fix = agentFix(r, (plans) => plans.replace("DEFAULT_PLAN_ID = 'starter'", "DEFAULT_PLAN_ID = 'start'"))
    // Агент очнулся, когда врач уже выкатывает свою правку: замок занят, агент ждёт.
    let lockBusySeen = false
    clock.beforeWake = async () => {
      if (lockBusySeen || (await doctor.caseBook.getCase(1))?.state !== 'observing') return
      expect(existsSync(join(r.repoDir, LOCK_FILE))).toBe(true)
      expect(agentDeploys(r, fix)).toBe(false)
      lockBusySeen = true
    }

    await doctor.receiveEvents([priceCrash()])
    expect((await caseIn(doctor, SETTLED)).state).toBe('healed')
    expect(lockBusySeen).toBe(true)
    const doctorFix = server(r).current!

    // Врач закончил и снял замок — агент выкатывает и сообщает итог.
    expect(agentDeploys(r, fix)).toBe(true)
    expect(await bridge.done(1, { commit: fix.version, version: fix.version })).toEqual({ status: 200, body: { ok: true, late: true } })
    const adopted = await caseIn(doctor, ['healed_by_paseo', 'rolled_back', 'needs_human', 'not_helped'])

    expect(adopted.state).toBe('healed_by_paseo')
    expect(await doctor.caseBook.getCase(2)).toBeUndefined()
    expect(server(r)).toEqual({ current: fix.version, previous: doctorFix })
    expect(JSON.parse(readFileSync(join(r.deployRoot, 'state.json'), 'utf8'))).toMatchObject({ unconfirmed: false })
    expect(deployments.at(-1)).toMatchObject({ caseId: 1, candidateVersion: fix.version, previousVersion: doctorFix, outcome: 'holding' })
    expect((await doctor.handoffOf(1))?.adoptedAt).toBeDefined()
    expect(await reportTypes(doctor)).toEqual(['case_received', 'handed_off', 'reclaimed', 'deployed', 'deployed', 'paseo_done'])
  }, 120_000)
})
