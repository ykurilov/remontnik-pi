import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createIncidentEvent } from '@ykurilov/remontnik-core/incident'
import { startFakeTelegram, type FakeTelegramServer } from '@ykurilov/remontnik-core/testing'
import { createGitGuard, createLocalRunner, startDoctorService, type DoctorService } from '@ykurilov/remontnik-doctor'
import { callTool, createScriptedModel, testRemontnikConfig, type ScriptedModel, type ScriptStep } from '@ykurilov/remontnik-doctor/testing'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import patientConfig from '../../remontnik.config.ts'

// История 2 на «Пациенте»: сбой → врач находит причину, правит в ветке, проверяет и сообщает. Ничего не выкатывает.
// Репозиторий — копия кода бота «Пациента» с заложенной ошибкой; модель — по сценарию, без сети и денег.

const patientRoot = fileURLToPath(new URL('../../', import.meta.url))
const PATIENT_FILES = ['src/bugs.ts', 'src/bot/bot.ts', 'src/bot/fake-model.ts', 'src/bot/plans.ts', 'src/bot/tools.ts', 'eval/run-eval.ts']
const PLANS = 'src/bot/plans.ts'
const BOT = 'src/bot/bot.ts'
const NEW_TEST = 'test/default-plan.test.ts'

// Тесты копии цены не проверяют: что правка сломала ответ о цене, видит только eval.
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

/** Копия бота «Пациента» в своём репозитории; ошибка заложена в коде: тарифа по умолчанию `starter` нет. */
function sickPatientRepo() {
  const root = mkdtempSync(join(tmpdir(), 'remontnik-us2-'))
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
  return { root, origin, repoDir, stateDir: join(root, 'state'), worktreesDir: join(root, 'worktrees'), deployMarks: join(root, 'deploy-marks') }
}

type SickRepo = ReturnType<typeof sickPatientRepo>

