import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Wake } from '@earendil-works/pi-durable'
import { fauxAssistantMessage, fauxToolCall, type AssistantMessage, type TranscriptContext } from '@earendil-works/pi-ai'
import type { AppCommands, CommandOutcome } from '../../src/deployer/app-commands.js'
import { createDeployer, createDeployLock } from '../../src/deployer/index.js'
import { createGitGuard, GitGuardError, type GitGuard } from '../../src/git-guard/index.js'
import { startDoctorService, type DoctorService } from '../../src/service/index.js'
import { testRemontnikConfig } from '../../src/testing/config.js'
import { createScriptedModel } from '../../src/testing/scripted-model.js'
import { createLocalRunner, type CommandRunner } from '../../src/workbench/index.js'
import { CRASH_POINTS, FIXED, ROLLBACK_CRASH_POINT, NEW_TEST, priceCrash, type ChildWorld, type CrashPoint, type FakeAppState } from './world.js'

// Врач в отдельном процессе для проверок падений (T081). Всё, что должно пережить перезапуск, — на диске: записи
// врача, git, состояние подставного приложения и сдвиг часов. С `REMONTNIK_TEST_CRASH_AT=<точка>` процесс убивает
// себя (SIGKILL) в этой точке, как убил бы его сбой сервера; без неё — работает, пока его не остановят (SIGTERM).

const world = JSON.parse(readFileSync(process.argv[2]!, 'utf8')) as ChildWorld
const crashAt = process.env.REMONTNIK_TEST_CRASH_AT as CrashPoint | undefined
if (crashAt && crashAt !== ROLLBACK_CRASH_POINT && !CRASH_POINTS.includes(crashAt)) throw new Error(`нет такой точки падения: ${crashAt}`)

function crash(point: CrashPoint): void {
  if (crashAt !== point) return
  process.stdout.write(`CRASH ${point}\n`)
  process.kill(process.pid, 'SIGKILL')
}

/** Часы врача: идут как настоящие, у спящей задачи перескакивают на время пробуждения; сдвиг переживает перезапуск. */
function persistentClock() {
  let offset = existsSync(world.clockPath) ? Number(readFileSync(world.clockPath, 'utf8')) : 0
  const now = () => Date.now() + offset
  return {
    now,
    onWake(wake: Wake, resume: () => void) {
      if (wake.active || wake.at === undefined) return
      const at = wake.at
      setImmediate(() => {
        offset += Math.max(0, at - now())
        writeFileSync(world.clockPath, String(offset))
        resume()
      })
    },
  }
}

/** Подставное приложение, как `createFakeDeployApp`, но с состоянием в файле: выкатка видна и после перезапуска. */
function fileBackedApp(): { commands: AppCommands; running: () => string | null } {
  const read = (): FakeAppState => JSON.parse(readFileSync(world.appStatePath, 'utf8')) as FakeAppState
  const change = (edit: (state: FakeAppState) => void): FakeAppState => {
    const state = read()
    edit(state)
    writeFileSync(world.appStatePath, JSON.stringify(state))
    return state
  }
  const done = (output: string): CommandOutcome => ({ ok: true, output })
  let healthCalls = 0
  const commands: AppCommands = {
    async current() {
      const state = change((s) => s.calls.push('current'))
      return { ok: true, version: state.running, previous: state.previous }
    },
    async health() {
      change((s) => s.calls.push('health'))
      healthCalls += 1
      if (healthCalls === 2) crash('observing')
      // Правка «делает хуже» во всём мире, где падают после отката: здоровье плохое, пока она работает.
      if (world.sickFix && read().previous !== null) return { ok: false, reason: 'health: 500' }
      return { ok: true }
    },
    async build(_copyDir, version) {
      change((s) => {
        s.calls.push(`build ${version}`)
        s.candidate = version
      })
      return done(`собран ${version}`)
    },
    async promote() {
      crash('before_promote')
      const state = change((s) => {
        s.calls.push('promote')
        if (s.candidate !== null && s.running !== s.candidate) {
          s.previous = s.running
          s.running = s.candidate
          s.promotes += 1
        }
      })
      crash('after_promote')
      return state.candidate === null ? { ok: false, output: 'promote упал' } : done(`работает ${state.running}`)
    },
    async confirm() {
      change((s) => s.calls.push('confirm'))
      return done('подтверждено')
    },
    async rollback() {
      const state = change((s) => {
        s.calls.push('rollback')
        if (s.previous === null) return
        s.running = s.previous
        s.previous = null
        s.rollbacks += 1
      })
      crash('after_rollback')
      return done(`откат на ${state.running}`)
    },
  }
  return { commands, running: () => read().running }
}

