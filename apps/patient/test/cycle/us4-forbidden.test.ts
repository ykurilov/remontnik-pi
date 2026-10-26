import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createIncidentEvent, type IncidentEvent } from '@ykurilov/remontnik-core/incident'
import { startFakeTelegram, type FakeTelegramServer } from '@ykurilov/remontnik-core/testing'
import { createGitGuard, createLocalRunner, startDoctorService, type DoctorService } from '@ykurilov/remontnik-doctor'
import { callTool, createScriptedModel, testRemontnikConfig, type ScriptedModel, type ScriptStep } from '@ykurilov/remontnik-doctor/testing'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import patientConfig from '../../remontnik.config.ts'

// История 4 на «Пациенте»: верная правка в «оплате», правка существующего теста и причина в Agent Chat SDK.
// Ни одной выкатки; на каждый случай — отчёт с объяснением. Модель — по сценарию, без сети и денег.

const patientRoot = fileURLToPath(new URL('../../', import.meta.url))
const PATIENT_FILES = ['src/bugs.ts', 'src/bot/bot.ts', 'src/bot/fake-model.ts', 'src/bot/plans.ts', 'src/bot/tools.ts', 'src/payments/charge.ts', 'eval/run-eval.ts']
const CHARGE = 'src/payments/charge.ts'
const BOT_TEST_PATH = 'test/bot.test.ts'
const CHARGE_BUG = "bug === 'payment_error' ? (undefined as unknown as { kopecks: number }).kopecks : plan.priceRub * 100"
const SDK_PACKAGE = '@ykurilov/agent-chat-core'

