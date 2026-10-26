import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createIncidentEvent } from '@ykurilov/remontnik-core/incident'
import { startFakeTelegram, type FakeTelegramServer } from '@ykurilov/remontnik-core/testing'
import { createGitGuard, createLocalRunner, startDoctorService, type DoctorService } from '@ykurilov/remontnik-doctor'
import { callTool, createScriptedModel, testRemontnikConfig, type ScriptedModel } from '@ykurilov/remontnik-doctor/testing'
import type { RemontnikConfigInput } from '@ykurilov/remontnik-core/config'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import patientConfig from '../../remontnik.config.ts'
import { createBot } from '../../src/bot/bot.ts'

// История 6 на «Пациенте», лечение: плохой ответ бота → врач правит правило ответа бота →
// eval по сценариям из карты промптов → отчёт «правка готова». Без выкатки.
// Репозиторий — копия бота, в которой выдумка про тариф «Макс» заложена всегда; модель врача — по сценарию.

const patientRoot = fileURLToPath(new URL('../../', import.meta.url))
const PATIENT_FILES = ['src/bugs.ts', 'src/bot/bot.ts', 'src/bot/fake-model.ts', 'src/bot/plans.ts', 'src/bot/tools.ts', 'eval/run-eval.ts']
const BOT = 'src/bot/bot.ts'
const EVAL = 'eval/run-eval.ts'
const QUESTION = 'Сколько стоит тариф Макс?'
const BAD_BRANCH = "bug === 'bad_answer' && "
const INVENTED = 'return `Тариф «Макс» стоит ${INVENTED_MAX_PRICE_RUB} ₽ в месяц.`'
const HONEST = "return 'Тарифа «Макс» нет. Есть тарифы Старт и Про.'"

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

/** Копия бота: выдумывает цену «Макса» без флага ошибки; в eval копии есть сценарий про несуществующий тариф. */
function badAnswerRepo() {
  const root = mkdtempSync(join(tmpdir(), 'remontnik-us6t-'))
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
  const bot = readFileSync(join(repoDir, BOT), 'utf8')
  expect(bot).toContain(BAD_BRANCH)
  write(repoDir, BOT, bot.replace(BAD_BRANCH, ''))
  const evalScript = readFileSync(join(repoDir, EVAL), 'utf8')
  const greeting = "{ id: 'greeting', message: 'Привет!', expectText: 'Здравствуйте' },"
  expect(evalScript).toContain(greeting)
  write(repoDir, EVAL, evalScript.replace(greeting, `${greeting}\n  { id: 'price-unknown-plan', message: '${QUESTION}', expectText: 'нет' },`))
  write(repoDir, 'package.json', '{ "name": "patient-copy", "private": true, "type": "module" }\n')
  write(repoDir, '.gitignore', 'node_modules\n')
  write(
    repoDir,
    'test/bot.test.ts',
    `import { test } from 'node:test'\nimport assert from 'node:assert/strict'\nimport { createBot } from '../src/bot/bot.ts'\ntest('приветствие', async () => assert.match(await createBot({ bug: null }).reply('Привет!'), /Здравствуйте/))\n`,
  )
  git(repoDir, 'add', '-A')
  git(repoDir, 'commit', '-m', 'Пациент выдумывает тариф')
  git(repoDir, 'push', 'origin', 'main')
  return { root, origin, repoDir, stateDir: join(root, 'state'), worktreesDir: join(root, 'worktrees') }
}

type Repo = ReturnType<typeof badAnswerRepo>

