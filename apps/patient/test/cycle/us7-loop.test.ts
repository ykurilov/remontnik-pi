import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createIncidentEvent, type IncidentEvent } from '@ykurilov/remontnik-core/incident'
import { startFakeTelegram, type FakeTelegramServer } from '@ykurilov/remontnik-core/testing'
import {
  admitAutoDeployIn,
  createGitGuard,
  createLocalRunner,
  nextDayStartMs,
  recordRollbackIn,
  startDoctorService,
  type CaseState,
  type DoctorService,
} from '@ykurilov/remontnik-doctor'
import { callTool, createScriptedModel, seedDoctorRecords, testRemontnikConfig, type ScriptedModel, type ScriptStep } from '@ykurilov/remontnik-doctor/testing'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import patientConfig from '../../remontnik.config.ts'

// История 7 на «Пациенте»: деньги и циклы под контролем.
// Деньги: дневной потолок модели кончился — случай записан и отложен, владелец получил сообщение, в новые сутки
// лечение продолжается с того же шага. Циклы: учёт выкаток по отпечатку (допуск в нём спрашивает выкатка) не пускает правку
// после отката и сверх дневного предела — она ждёт в отчёте. Сам цикл «выкатка → откат» — после этапа выкатки.

const patientRoot = fileURLToPath(new URL('../../', import.meta.url))
const PATIENT_FILES = ['src/bugs.ts', 'src/bot/bot.ts', 'src/bot/fake-model.ts', 'src/bot/plans.ts', 'src/bot/tools.ts', 'eval/run-eval.ts']
const PLANS = 'src/bot/plans.ts'
const DEPLOY_LIMITS = { autoDeploysPerFingerprintPerDay: 2, autoDeploysPerDay: 5 }
const BOT = 'src/bot/bot.ts'
const NEW_TEST = 'test/default-plan.test.ts'
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
const NOON = Date.UTC(2026, 10, 2, 12)
const TODAY = '2026-11-02'
const FINAL: CaseState[] = ['report_only', 'no_cause_found', 'stand_broken', 'needs_human']

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

/** Копия бота «Пациента» с заложенной ошибкой: тарифа по умолчанию `starter` нет. */
function sickPatientRepo() {
  const root = mkdtempSync(join(tmpdir(), 'remontnik-us7-'))
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
  write(repoDir, '.gitignore', 'node_modules\n')
  write(repoDir, 'test/bot.test.ts', BOT_TEST)
  git(repoDir, 'add', '-A')
  git(repoDir, 'commit', '-m', 'Пациент с ошибкой')
  git(repoDir, 'push', 'origin', 'main')
  return { root, origin, repoDir, stateDir: join(root, 'state'), worktreesDir: join(root, 'worktrees') }
}

type SickRepo = ReturnType<typeof sickPatientRepo>

/** Часы врача: с полудня 2 ноября по UTC; `toNextDay` — на начало следующих суток, позже запаса продолжения (минута). */
function doctorClock() {
  let shift = NOON - Date.now()
  const now = () => Date.now() + shift
  return {
    now,
    toNextDay() {
      shift += nextDayStartMs(now(), 'UTC') - now() + 2 * 60_000
    },
  }
}

async function startDoctor(r: SickRepo, model: ScriptedModel, now: () => number, limits: { doctorModelUsdPerDay?: number } = {}): Promise<DoctorService> {
  const config = testRemontnikConfig({
    app: { name: 'patient', timeZone: 'UTC' },
    workbench: { image: 'node:22', install: 'true', bashTimeoutMs: 60_000 },
    checks: { test: 'node --test test/*.test.ts', eval: { ...patientConfig.checks.eval!, repeat: 2 } },
    evalScope: [{ paths: ['src/bot/**'], scenarios: ['price-named-plan', 'price-default-plan', 'greeting'] }],
    limits: { diagnoseUsdPerCase: 5, ...limits },
  })
  const doctor = await startDoctorService({
    stateDir: r.stateDir,
    sharedSecret: 'shared-test-secret',
    listen: { host: '127.0.0.1', port: 0 },
    telegram: { botToken: '123456:test-bot-token', chatId: 'owner-chat', apiBaseUrl: telegram.baseUrl },
    exit: () => {},
    log: () => {},
    now,
    treatment: {
      guard: createGitGuard({
        repoDir: r.repoDir,
        worktreesDir: r.worktreesDir,
        mainBranch: 'main',
        mainline: 'pull-request',
        author: { name: 'Ремонтник', email: 'doctor@example.invalid' },
      }),
      loadConfig: async () => config,
      worktreesDir: r.worktreesDir,
      models: model.models,
      model: model.model,
      evalEnv: {},
      runner: createLocalRunner(),
      allowUnisolatedRunner: true,
    },
  })
  cleanups.push(() => doctor.close())
  return doctor
}