/** Модель по истории разговора: что уже сделано — видно по вызовам инструментов, поэтому после перезапуска она продолжает. */
function nextStep(context: TranscriptContext): AssistantMessage {
  const calls = context.messages.flatMap((message) =>
    message.role === 'assistant' ? message.content.filter((part) => part.type === 'toolCall') : [],
  )
  const called = (name: string, path?: string) => calls.some((call) => call.name === name && (path === undefined || call.arguments.path === path))
  const tool = (name: string, args: Record<string, unknown>) =>
    fauxAssistantMessage(fauxToolCall(name, args as Parameters<typeof fauxToolCall>[1]), { stopReason: 'toolUse' })
  if (!called('finish_diagnosis')) {
    if (!called('read')) return tool('read', { path: 'src/price.mjs' })
    crash('diagnosing')
    return tool('finish_diagnosis', { found: true, cause: 'Тариф по умолчанию starter не существует', evidence: ["src/price.mjs: DEFAULT_PLAN = 'starter'"], confidence: 'high' })
  }
  if (context.messages.some((message) => message.role === 'toolResult' && /interrupted/i.test(JSON.stringify(message.content)))) {
    process.stdout.write('INTERRUPTED seen\n')
  }
  if (!called('write', 'src/price.mjs')) return tool('write', { path: 'src/price.mjs', content: FIXED })
  // Команда модели убивает врача: после перезапуска она видит, что команда прервана, и идёт дальше.
  if (crashAt === 'fixing' && !called('bash')) {
    process.stdout.write('CRASH fixing\n')
    return tool('bash', { command: 'kill -9 $PPID; sleep 5' })
  }
  if (!called('write', 'test/default-plan.test.mjs')) return tool('write', { path: 'test/default-plan.test.mjs', content: NEW_TEST })
  return tool('finish_fix', { summary: 'Тариф по умолчанию — start', testsAdded: ['test/default-plan.test.mjs'] })
}

/** Git врача с точкой падения сразу после того, как копия случая создана. */
function crashingGuard(guard: GitGuard): GitGuard {
  return {
    ...guard,
    async addWorktree(options) {
      const made = await guard.addWorktree(options)
      if (options.path === world.workbenchPath) crash('triage')
      return made
    },
    async commitAll(cwd, message) {
      if (crashAt === 'mid_commit') {
        const gitDir = execFileSync('git', ['rev-parse', '--absolute-git-dir'], { cwd, encoding: 'utf8' }).trim()
        writeFileSync(join(gitDir, 'index.lock'), '')
        crash('mid_commit')
      }
      return guard.commitAll(cwd, message)
    },
  }
}

/** Проверки с точкой падения посреди тестов правки. */
function crashingChecks(runner: CommandRunner): CommandRunner {
  return {
    ...runner,
    run(command, options) {
      if (String(command).includes('node --test')) crash('verifying')
      return runner.run(command, options)
    },
  }
}

const clock = persistentClock()
const app = fileBackedApp()
const config = testRemontnikConfig({
  repo: { mainBranch: 'main', mainline: 'merge' },
  workbench: { image: 'node:22', install: 'true', bashTimeoutMs: 30_000 },
  checks: { test: 'node --test test/*.test.mjs' },
  evalScope: [],
  limits: { ...testRemontnikConfig().limits, diagnoseUsdPerCase: 1 },
  observe: { ...testRemontnikConfig().observe, windowMinutes: 1, healthWindowTicks: 3 },
})
let caseState: string | undefined
let doctor: DoctorService | undefined
const loadConfig = async () => {
  // Решение о выкатке ещё не зафиксировано: врач падает посреди фазы `gated`.
  if (crashAt === 'gated' && (await doctor?.caseBook.getCase(1))?.state === 'gated') crash('gated')
  return config
}
const guard = crashingGuard(
  createGitGuard({ repoDir: world.repoDir, worktreesDir: world.worktreesDir, mainBranch: 'main', mainline: 'merge', author: { name: 'Ремонтник', email: 'doctor@example.invalid' } }),
)
const deployer = createDeployer({
  loadConfig,
  commandsFor: () => app.commands,
  mainCopyFor: () => ({ snapshot: async () => ({ commit: 'f'.repeat(40), dirty: {}, files: { 'remontnik.config.ts': 'sha-1' } }) }),
  lockFor: () => createDeployLock(world.lockPath),
  async tagPreDeploy(name, version) {
    try {
      await guard.tagPreDeploy(name, version)
      return { ok: true }
    } catch (error) {
      if (error instanceof GitGuardError) return { ok: false, reason: error.message }
      throw error
    }
  },
})
const model = createScriptedModel()
model.script(...Array.from({ length: 40 }, () => nextStep))
const runner = createLocalRunner()

const service = await startDoctorService({
  stateDir: world.stateDir,
  sharedSecret: 'shared-test-secret',
  listen: { host: '127.0.0.1', port: 0 },
  telegram: { botToken: '123456:test-bot-token', chatId: 'owner-chat', apiBaseUrl: world.telegramUrl },
  log: (line) => process.stderr.write(`${line}\n`),
  now: clock.now,
  onWake: clock.onWake,
  treatment: {
    guard,
    loadConfig,
    currentVersion: async () => app.running() ?? undefined,
    worktreesDir: world.worktreesDir,
    models: model.models,
    model: model.model,
    runner,
    checksRunner: crashingChecks(runner),
    allowUnisolatedRunner: true,
    deployer,
  },
})

doctor = service
process.on('SIGTERM', () => {
  void service.close().then(() => process.exit(0))
})

if (process.env.REMONTNIK_TEST_SEND_EVENT) await service.receiveEvents([priceCrash()])

// Состояние случая — родителю в вывод: записи открыты этим процессом, читать их со стороны нельзя.
for (;;) {
  const found = await service.caseBook.getCase(1)
  if (found && found.state !== caseState) {
    caseState = found.state
    const reports = await service.reports.list({ after: 0, limit: 50 })
    process.stdout.write(`STATE ${JSON.stringify({ state: found.state, reports: reports.map((report) => ({ type: report.type, short: report.short })) })}\n`)
  }
  await new Promise((resolve) => setTimeout(resolve, 25))
}
