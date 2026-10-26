import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createIncidentEvent } from '@ykurilov/remontnik-core/incident'
import { startFakeTelegram, type FakeTelegramServer } from '@ykurilov/remontnik-core/testing'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { CaseState } from '../case-book/index.js'
import { createGitGuard, type GitGuard } from '../git-guard/index.js'
import { startDoctorService, type DoctorService, type DoctorTreatmentOptions } from '../service/index.js'
import { testRemontnikConfig } from '../testing/config.js'
import { callTool, callTools, createScriptedModel, hang, type ScriptedModel, type ScriptStep } from '../testing/scripted-model.js'
import { createLocalRunner, type CommandRunner } from '../workbench/index.js'
import { DOCTOR_TOOL_NAMES } from './index.js'

// Лечение целиком на маленьком репозитории: модель по сценарию, локальный исполнитель, настоящий git.

const BUGGY = `const PLANS = { start: 990, pro: 2990 }
export const DEFAULT_PLAN = 'starter'
export function price(plan = DEFAULT_PLAN) {
  const value = PLANS[plan]
  if (value === undefined) throw new Error('нет тарифа ' + plan)
  return value
}
`
const FIXED = BUGGY.replace("'starter'", "'start'")
const NEW_TEST = `import { test } from 'node:test'
import assert from 'node:assert/strict'
import { price } from '../src/price.mjs'
test('цена тарифа по умолчанию', () => assert.equal(price(), 990))
`
const SECRET_TEXT = 'closed-secret-value'
// Похоже на ключ модели; собрано по частям, чтобы проверка публичности не приняла тест за утечку.
const LEAKED_KEY = ['sk', 'example0000000000000000'].join('-')
const FINAL_STATES: CaseState[] = ['report_only', 'no_cause_found', 'stand_broken', 'needs_human']

const dirs: string[] = []
const cleanups: (() => Promise<void>)[] = []
let telegram: FakeTelegramServer

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' } }).trim()
}

function writeFiles(root: string, files: Record<string, string>): void {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), content)
  }
}

function repo() {
  const root = mkdtempSync(join(tmpdir(), 'remontnik-treat-'))
  dirs.push(root)
  const origin = join(root, 'origin.git')
  const repoDir = join(root, 'main')
  git(root, 'init', '--bare', '--initial-branch=main', origin)
  git(root, 'clone', origin, repoDir)
  git(repoDir, 'config', 'user.email', 'owner@example.com')
  git(repoDir, 'config', 'user.name', 'Owner')
  writeFiles(repoDir, {
    '.gitignore': 'node_modules\n',
    'src/price.mjs': BUGGY,
    'test/price.test.mjs': `import { test } from 'node:test'\nimport assert from 'node:assert/strict'\nimport { price } from '../src/price.mjs'\ntest('тариф pro', () => assert.equal(price('pro'), 2990))\n`,
    'secret/keys.txt': `${SECRET_TEXT}\n`,
  })
  git(repoDir, 'add', '-A')
  git(repoDir, 'commit', '-m', 'начало')
  git(repoDir, 'push', 'origin', 'main')
  return { root, origin, repoDir, stateDir: join(root, 'state'), worktreesDir: join(root, 'worktrees') }
}

type Repo = ReturnType<typeof repo>

interface DoctorOptions {
  limits?: { diagnoseUsdPerCase?: number; modelUsdPerDay?: number }
  /** Команда `deploy.commands.current`; по умолчанию её скрипта нет, и рабочая версия неизвестна. */
  current?: string
  wrapGuard?: (guard: GitGuard) => GitGuard
  /** Подменить настройки лечения (исполнитель и т. п.). */
  treatment?: Partial<DoctorTreatmentOptions>
}

function doctorGuard(r: Repo): GitGuard {
  return createGitGuard({
    repoDir: r.repoDir,
    worktreesDir: r.worktreesDir,
    mainBranch: 'main',
    mainline: 'pull-request',
    author: { name: 'Ремонтник', email: 'doctor@example.invalid' },
  })
}