const BOT_TEST = `import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createBot } from '../src/bot/bot.ts'
test('приветствие', async () => assert.match(await createBot({ bug: null }).reply('Привет!'), /Здравствуйте/))
`
const CHARGE_TEST = `import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chargeForPlan } from '../src/payments/charge.ts'
test('списание за тариф pro', () => assert.equal(chargeForPlan('pro', null).amountRub, 2990))
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

/** Копия «Пациента» в своём репозитории; ошибка заложена в «оплате»: сумма берётся у тарифа, у которого её нет. */
function sickPatientRepo() {
  const root = mkdtempSync(join(tmpdir(), 'remontnik-us4-'))
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
  const charge = readFileSync(join(repoDir, CHARGE), 'utf8')
  expect(charge).toContain(CHARGE_BUG)
  write(repoDir, CHARGE, charge.replace(CHARGE_BUG, '(plan as unknown as { kopecks: number }).kopecks'))
  write(repoDir, 'package.json', '{ "name": "patient-copy", "private": true, "type": "module" }\n')
  write(repoDir, '.gitignore', 'node_modules\n')
  write(repoDir, BOT_TEST_PATH, BOT_TEST)
  git(repoDir, 'add', '-A')
  git(repoDir, 'commit', '-m', 'Пациент с ошибкой')
  git(repoDir, 'push', 'origin', 'main')
  return { root, origin, repoDir, stateDir: join(root, 'state'), worktreesDir: join(root, 'worktrees'), deployMarks: join(root, 'deploy-marks') }
}

type SickRepo = ReturnType<typeof sickPatientRepo>

async function startDoctor(r: SickRepo, model: ScriptedModel): Promise<DoctorService> {
  mkdirSync(r.deployMarks, { recursive: true })
  const deploy = (step: string) => `touch ${r.deployMarks}/${step}`
  const config = testRemontnikConfig({
    app: { name: 'patient', timeZone: 'UTC' },
    workbench: { image: 'node:22', install: 'true', bashTimeoutMs: 60_000 },
    checks: { test: 'node --test test/*.test.ts', eval: { ...patientConfig.checks.eval!, repeat: 1 } },
    evalScope: [{ paths: ['src/bot/**'], scenarios: ['greeting'] }],
    limits: { diagnoseUsdPerCase: 1 },
    deploy: {
      commands: {
        build: deploy('build'),
        promote: deploy('promote'),
        confirm: deploy('confirm'),
        rollback: deploy('rollback'),
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

function chargeCrash(): IncidentEvent {
  return createIncidentEvent({
    appName: 'patient',
    kind: 'crash',
    where: 'src/payments/charge.ts:15:80',
    message: "Cannot read properties of undefined (reading 'kopecks')",
    stack: "TypeError: Cannot read properties of undefined (reading 'kopecks')\n    at chargeForPlan (src/payments/charge.ts:15:80)",
    context: { processName: 'web' },
    occurredAt: new Date(),
  })
}

function sdkCrash(): IncidentEvent {
  return createIncidentEvent({
    appName: 'patient',
    kind: 'crash',
    where: `node_modules/${SDK_PACKAGE}/dist/turn.js:88:11`,
    message: 'turn state lost after stream abort',
    stack: `Error: turn state lost after stream abort\n    at finishTurn (node_modules/${SDK_PACKAGE}/dist/turn.js:88:11)\n    at Object.reply (src/bot/bot.ts:40:7)`,
    context: { processName: 'web' },
    occurredAt: new Date(),
  })
}

async function settledCase(doctor: DoctorService, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const found = await doctor.caseBook.getCase(1)
    if (found && ['report_only', 'no_cause_found', 'stand_broken', 'needs_human'].includes(found.state)) return found
    if (Date.now() > deadline) throw new Error(`случай 1 не закончился: ${found?.state}`)
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

const chargeDiagnosis = (): ScriptStep[] => [
  callTool('case_info', {}),
  callTool('read', { path: CHARGE }),
  callTool('finish_diagnosis', {
    found: true,
    cause: 'Сумма списания берётся из поля kopecks, которого у тарифа нет',
    evidence: [`${CHARGE}: (plan as unknown as { kopecks: number }).kopecks`],
    confidence: 'high',
  }),
]

async function lastReport(doctor: DoctorService) {
  return (await doctor.reports.list({ after: 0, limit: 20 })).at(-1)!
}

function remoteBranches(r: SickRepo): string {
  return git(r.origin, 'branch', '--list', 'remontnik/*').replace(/^[*\s]+/gm, '')
}

beforeEach(async () => {
  telegram = await startFakeTelegram()
})

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  await telegram.close()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('история 4 на «Пациенте»: запретные зоны', () => {
  it('money: верная правка в «оплате» проверена и зелёная, но не выкачена — нужен человек', async () => {
    const r = sickPatientRepo()
    const fixed = readFileSync(join(r.repoDir, CHARGE), 'utf8').replace('(plan as unknown as { kopecks: number }).kopecks', 'plan.priceRub * 100')
    const model = createScriptedModel()
    model.script(
      ...chargeDiagnosis(),
      callTool('write', { path: CHARGE, content: fixed }),
      callTool('write', { path: 'test/charge.test.ts', content: CHARGE_TEST }),
      callTool('finish_fix', { summary: 'Сумма считается от цены тарифа', testsAdded: ['test/charge.test.ts'] }),
    )
    const doctor = await startDoctor(r, model)

    await doctor.receiveEvents([chargeCrash()])
    const sick = await settledCase(doctor)

    expect(sick.state).toBe('report_only')
    // Правка проверена и отправлена человеку на просмотр, но не выкачена.
    const branch = remoteBranches(r)
    expect(branch).toMatch(/^remontnik\/1-/)
    expect(git(r.origin, 'diff', '--name-only', 'main', branch).split('\n').sort()).toEqual([CHARGE, 'test/charge.test.ts'])
    expect(readdirSync(r.deployMarks)).toEqual(['current'])

    const report = await lastReport(doctor)
    expect(report.type).toBe('needs_human')
    expect(report.short).toContain('не выкачена')
    expect(report.short).toContain('запретная зона')
    expect(report.short).toContain('Нужен человек')
    expect(report.full).toContain('money')
    expect(report.full).toContain(CHARGE)
    expect(report.full).toContain('Тесты: green')
  }, 90_000)

  it('test-edit: правка меняет существующий тест — не проверена, не отправлена, не выкачена', async () => {
    const r = sickPatientRepo()
    const fixed = readFileSync(join(r.repoDir, CHARGE), 'utf8').replace('(plan as unknown as { kopecks: number }).kopecks', 'plan.priceRub * 100')
    const model = createScriptedModel()
    model.script(
      ...chargeDiagnosis(),
      callTool('write', { path: CHARGE, content: fixed }),
      callTool('write', { path: BOT_TEST_PATH, content: BOT_TEST.replace('/Здравствуйте/', '/./') }),
      callTool('finish_fix', { summary: 'Сумма считается от цены тарифа; тест приветствия ослаблен', testsAdded: [] }),
    )
    const doctor = await startDoctor(r, model)

    await doctor.receiveEvents([chargeCrash()])
    const sick = await settledCase(doctor)

    expect(sick.state).toBe('report_only')
    expect(remoteBranches(r)).toBe('')
    expect(readdirSync(r.deployMarks)).toEqual(['current'])
    const report = await lastReport(doctor)
    expect(report.type).toBe('needs_human')
    expect(report.short).toContain('не проверял и не отправлял')
    expect(report.short).toContain('изменён существующий тест')
    expect(report.full).toContain(BOT_TEST_PATH)
  }, 90_000)

  it('причина в SDK: врач SDK не правит и правку не просит — отчёт с готовой задачей для агента SDK', async () => {
    const r = sickPatientRepo()
    const model = createScriptedModel()
    const fixSteps = [callTool('write', { path: 'src/bot/bot.ts', content: '// не должно случиться\n' }), callTool('finish_fix', { summary: 'не должно случиться', testsAdded: [] })]
    model.script(
      callTool('case_info', {}),
      callTool('finish_diagnosis', {
        found: true,
        cause: 'SDK теряет состояние хода, когда поток ответа обрывается',
        evidence: [`node_modules/${SDK_PACKAGE}/dist/turn.js:88 — состояние хода сбрасывается до записи`],
        confidence: 'medium',
        fixPlan: 'Сохранять состояние хода до завершения потока',
        causeInPackage: SDK_PACKAGE,
      }),
      ...fixSteps,
    )
    const doctor = await startDoctor(r, model)

    await doctor.receiveEvents([sdkCrash()])
    const sick = await settledCase(doctor)

    expect(sick.state).toBe('report_only')
    expect(model.pending()).toBe(fixSteps.length)
    expect(remoteBranches(r)).toBe('')
    expect(readdirSync(r.deployMarks)).toEqual(['current'])
    const report = await lastReport(doctor)
    expect(report.type).toBe('needs_human')
    expect(report.short).toContain('Agent Chat SDK')
    expect(report.short).toContain(SDK_PACKAGE)
    expect(report.full).toContain('Задача для агента Agent Chat SDK')
    expect(report.full).toContain(`finishTurn (node_modules/${SDK_PACKAGE}/dist/turn.js:88:11)`)
    expect(report.full).toContain('Сохранять состояние хода до завершения потока')
  }, 90_000)

  it('причина в SDK по стеку: модель пакет не назвала и правит приложение — правка не выкачена, в отчёте задача для агента SDK', async () => {
    const r = sickPatientRepo()
    const tools = readFileSync(join(r.repoDir, 'src/bot/tools.ts'), 'utf8')
    const model = createScriptedModel()
    model.script(
      callTool('case_info', {}),
      callTool('finish_diagnosis', {
        found: true,
        cause: 'Ход теряется, когда поток ответа обрывается',
        evidence: ['src/bot/bot.ts:40 — ответ отдаётся в поток без проверки обрыва'],
        confidence: 'low',
      }),
      callTool('write', { path: 'src/bot/tools.ts', content: `${tools}\n// Ремонтник: обход обрыва потока\n` }),
      callTool('finish_fix', { summary: 'Обход обрыва потока в коде бота', testsAdded: [] }),
    )
    const doctor = await startDoctor(r, model)

    await doctor.receiveEvents([sdkCrash()])
    const sick = await settledCase(doctor)

    expect(sick.state).toBe('report_only')
    expect(model.pending()).toBe(0)
    expect(readdirSync(r.deployMarks)).toEqual(['current'])
    const report = await lastReport(doctor)
    expect(report.type).toBe('needs_human')
    expect(report.short).toContain('не выкачена')
    expect(report.short).toContain('Agent Chat SDK')
    expect(report.full).toContain('agent_chat_sdk')
    expect(report.full).toContain('Задача для агента Agent Chat SDK')
    expect(report.full).toContain(SDK_PACKAGE)
    expect(report.full).toContain(`finishTurn (node_modules/${SDK_PACKAGE}/dist/turn.js:88:11)`)
  }, 90_000)
})