function priceCrash(): IncidentEvent {
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

async function caseIn(doctor: DoctorService, states: CaseState[], until: (reportTypes: string[]) => boolean = () => true) {
  const deadline = Date.now() + 60_000
  for (;;) {
    const found = await doctor.caseBook.getCase(1)
    const types = (await doctor.reports.list({ after: 0, limit: 50 })).map((report) => report.type)
    if (found && states.includes(found.state) && until(types)) return found
    if (Date.now() > deadline) throw new Error(`случай 1 не дошёл до ${states.join('/')}: ${found?.state}`)
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

const treatment = (): ScriptStep[] => [
  callTool('case_info', {}),
  callTool('read', { path: BOT }),
  callTool('read', { path: PLANS }),
  callTool('finish_diagnosis', {
    found: true,
    cause: 'Тарифа по умолчанию starter нет в списке: вопрос о цене без названия тарифа падает',
    evidence: [`${PLANS}: DEFAULT_PLAN_ID = 'starter'`, `${BOT}: plan.name у undefined`],
    confidence: 'high',
  }),
  callTool('write', { path: PLANS, content: '' }),
  callTool('write', { path: NEW_TEST, content: DEFAULT_PLAN_TEST }),
  callTool('bash', { command: 'node --test test/*.test.ts' }),
  callTool('finish_fix', { summary: 'Тариф по умолчанию — start', testsAdded: [NEW_TEST] }),
]

/** Сценарий лечения с настоящей правкой файла тарифов. */
function healingScript(r: SickRepo): ScriptStep[] {
  const fixed = readFileSync(join(r.repoDir, PLANS), 'utf8').replace("DEFAULT_PLAN_ID = 'starter'", "DEFAULT_PLAN_ID = 'start'")
  return treatment().map((step, index) => (index === 4 ? callTool('write', { path: PLANS, content: fixed }) : step))
}

beforeEach(async () => {
  telegram = await startFakeTelegram()
})

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  await telegram.close()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('история 7 на «Пациенте»: деньги', () => {
  it('потолок дня уже достигнут → новый случай записан и отложен, владелец получил сообщение, модель не звалась', async () => {
    const r = sickPatientRepo()
    await seedDoctorRecords(r.stateDir, async (tx) => {
      ;(await tx.doc('spend', TODAY, { model: {} as Record<string, number>, eval: {} })).model['99'] = 1
    })
    const model = createScriptedModel({ costPerResponseUsd: 0.2 })
    model.script(...healingScript(r))
    const doctor = await startDoctor(r, model, doctorClock().now, { doctorModelUsdPerDay: 1 })

    await doctor.receiveEvents([priceCrash()])
    const deferred = await caseIn(doctor, ['deferred_budget'], (types) => types.includes('budget_reached'))

    expect(deferred.state).toBe('deferred_budget')
    expect(model.requests).toHaveLength(0)
    const deadline = Date.now() + 10_000
    while (!telegram.messages.some((message) => message.text.includes('дневной бюджет модели'))) {
      if (Date.now() > deadline) throw new Error(`владелец не получил сообщение: ${telegram.messages.map((message) => message.text).join(' | ')}`)
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    expect(git(r.origin, 'branch', '--list', 'remontnik/*')).toBe('')
  }, 90_000)

  it('потолок кончился посреди лечения → отложено; в новые сутки лечение продолжается и правка готова', async () => {
    const r = sickPatientRepo()
    const clock = doctorClock()
    const model = createScriptedModel({ costPerResponseUsd: 0.18 })
    model.script(...healingScript(r))

    // Потолок 1 → работа до 0.9: пять броней по 0.18 — диагноз и начало правки; на шестую денег нет.
    const today = await startDoctor(r, model, clock.now, { doctorModelUsdPerDay: 1 })
    await today.receiveEvents([priceCrash()])
    await caseIn(today, ['deferred_budget'], (types) => types.includes('budget_reached'))
    expect(model.requests).toHaveLength(5)
    await cleanups.pop()!()

    clock.toNextDay()
    const tomorrow = await startDoctor(r, model, clock.now, { doctorModelUsdPerDay: 1 })
    const healed = await caseIn(tomorrow, FINAL)

    expect(healed.state).toBe('report_only')
    expect(model.pending()).toBe(0)
    const types = (await tomorrow.reports.list({ after: 0, limit: 20 })).map((report) => report.type)
    expect(types).toEqual(['case_received', 'budget_reached', 'fix_ready'])
    const branch = git(r.origin, 'branch', '--list', 'remontnik/*').replace(/^[*\s]+/, '')
    expect(git(r.origin, 'show', `${branch}:${PLANS}`)).toContain("DEFAULT_PLAN_ID = 'start'")
  }, 120_000)
})

describe('история 7 на «Пациенте»: циклы (учёт выкаток)', () => {
  async function healWithLedger(seed: Parameters<typeof seedDoctorRecords>[1]) {
    const r = sickPatientRepo()
    await seedDoctorRecords(r.stateDir, seed)
    const model = createScriptedModel()
    model.script(...healingScript(r))
    const doctor = await startDoctor(r, model, doctorClock().now)
    await doctor.receiveEvents([priceCrash()])
    await caseIn(doctor, FINAL)
    return (await doctor.reports.list({ after: 0, limit: 20 })).at(-1)!
  }

  it('правку по этому сбою уже откатывали → новая правка только отчётом, нужен человек', async () => {
    const fingerprint = priceCrash().fingerprint
    const report = await healWithLedger(async (tx) => {
      await admitAutoDeployIn(tx, { fingerprint, deploymentId: 1, at: NOON - 3_600_000, timeZone: 'UTC', limits: DEPLOY_LIMITS })
      await recordRollbackIn(tx, { fingerprint, deploymentId: 1, at: NOON - 3_000_000 })
    })

    expect(report.type).toBe('needs_human')
    expect(report.full).toContain('после отката эта причина ждёт человека')
  }, 90_000)

  it('за сутки уже 5 автовыкаток → зелёная правка ждёт в отчёте', async () => {
    const report = await healWithLedger(async (tx) => {
      for (let id = 1; id <= 5; id += 1) await admitAutoDeployIn(tx, { fingerprint: `other-${id}`, deploymentId: id, at: NOON - id * 600_000, timeZone: 'UTC', limits: DEPLOY_LIMITS })
    })

    expect(report.type).toBe('fix_ready')
    expect(report.full).toContain('лимит выкаток исчерпан')
  }, 90_000)
})