function doctorServiceOptions(r: Repo, model: ScriptedModel, options: DoctorOptions = {}) {
  const base = testRemontnikConfig()
  const config = testRemontnikConfig({
    workbench: { image: 'node:22', install: 'true', bashTimeoutMs: 30_000 },
    checks: { test: 'node --test test/*.test.mjs' },
    closedPaths: ['secret/**'],
    limits: { diagnoseUsdPerCase: 1, ...options.limits },
    deploy: { ...base.deploy, commands: { ...base.deploy.commands, ...(options.current ? { current: options.current } : {}) } },
  })
  const guard = doctorGuard(r)
  return {
    stateDir: r.stateDir,
    sharedSecret: 'shared-test-secret',
    listen: { host: '127.0.0.1', port: 0 },
    telegram: { botToken: '123456:test-bot-token', chatId: 'owner-chat', apiBaseUrl: telegram.baseUrl },
    exit: () => {},
    log: () => {},
    treatment: {
      guard: options.wrapGuard ? options.wrapGuard(guard) : guard,
      loadConfig: async () => config,
      worktreesDir: r.worktreesDir,
      models: model.models,
      model: model.model,
      budgetPollMs: 10,
      runner: createLocalRunner(),
      allowUnisolatedRunner: true,
      ...options.treatment,
    } as DoctorTreatmentOptions,
  }
}

async function startDoctor(r: Repo, model: ScriptedModel, options: DoctorOptions = {}): Promise<DoctorService> {
  const service = await startDoctorService(doctorServiceOptions(r, model, options))
  cleanups.push(() => service.close())
  return service
}

function priceCrash(message = 'нет тарифа starter') {
  return createIncidentEvent({
    appName: 'test-app',
    kind: 'crash',
    where: 'src/price.mjs:5:35',
    message,
    stack: 'Error: нет тарифа starter\n    at price (src/price.mjs:5:35)',
    context: { processName: 'web' },
    occurredAt: new Date(),
  })
}

async function settledCase(service: DoctorService, states: CaseState[] = FINAL_STATES, timeoutMs = 30_000, caseId = 1) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const found = await service.caseBook.getCase(caseId)
    if (found && states.includes(found.state)) return found
    if (Date.now() > deadline) throw new Error(`случай ${caseId} не дошёл до ${states.join('/')}: ${found?.state}`)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

const diagnosisSteps = (): ScriptStep[] => [
  callTool('case_info', {}),
  callTool('read', { path: 'secret/keys.txt' }),
  callTool('bash', { command: 'git log --oneline' }),
  callTool('read', { path: 'src/price.mjs' }),
  callTool('finish_diagnosis', {
    found: true,
    cause: 'Тариф по умолчанию starter не существует',
    evidence: ["src/price.mjs: DEFAULT_PLAN = 'starter'"],
    confidence: 'high',
  }),
]

const fixSteps = (): ScriptStep[] => [
  callTool('write', { path: 'src/price.mjs', content: FIXED }),
  callTool('write', { path: 'test/default-plan.test.mjs', content: NEW_TEST }),
  callTool('bash', { command: 'node --test test/*.test.mjs' }),
  callTool('finish_fix', { summary: 'Тариф по умолчанию — start', testsAdded: ['test/default-plan.test.mjs'] }),
]

function toolResults(model: ScriptedModel) {
  return (model.requests.at(-1)?.messages ?? []).filter((message) => message.role === 'toolResult')
}

