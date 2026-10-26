import { execFileSync, spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createIncidentEvent } from '@ykurilov/remontnik-core/incident'
import { signRequest } from '@ykurilov/remontnik-core/signed-http'
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
import { callTool, createScriptedModel, testRemontnikConfig, type ScriptedModel, type ScriptStep } from '@ykurilov/remontnik-doctor/testing'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

// История 3 на «Пациенте»: сбой → правка → выкатка настоящими командами «Пациента» на папках (deploy/remontnik-deploy.ts)
// → окно наблюдения → правка держится и влита в main, или стало хуже и откат. Часы врача перескакивают на время
// пробуждения спящей задачи: окно наблюдения проходит за секунды. Модель — по сценарию, без сети и денег.

const patientRoot = fileURLToPath(new URL('../../', import.meta.url))
const PATIENT_FILES = ['src/bugs.ts', 'src/bot/bot.ts', 'src/bot/fake-model.ts', 'src/bot/plans.ts', 'src/bot/tools.ts', 'deploy/remontnik-deploy.ts']
const PLANS = 'src/bot/plans.ts'
const BOT = 'src/bot/bot.ts'
const NEW_TEST = 'test/default-plan.test.ts'
const DEPLOY_SCRIPT = 'deploy/remontnik-deploy.ts'
const SHARED_SECRET = 'shared-test-secret'

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

/** Команда выкатки «Пациента», как её запускает владелец на сервере. */
function deployCommand(r: SickPatient, command: string, cwd: string, env: Record<string, string> = {}): void {
  const result = spawnSync(process.execPath, [join(cwd, DEPLOY_SCRIPT), command], {
    cwd,
    env: { ...process.env, PATIENT_DEPLOY_ROOT: r.deployRoot, ...env },
    encoding: 'utf8',
  })
  if (result.status !== 0) throw new Error(`${command}: ${result.stdout}${result.stderr}`)
}

/**
 * Копия бота «Пациента» с его командами выкатки, в своём репозитории; ошибка заложена: тарифа по умолчанию `starter` нет.
 * Версия с ошибкой уже выкачена на «сервер» (папку выкаток).
 */
function sickPatient() {
  const root = mkdtempSync(join(tmpdir(), 'remontnik-us3-'))
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

/** Часы врача: идут как настоящие, а когда задача засыпает, перескакивают на время её пробуждения. */
function fakeClock() {
  let offset = 0
  const clock = {
    now: () => Date.now() + offset,
    /** Перед каждым пробуждением: здесь сценарий что-то делает с «Пациентом» между тиками наблюдения. */
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

async function startDoctor(r: SickPatient, model: ScriptedModel, clock: Clock, deployments: Deployment[]): Promise<DoctorService> {
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
      lockFile: '.remontnik/deploy.lock',
    },
  })
  const guard = createGitGuard({ repoDir: r.repoDir, worktreesDir: r.worktreesDir, mainBranch: 'main', mainline: 'merge', author: { name: 'Ремонтник', email: 'doctor@example.invalid' } })
  const loadConfig = async () => config
  const serverDeployer = createServerDeployer({ guard, loadConfig, env: { ...process.env, PATIENT_DEPLOY_ROOT: r.deployRoot } })
  // Записи выкатки — для проверки сроков по часам врача.
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
    telegram: { botToken: '123456:test-bot-token', chatId: 'owner-chat', apiBaseUrl: telegram.baseUrl },
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
      budgetPollMs: 10,
      runner: createLocalRunner(),
      allowUnisolatedRunner: true,
      deployer,
    },
  })
  cleanups.push(() => doctor.close())
  return doctor
}

function priceCrash() {
  return createIncidentEvent({
    appName: 'patient',
    kind: 'crash',
    where: 'src/bot/bot.ts:53:43',
    message: "Cannot read properties of undefined (reading 'name')",
    stack: "TypeError: Cannot read properties of undefined (reading 'name')\n    at Object.reply (src/bot/bot.ts:53:43)",
    context: { processName: 'web' },
    occurredAt: new Date(),
  })
}