async function startDoctor(r: SickRepo, model: ScriptedModel, limits: { diagnoseUsdPerCase?: number } = {}): Promise<DoctorService> {
  mkdirSync(r.deployMarks, { recursive: true })
  const deploy = (step: string) => `touch ${r.deployMarks}/${step}`
  const config = testRemontnikConfig({
    app: { name: 'patient', timeZone: 'UTC' },
    workbench: { image: 'node:22', install: 'true', bashTimeoutMs: 60_000 },
    checks: { test: 'node --test test/*.test.ts', eval: { ...patientConfig.checks.eval!, repeat: 2 } },
    // У копии нет страниц: сценарии цены — то, что ломает правка бота.
    evalScope: [{ paths: ['src/bot/**'], scenarios: ['price-named-plan', 'price-default-plan', 'greeting'] }],
    limits: { diagnoseUsdPerCase: 1, ...limits },
    deploy: {
      commands: {
        build: deploy('build'),
        promote: deploy('promote'),
        confirm: deploy('confirm'),
        rollback: deploy('rollback'),
        // Рабочая версия — коммит, с которого начат репозиторий.
        current: `${deploy('current')} && printf '{"version":"%s","previous":null}' ${git(r.repoDir, 'rev-parse', 'HEAD')}`,
        health: deploy('health'),
      },
      lockFile: '.remontnik/deploy.lock',
    },
  })
  const doctor = await startDoctorService({
    stateDir: r.stateDir,
    sharedSecret: 'shared-test-secret',
    listen: { host: '127.0.0.1', port: 0 },
    telegram: { botToken: '123456:test-bot-token', chatId: 'owner-chat', apiBaseUrl: telegram.baseUrl },
    exit: () => {},
    log: () => {},
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
      budgetPollMs: 10,
      runner: createLocalRunner(),
      allowUnisolatedRunner: true,
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
    if (found && ['report_only', 'no_cause_found', 'stand_broken'].includes(found.state)) return found
    if (Date.now() > deadline) throw new Error(`случай 1 не закончился: ${found?.state}`)
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

const diagnosis = (): ScriptStep[] => [
  callTool('case_info', {}),
  callTool('read', { path: BOT }),
  callTool('read', { path: PLANS }),
  callTool('finish_diagnosis', {
    found: true,
    cause: 'Тарифа по умолчанию starter нет в списке: вопрос о цене без названия тарифа падает',
    evidence: [`${PLANS}: DEFAULT_PLAN_ID = 'starter'`, `${BOT}: plan.name у undefined`],
    confidence: 'high',
  }),
]

function fixWith(path: string, content: string, summary: string): ScriptStep[] {
  return [
    callTool('write', { path, content }),
    callTool('write', { path: NEW_TEST, content: DEFAULT_PLAN_TEST }),
    callTool('bash', { command: 'node --test test/*.test.ts' }),
    callTool('finish_fix', { summary, testsAdded: [NEW_TEST] }),
  ]
}

async function reportTypes(doctor: DoctorService) {
  return (await doctor.reports.list({ after: 0, limit: 20 })).map((report) => report.type)
}

beforeEach(async () => {
  telegram = await startFakeTelegram()
})

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  await telegram.close()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('история 2 на «Пациенте»: лечение в ветке', () => {
  it('падение → ветка с правкой и тестом, проверки зелёные, отчёт; основная ветка и рабочая версия не тронуты', async () => {
    const r = sickPatientRepo()
    const mainBefore = git(r.origin, 'rev-parse', 'main')
    const plansBefore = readFileSync(join(r.repoDir, PLANS), 'utf8')
    const model = createScriptedModel()
    const fixed = plansBefore.replace("'starter'", "'start'")
    model.script(...diagnosis(), ...fixWith(PLANS, fixed, 'Тариф по умолчанию — start'))
    const doctor = await startDoctor(r, model)

    await doctor.receiveEvents([priceCrash()])
    const healed = await settledCase(doctor)

    expect(healed.state).toBe('report_only')
    const branch = git(r.origin, 'branch', '--list', 'remontnik/*').replace(/^[*\s]+/, '')
    expect(branch).toMatch(/^remontnik\/1-/)
    expect(git(r.origin, 'log', '--format=%an', '-1', branch)).toBe('Ремонтник')
    expect(git(r.origin, 'diff', '--name-only', 'main', branch).split('\n').sort()).toEqual([PLANS, NEW_TEST])
    expect(git(r.origin, 'show', `${branch}:${PLANS}`)).toContain("DEFAULT_PLAN_ID = 'start'")

    expect(git(r.origin, 'rev-parse', 'main')).toBe(mainBefore)
    expect(git(r.repoDir, 'rev-parse', 'HEAD')).toBe(mainBefore)
    expect(readFileSync(join(r.repoDir, PLANS), 'utf8')).toBe(plansBefore)
    // Врач только спросил рабочую версию: ни сборки, ни выкатки.
    expect(readdirSync(r.deployMarks)).toEqual(['current'])

    expect(await reportTypes(doctor)).toEqual(['case_received', 'fix_ready'])
    const ready = (await doctor.reports.list({ after: 0, limit: 20 })).at(-1)!
    expect(ready.short).toContain(branch)
    expect(ready.short).toContain('тесты зелёные')
    expect(ready.short).toContain('eval не хуже')
    expect(ready.short).toContain('не выкатывал')
    expect(ready.full).toContain('price-default-plan: 0/2 → 2/2')
    expect(ready.full).toContain('price-named-plan: 2/2 → 2/2')
    expect(ready.telegram.state).not.toBe('not_needed')
  }, 90_000)

  it('соблазнительная правка ломает сценарий с названным тарифом → не готова, нужен человек, отчёт называет eval хуже', async () => {
    const r = sickPatientRepo()
    const bot = readFileSync(join(r.repoDir, BOT), 'utf8')
    const pricesRemoved = bot.replace(
      'return `Тариф ${plan.name} стоит ${plan.priceRub} ₽ в месяц.`',
      "return plan ? 'Цены смотрите на сайте.' : 'Цены смотрите на сайте.'",
    )
    expect(pricesRemoved).not.toBe(bot)
    const model = createScriptedModel()
    model.script(...diagnosis(), ...fixWith(BOT, pricesRemoved, 'Бот больше не называет цены'))
    const doctor = await startDoctor(r, model)

    await doctor.receiveEvents([priceCrash()])
    await settledCase(doctor)

    const report = (await doctor.reports.list({ after: 0, limit: 20 })).at(-1)!
    expect(report.type).toBe('needs_human')
    expect(report.short).toContain('eval хуже: price-named-plan')
    expect(report.short).not.toContain('price-default-plan')
    expect(report.full).toContain('price-named-plan: 2/2 → 0/2')
    expect(existsSync(join(r.deployMarks, 'promote'))).toBe(false)
  }, 90_000)

  it('бюджет модели исчерпан → no_cause_found, ветки нет', async () => {
    const r = sickPatientRepo()
    const model = createScriptedModel({ costPerResponseUsd: 0.2 })
    model.script(...Array.from({ length: 30 }, () => callTool('read', { path: BOT })))
    const doctor = await startDoctor(r, model, { diagnoseUsdPerCase: 0.5 })

    await doctor.receiveEvents([priceCrash()])
    const sick = await settledCase(doctor)

    expect(sick.state).toBe('no_cause_found')
    expect(git(r.origin, 'branch', '--list', 'remontnik/*')).toBe('')
    const report = (await doctor.reports.list({ after: 0, limit: 20 })).at(-1)!
    expect(report.type).toBe('no_cause_found')
    expect(report.short).toContain('бюджет')
    expect(model.pending()).toBeGreaterThan(20)
  }, 90_000)
})