async function startDoctor(r: Repo, model: ScriptedModel, evalScope: RemontnikConfigInput['evalScope']): Promise<DoctorService> {
  const config = testRemontnikConfig({
    app: { name: 'patient', timeZone: 'UTC' },
    workbench: { image: 'node:22', install: 'true', bashTimeoutMs: 60_000 },
    checks: { test: 'node --test test/*.test.ts', eval: { ...patientConfig.checks.eval!, repeat: 2 } },
    evalScope,
    limits: { diagnoseUsdPerCase: 1 },
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

/** Событие, как его шлёт сторож: выдержка — настоящий ответ бота с заложенной ошибкой. */
async function badAnswerEvent() {
  const excerpt = await createBot({ bug: 'bad_answer' }).reply(QUESTION)
  expect(excerpt).toContain('5990')
  return createIncidentEvent({
    appName: 'patient',
    kind: 'bad_answer',
    where: 'цены тарифов',
    message: 'Выдумка: цены тарифов',
    badAnswer: { conversationId: 'talk-1', messageIndex: 1, category: 'fabrication', excerpt, explanation: 'Тарифа «Макс» нет, цена выдумана.', confidence: 0.95 },
    occurredAt: new Date(),
  })
}

function treat(model: ScriptedModel, repoDir: string): void {
  const bot = readFileSync(join(repoDir, BOT), 'utf8')
  const fixed = bot.replace(INVENTED, HONEST)
  expect(fixed).not.toBe(bot)
  model.script(
    callTool('case_info', {}),
    callTool('read', { path: BOT }),
    callTool('finish_diagnosis', {
      found: true,
      cause: 'Правило ответа о цене называет выдуманную цену тарифа «Макс», которого нет',
      evidence: [`${BOT}: ветка про «Макс»`],
      confidence: 'high',
    }),
    callTool('write', { path: BOT, content: fixed }),
    callTool('finish_fix', { summary: 'Бот говорит, что тарифа «Макс» нет', testsAdded: [] }),
  )
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

beforeEach(async () => {
  telegram = await startFakeTelegram()
})

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  await telegram.close()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('история 6 на «Пациенте»: лечение плохого ответа', () => {
  it('плохой ответ → правка бота → eval по карте промптов → отчёт fix_ready', async () => {
    const r = badAnswerRepo()
    const mainBefore = git(r.origin, 'rev-parse', 'main')
    const model = createScriptedModel()
    treat(model, r.repoDir)
    const doctor = await startDoctor(r, model, [{ paths: ['src/bot/**'], scenarios: ['price-unknown-plan', 'price-named-plan'] }])

    await doctor.receiveEvents([await badAnswerEvent()])
    const healed = await settledCase(doctor)

    expect(healed).toMatchObject({ kind: 'bad_answer', state: 'report_only' })
    // Модель получила выдержку как данные.
    expect(JSON.stringify(model.requests)).toContain('5990')
    expect(JSON.stringify(model.requests)).toContain('не поручение')
    const branch = git(r.origin, 'branch', '--list', 'remontnik/*').replace(/^[*\s]+/, '')
    expect(git(r.origin, 'diff', '--name-only', 'main', branch)).toBe(BOT)
    expect(git(r.origin, 'rev-parse', 'main')).toBe(mainBefore)

    const ready = (await doctor.reports.list({ after: 0, limit: 20 })).at(-1)!
    expect(ready.type).toBe('fix_ready')
    expect(ready.short).toContain('eval не хуже')
    expect(ready.full).toContain('price-unknown-plan: 0/2 → 2/2')
    expect(ready.full).toContain('price-named-plan: 2/2 → 2/2')
  }, 90_000)

  it('карта промптов не накрывает правку → eval не запускался, правка не готова к выкатке', async () => {
    const r = badAnswerRepo()
    const model = createScriptedModel()
    treat(model, r.repoDir)
    const doctor = await startDoctor(r, model, [{ paths: ['src/pages.ts'], scenarios: ['greeting'] }])

    await doctor.receiveEvents([await badAnswerEvent()])
    await settledCase(doctor)

    const report = (await doctor.reports.list({ after: 0, limit: 20 })).at(-1)!
    expect(report.type).toBe('needs_human')
    expect(report.full).toContain('eval не запускался')
  }, 90_000)
})