async function settledCase(doctor: DoctorService, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const found = await doctor.caseBook.getCase(1)
    if (found && ['healed', 'rolled_back', 'not_helped', 'report_only', 'needs_human', 'no_cause_found', 'stand_broken'].includes(found.state)) return found
    if (Date.now() > deadline) throw new Error(`случай 1 не закончился: ${found?.state}`)
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

function fixBranch(r: SickPatient): string {
  return git(r.origin, 'branch', '--list', 'remontnik/*').replace(/^[*\s]+/, '')
}

async function lastReport(doctor: DoctorService) {
  return (await doctor.reports.list({ after: 0, limit: 20 })).at(-1)!
}

/** Как только правка заработала, «Пациент» падает чаще прежнего: шесть повторов того же сбоя. */
function worseAfterPromote(r: SickPatient, clock: Clock, doctor: () => DoctorService, alsoBefore: () => void = () => {}) {
  let sent = false
  clock.beforeWake = async () => {
    if (sent || server(r).current === r.base) return
    sent = true
    alsoBefore()
    await doctor().receiveEvents(Array.from({ length: 6 }, () => priceCrash()))
  }
}

beforeEach(async () => {
  telegram = await startFakeTelegram()
})

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  await telegram.close()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('история 3 на «Пациенте»: выкатка, наблюдение и откат', () => {
  it('crash → healed: метка прежней версии, прежняя сборка сохранена, правка работает и влита в main', async () => {
    const r = sickPatient()
    const model = createScriptedModel()
    model.script(...cure(r))
    const doctor = await startDoctor(r, model, fakeClock(), [])

    await doctor.receiveEvents([priceCrash()])
    const healed = await settledCase(doctor)

    expect(healed.state).toBe('healed')
    const fixCommit = git(r.origin, 'rev-parse', fixBranch(r))
    expect(server(r)).toEqual({ current: fixCommit, previous: r.base })
    expect(readFileSync(join(r.deployRoot, 'current', PLANS), 'utf8')).toContain("DEFAULT_PLAN_ID = 'start'")
    expect(JSON.parse(readFileSync(join(r.deployRoot, 'state.json'), 'utf8'))).toMatchObject({ unconfirmed: false })
    const tags = git(r.origin, 'tag', '--list', 'remontnik/pre-deploy/*').split('\n')
    expect(tags).toHaveLength(1)
    expect(git(r.origin, 'rev-parse', `${tags[0]}^{commit}`)).toBe(r.base)
    expect(git(r.origin, 'rev-parse', 'main')).toBe(fixCommit)
    const report = await lastReport(doctor)
    expect(report.type).toBe('deployed')
    expect(report.short).toContain('держится')
    expect(report.short).toContain('влил в основную ветку main')
  }, 120_000)

  it('worse → откат меньше чем за минуту по часам врача; main не тронута', async () => {
    const r = sickPatient()
    const model = createScriptedModel()
    model.script(...cure(r))
    const clock = fakeClock()
    const deployments: Deployment[] = []
    const doctor = await startDoctor(r, model, clock, deployments)
    worseAfterPromote(r, clock, () => doctor)

    await doctor.receiveEvents([priceCrash()])
    const sick = await settledCase(doctor)

    expect(sick.state).toBe('rolled_back')
    expect(server(r).current).toBe(r.base)
    const ended = deployments.at(-1)!
    expect(ended).toMatchObject({ outcome: 'rolled_back', rollbackCause: 'error_rate' })
    expect(Date.parse(ended.endedAt!) - Date.parse(ended.promotedAt!)).toBeLessThan(60_000)
    expect(git(r.origin, 'rev-parse', 'main')).toBe(r.base)
    const report = await lastReport(doctor)
    expect(report.type).toBe('rolled_back')
    expect(report.short).toContain('откатил')
  }, 120_000)

  it('no-git: удалённый репозиторий пропал до отката → откат из сохранённой сборки', async () => {
    const r = sickPatient()
    const model = createScriptedModel()
    model.script(...cure(r))
    const clock = fakeClock()
    const doctor = await startDoctor(r, model, clock, [])
    worseAfterPromote(r, clock, () => doctor, () => renameSync(r.origin, `${r.origin}.gone`))

    await doctor.receiveEvents([priceCrash()])
    const sick = await settledCase(doctor)

    expect(sick.state).toBe('rolled_back')
    expect(server(r).current).toBe(r.base)
    expect(readFileSync(join(r.deployRoot, 'current', PLANS), 'utf8')).toContain("DEFAULT_PLAN_ID = 'starter'")
    expect((await lastReport(doctor)).type).toBe('rolled_back')
  }, 120_000)

  it('stop: стоп-кран включён → правка готова, выкатки нет', async () => {
    const r = sickPatient()
    const model = createScriptedModel()
    model.script(...cure(r))
    const doctor = await startDoctor(r, model, fakeClock(), [])
    const body = JSON.stringify({ action: 'stop', by: 'telegram:owner' })
    const stopped = await fetch(`${doctor.url}/v1/control/deploys`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...signRequest({ method: 'POST', target: '/v1/control/deploys', body, secret: SHARED_SECRET }) },
      body,
    })
    expect(stopped.status).toBe(200)

    await doctor.receiveEvents([priceCrash()])
    const sick = await settledCase(doctor)

    expect(sick.state).toBe('report_only')
    expect(server(r)).toEqual({ current: r.base, previous: null })
    expect(git(r.origin, 'tag', '--list', 'remontnik/*')).toBe('')
    const report = await lastReport(doctor)
    expect(report.type).toBe('fix_ready')
    expect(report.short).toContain('стоп-кран')
    expect(report.short).toContain(fixBranch(r))
  }, 120_000)
})