beforeEach(async () => {
  telegram = await startFakeTelegram()
})

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  await telegram.close()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('лечение: задача remontnik.treatment', () => {
  it('сбой → ветка с правкой и тестом, проверки зелёные, отчёт; основная ветка не тронута', async () => {
    const r = repo()
    const mainBefore = git(r.origin, 'rev-parse', 'main')
    const model = createScriptedModel()
    model.script(...diagnosisSteps(), ...fixSteps())
    const doctor = await startDoctor(r, model)

    await doctor.receiveEvents([priceCrash()])
    const healed = await settledCase(doctor)

    expect(healed.state).toBe('report_only')
    expect(healed.treatmentTaskId).toBeDefined()
    const branches = git(r.origin, 'branch', '--list', 'remontnik/*').replace(/^[*\s]+/gm, '').split('\n')
    expect(branches).toHaveLength(1)
    const branch = branches[0]!
    expect(branch).toMatch(/^remontnik\/1-/)
    expect(git(r.origin, 'diff', '--name-only', 'main', branch).split('\n').sort()).toEqual(['src/price.mjs', 'test/default-plan.test.mjs'])
    expect(git(r.origin, 'rev-parse', 'main')).toBe(mainBefore)
    expect(git(r.repoDir, 'rev-parse', 'HEAD')).toBe(mainBefore)
    expect(readFileSync(join(r.repoDir, 'src/price.mjs'), 'utf8')).toBe(BUGGY)

    const reports = await doctor.reports.list({ after: 0, limit: 20 })
    const ready = reports.find((report) => report.type === 'fix_ready')
    expect(ready?.short).toContain(branch)
    expect(ready?.short).toContain('тесты зелёные')
    expect(reports.map((report) => report.type)).toEqual(['case_received', 'fix_ready'])

    // Промпт и набор инструментов одни и те же во всех запросах; сведения о сбое — только в сообщениях.
    // pi-durable передаёт промпт ведущим сообщением `system`; других сообщений `system` быть не должно.
    const prompts = new Set(model.requests.map((request) => JSON.stringify(request.messages.filter((message) => message.role === 'system'))))
    expect(prompts.size).toBe(1)
    for (const request of model.requests) expect(request.messages[0]?.role).toBe('system')
    const prompt = [...prompts][0]!
    expect(prompt).toContain('src/price.mjs')
    expect(prompt).not.toContain('secret/keys.txt')
    expect(prompt).not.toContain('нет тарифа starter')
    const leading = model.requests[0]!.messages[0]
    expect(leading?.role === 'system' && leading.toolsAdded?.map((tool) => tool.name)).toEqual([...DOCTOR_TOOL_NAMES])
    expect(model.requests.every((request) => request.messages.filter((message) => message.role === 'system').length === 1)).toBe(true)

    // Закрытый файл не прочитан, git не запущен.
    const results = toolResults(model)
    expect(JSON.stringify(model.requests)).not.toContain(SECRET_TEXT)
    expect(results.find((result) => result.role === 'toolResult' && result.toolName === 'read')?.isError).toBe(true)
    expect(results.find((result) => result.role === 'toolResult' && result.toolName === 'bash')?.isError).toBe(true)
  }, 60_000)

  it('причина не найдена → отчёт no_cause_found, ветки нет', async () => {
    const r = repo()
    const model = createScriptedModel()
    model.script(
      callTool('read', { path: 'src/price.mjs' }),
      callTool('finish_diagnosis', { found: false, cause: 'не понял, откуда starter', evidence: ['src/price.mjs прочитан', `в логе ключ ${LEAKED_KEY}`], confidence: 'low' }),
    )
    const doctor = await startDoctor(r, model)

    await doctor.receiveEvents([priceCrash()])
    const sick = await settledCase(doctor)

    expect(sick.state).toBe('no_cause_found')
    expect(git(r.origin, 'branch', '--list', 'remontnik/*')).toBe('')
    const reports = await doctor.reports.list({ after: 0, limit: 20 })
    expect(reports.at(-1)).toMatchObject({ type: 'no_cause_found', caseId: 1 })
    expect(reports.at(-1)?.full).toContain('src/price.mjs прочитан')
    expect(reports.at(-1)?.full).not.toContain(LEAKED_KEY)
  }, 60_000)

  it('инструменты одного хода модели идут по очереди: запись не успевает между проверкой пути и командой', async () => {
    const r = repo()
    const model = createScriptedModel()
    model.script(
      callTools(['bash', { command: 'sleep 0.5; test -e src/probe.txt && echo после-записи || echo до-записи' }], ['write', { path: 'src/probe.txt', content: 'x' }]),
      callTool('finish_diagnosis', { found: false, cause: 'проверка порядка', evidence: [], confidence: 'low' }),
    )
    const doctor = await startDoctor(r, model)

    await doctor.receiveEvents([priceCrash()])
    await settledCase(doctor)

    const bash = toolResults(model).find((result) => result.role === 'toolResult' && result.toolName === 'bash')
    expect(JSON.stringify(bash?.content)).toContain('до-записи')
  }, 60_000)

  it('потолок diagnoseUsdPerCase → работа модели остановлена, отчёт no_cause_found', async () => {
    const r = repo()
    const model = createScriptedModel({ costPerResponseUsd: 0.3 })
    model.script(...Array.from({ length: 40 }, () => callTool('bash', { command: 'true' })))
    const doctor = await startDoctor(r, model, { limits: { diagnoseUsdPerCase: 0.5 } })

    await doctor.receiveEvents([priceCrash()])
    const sick = await settledCase(doctor)

    expect(sick.state).toBe('no_cause_found')
    const report = (await doctor.reports.list({ after: 0, limit: 20 })).at(-1)
    expect(report?.type).toBe('no_cause_found')
    expect(report?.short).toContain('бюджет')
    expect(model.pending()).toBeGreaterThan(30)
  }, 60_000)

  it('перезапуск врача посреди правки: задача продолжает с чекпойнта, диагноз не повторяется', async () => {
    const r = repo()
    const first = createScriptedModel()
    first.script(...diagnosisSteps(), hang)
    const firstDoctor = await startDoctor(r, first)
    await firstDoctor.receiveEvents([priceCrash()])
    await settledCase(firstDoctor, ['fixing'])
    const deadline = Date.now() + 10_000
    while (first.pending() > 0) {
      if (Date.now() > deadline) throw new Error('модель не дошла до правки')
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    await cleanups.pop()!()

    const second = createScriptedModel()
    second.script(...fixSteps())
    const doctor = await startDoctor(r, second)
    const healed = await settledCase(doctor)

    expect(healed.state).toBe('report_only')
    expect(second.requests).toHaveLength(fixSteps().length)
    const userMessages = second.requests[0]!.messages.filter((message) => message.role === 'user')
    expect(userMessages).toHaveLength(2)
    expect((await doctor.reports.list({ after: 0, limit: 20 })).map((report) => report.type)).toEqual(['case_received', 'fix_ready'])
  }, 60_000)

  it('без исполнителя-контейнера врач не лечит: локальный — только явно, для тестов', async () => {
    const r = repo()
    const model = createScriptedModel()
    const noRunner = doctorServiceOptions(r, model)
    delete (noRunner.treatment as Partial<DoctorTreatmentOptions>).runner
    await expect(startDoctorService(noRunner)).rejects.toThrow(/контейнер/)
    const unisolated = doctorServiceOptions(r, model, { treatment: { allowUnisolatedRunner: false } })
    await expect(startDoctorService(unisolated)).rejects.toThrow(/контейнер/)
  })

  it('основа — рабочая версия из deploy current, а не свежий main; промпт говорит так же', async () => {
    const r = repo()
    const running = git(r.repoDir, 'rev-parse', 'HEAD')
    writeFiles(r.repoDir, { 'README.md': 'новее рабочей версии\n' })
    git(r.repoDir, 'add', '-A')
    git(r.repoDir, 'commit', '-m', 'после выкатки')
    git(r.repoDir, 'push', 'origin', 'main')
    const model = createScriptedModel()
    model.script(...diagnosisSteps(), ...fixSteps())
    const doctor = await startDoctor(r, model, { current: `printf '{"version":"${running}","previous":null}'` })

    await doctor.receiveEvents([priceCrash()])
    expect((await settledCase(doctor)).state).toBe('report_only')

    const branch = git(r.origin, 'branch', '--list', 'remontnik/*').replace(/^[*\s]+/gm, '')
    expect(git(r.origin, 'rev-parse', `${branch}~1`)).toBe(running)
    expect(JSON.stringify(model.requests[0]!.messages[0])).toContain('на коммите рабочей версии')
    expect((await doctor.reports.list({ after: 0, limit: 20 })).at(-1)?.full).not.toContain('рабочая версия неизвестна')
  }, 60_000)

  it('рабочая версия неизвестна → основа main, отчёт и промпт об этом говорят', async () => {
    const r = repo()
    const model = createScriptedModel()
    model.script(...diagnosisSteps(), ...fixSteps())
    const doctor = await startDoctor(r, model, { current: 'exit 3' })

    await doctor.receiveEvents([priceCrash()])
    await settledCase(doctor)

    expect(JSON.stringify(model.requests[0]!.messages[0])).toContain('какая версия работает, неизвестно')
    expect((await doctor.reports.list({ after: 0, limit: 20 })).at(-1)?.full).toContain('основа — main, рабочая версия неизвестна')
  }, 60_000)

  it('правка меняет существующий тест → не проверяется и не отправляется, нужен человек', async () => {
    const r = repo()
    const model = createScriptedModel()
    model.script(
      ...diagnosisSteps(),
      callTool('write', { path: 'src/price.mjs', content: FIXED }),
      callTool('write', { path: 'test/price.test.mjs', content: NEW_TEST }),
      callTool('finish_fix', { summary: 'Тариф по умолчанию — start', testsAdded: [] }),
    )
    const doctor = await startDoctor(r, model)

    await doctor.receiveEvents([priceCrash()])
    const sick = await settledCase(doctor)

    expect(sick.state).toBe('report_only')
    expect(git(r.origin, 'branch', '--list', 'remontnik/*')).toBe('')
    const report = (await doctor.reports.list({ after: 0, limit: 20 })).at(-1)
    expect(report?.type).toBe('needs_human')
    expect(report?.full).toContain('test/price.test.mjs')
  }, 60_000)

  it('модель подменила .git в копии → случай остановлен, отчёт о попытке выхода', async () => {
    const r = repo()
    const model = createScriptedModel()
    const dotGit = "'.'+'g'+'it'"
    model.script(
      ...diagnosisSteps(),
      callTool('write', { path: 'src/price.mjs', content: FIXED }),
      callTool('bash', { command: `node -e "const fs=require('fs'); fs.rmSync(${dotGit}); fs.writeFileSync(${dotGit}, 'gitdir: /nonexistent.invalid/x\\n')"` }),
      callTool('finish_fix', { summary: 'Тариф по умолчанию — start', testsAdded: [] }),
    )
    const doctor = await startDoctor(r, model)

    await doctor.receiveEvents([priceCrash()])
    const sick = await settledCase(doctor)

    expect(sick.state).toBe('needs_human')
    expect(git(r.origin, 'branch', '--list', 'remontnik/*')).toBe('')
    const report = (await doctor.reports.list({ after: 0, limit: 20 })).at(-1)
    expect(report?.type).toBe('needs_human')
    expect(report?.short).toContain('верстак')
  }, 60_000)

  it('команду модели не удалось убить → копия испорчена: коммита нет, случай остановлен, нужен человек', async () => {
    const r = repo()
    const local = createLocalRunner()
    const spoiled = new Set<string>()
    const runner: CommandRunner = {
      isolation: 'none',
      spoiled: (copyDir) => spoiled.has(copyDir),
      async run(command, options) {
        if (String(command).includes('zombie')) {
          spoiled.add(options.copyDir ?? options.cwd)
          return { exitCode: null, timedOut: true, aborted: false, output: '', stillRunning: true }
        }
        return local.run(command, options)
      },
    }
    let commits = 0
    const model = createScriptedModel()
    model.script(
      ...diagnosisSteps(),
      callTool('write', { path: 'src/price.mjs', content: FIXED }),
      callTool('bash', { command: 'zombie --forever' }),
      callTool('finish_fix', { summary: 'Тариф по умолчанию — start', testsAdded: [] }),
    )
    const doctor = await startDoctor(r, model, {
      treatment: { runner },
      wrapGuard: (guard) => ({ ...guard, commitAll: (...args) => ((commits += 1), guard.commitAll(...args)) }),
    })

    await doctor.receiveEvents([priceCrash()])
    const sick = await settledCase(doctor)

    expect(sick.state).toBe('needs_human')
    expect(commits).toBe(0)
    expect(git(r.origin, 'branch', '--list', 'remontnik/*')).toBe('')
    const report = (await doctor.reports.list({ after: 0, limit: 20 })).at(-1)
    expect(report?.type).toBe('needs_human')
    expect(report?.short).toContain('не остановлена')
  }, 60_000)

  it('коммит правки есть, а commitAll вернул пусто (сбой между коммитом и памятью) → правка не теряется', async () => {
    const r = repo()
    const model = createScriptedModel()
    model.script(...diagnosisSteps(), ...fixSteps())
    const doctor = await startDoctor(r, model, {
      wrapGuard: (guard) => ({
        ...guard,
        commitAll: async (cwd, message) => {
          await guard.commitAll(cwd, message)
          return undefined
        },
      }),
    })

    await doctor.receiveEvents([priceCrash()])
    await settledCase(doctor)

    expect((await doctor.reports.list({ after: 0, limit: 20 })).at(-1)?.type).toBe('fix_ready')
  }, 60_000)

  it('дневной бюджет модели общий для случаев и переживает перезапуск', async () => {
    const r = repo()
    const first = createScriptedModel({ costPerResponseUsd: 0.3 })
    first.script(...Array.from({ length: 40 }, () => callTool('bash', { command: 'true' })))
    const firstDoctor = await startDoctor(r, first, { limits: { diagnoseUsdPerCase: 5, modelUsdPerDay: 0.5 } })
    await firstDoctor.receiveEvents([priceCrash()])
    expect((await settledCase(firstDoctor)).state).toBe('no_cause_found')
    await cleanups.pop()!()

    const second = createScriptedModel({ costPerResponseUsd: 0.3 })
    second.script(...diagnosisSteps(), ...fixSteps())
    const doctor = await startDoctor(r, second, { limits: { diagnoseUsdPerCase: 5, modelUsdPerDay: 0.5 } })
    await doctor.receiveEvents([priceCrash('нет тарифа basic')])
    expect((await settledCase(doctor, FINAL_STATES, 30_000, 2)).state).toBe('no_cause_found')

    expect(second.requests).toHaveLength(0)
    const report = (await doctor.reports.list({ after: 0, limit: 20 })).at(-1)
    expect(report?.short).toContain('дневной бюджет')
  }, 60_000)
})
