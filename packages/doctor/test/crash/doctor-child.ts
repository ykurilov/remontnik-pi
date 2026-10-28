import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Wake } from '@earendil-works/pi-durable'
import { fauxAssistantMessage, fauxToolCall, type AssistantMessage, type TranscriptContext } from '@earendil-works/pi-ai'
import type { BrowserAnswer, BrowserClient } from '../../src/browser-tools/index.js'
import { runDoctorCommand } from '../../src/cli/run-doctor-command.js'
import { createPaseoBridgeClient, type PaseoBridgeClient } from '../../src/handoff/index.js'
import type { AppCommands, CommandOutcome } from '../../src/deployer/app-commands.js'
import { createDeployer, createDeployLock } from '../../src/deployer/index.js'
import { createGitGuard, GitGuardError, type GitGuard } from '../../src/git-guard/index.js'
import { startDoctorService, type DoctorService } from '../../src/service/index.js'
import { testRemontnikConfig } from '../../src/testing/config.js'
import { createScriptedModel } from '../../src/testing/scripted-model.js'
import { createLocalRunner, type CommandRunner } from '../../src/workbench/index.js'
import {
  BRIDGE_SECRET,
  BROWSER_CRASH_POINT,
  CONTROL_SECRET,
  CRASH_POINTS,
  FIXED,
  NEW_TEST,
  PASEO_CRASH_POINTS,
  priceCrash,
  ROLLBACK_CRASH_POINT,
  STAND_BRIDGE_SILENCE_MS,
  type ChildWorld,
  type CrashPoint,
  type FakeAppState,
  type FakeBrowserState,
  writeJsonAtomically,
} from './world.js'

// Врач в отдельном процессе для проверок падений (T081). Всё, что должно пережить перезапуск, — на диске: записи
// врача, git, состояние подставного приложения и сдвиг часов. С `REMONTNIK_TEST_CRASH_AT=<точка>` процесс убивает
// себя (SIGKILL) в этой точке, как убил бы его сбой сервера; без неё — работает, пока его не остановят (SIGTERM).
// `REMONTNIK_TEST_STOP_BEFORE_CRASH` — перед смертью владелец жмёт стоп-кран; `REMONTNIK_TEST_BROWSER` — у врача есть
// браузер, и диагноз начинается со страницы, где нужна проверка человеком; `REMONTNIK_TEST_BROKEN_CHECKS` — набор врача
// сломан, тесты в копии не запускаются. С `paseoBridgeUrl` в мире — режим
// «сначала Paseo»: случай уходит подставному мосту стенда, адрес врача для моста — строкой `BRIDGE`.

const world = JSON.parse(readFileSync(process.argv[2]!, 'utf8')) as ChildWorld
const crashAt = process.env.REMONTNIK_TEST_CRASH_AT as CrashPoint | undefined
/** `fixing` — коммит правки один раз падает обычной ошибкой: задача лечения падает насовсем (task_faulted). */
let faultAt = process.env.REMONTNIK_TEST_FAULT_AT
const stopBeforeCrash = process.env.REMONTNIK_TEST_STOP_BEFORE_CRASH === '1'
const withBrowser = process.env.REMONTNIK_TEST_BROWSER === '1'
const brokenChecks = process.env.REMONTNIK_TEST_BROKEN_CHECKS === '1'
const knownPoints: readonly string[] = [...CRASH_POINTS, ROLLBACK_CRASH_POINT, BROWSER_CRASH_POINT, ...PASEO_CRASH_POINTS]
if (crashAt && !knownPoints.includes(crashAt)) throw new Error(`нет такой точки падения: ${crashAt}`)
const SITE = 'http://127.0.0.1:4100'

function crash(point: CrashPoint): void {
  if (crashAt !== point) return
  process.stdout.write(`CRASH ${point}\n`)
  process.kill(process.pid, 'SIGKILL')
}

/** Как `crash`, но перед смертью владелец, если так задано, жмёт стоп-кран той же командой, что в консоли. */
async function crashAfterOwner(point: CrashPoint): Promise<void> {
  if (crashAt !== point) return
  if (stopBeforeCrash) {
    const io = { env: { REMONTNIK_DOCTOR_URL: doctor!.url, REMONTNIK_CONTROL_SECRET: CONTROL_SECRET }, stdout: () => {}, stderr: (text: string) => void process.stderr.write(text) }
    if ((await runDoctorCommand(['deploys', 'stop', '--by', 'owner'], io)) !== 0) throw new Error('стоп-кран не нажался')
  }
  crash(point)
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
function fileBackedApp(): { commands: AppCommands; running: () => string | null; mainCopyDirty: () => Record<string, string> } {
  const read = (): FakeAppState => JSON.parse(readFileSync(world.appStatePath, 'utf8')) as FakeAppState
  const change = (edit: (state: FakeAppState) => void): FakeAppState => {
    const state = read()
    edit(state)
    writeJsonAtomically(world.appStatePath, state)
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
      if (healthCalls === 2) {
        crash('observing')
        crash('paseo_observing')
      }
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
      crash('after_confirm')
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
  return { commands, running: () => read().running, mainCopyDirty: () => read().mainCopyDirty ?? {} }
}

/** Подставная служба браузера на диске: на странице капча, пока владелец не вернул управление. */
function fileBackedBrowser(): BrowserClient {
  const change = (edit: (state: FakeBrowserState) => void): FakeBrowserState => {
    const state = JSON.parse(readFileSync(world.browserStatePath, 'utf8')) as FakeBrowserState
    edit(state)
    writeJsonAtomically(world.browserStatePath, state)
    return state
  }
  let statusCalls = 0
  return {
    async call(command): Promise<BrowserAnswer> {
      const state = change((s) => s.calls.push(command))
      if (command === 'url') return { ok: false, code: 'needs_human', message: 'капча на странице: нужен человек' }
      if (command === 'status') {
        statusCalls += 1
        if (statusCalls === 1 && crashAt === BROWSER_CRASH_POINT) {
          // Отчёт needs_human уже записан: родитель видит его до смерти врача, а не гадает по опросу.
          await printState()
          crash(BROWSER_CRASH_POINT)
        }
        return { ok: true, state: state.ownerReturned ? 'ready' : 'needs_human' }
      }
      if (command === 'read') return { ok: true, url: `${SITE}/cabinet`, snapshot: 'Кабинет: вход выполнен' }
      throw new Error(`неожиданная команда браузера ${command}`)
    },
  }
}

/** Клиент моста с точками падения: мост принял задачу, агент работает, отмена ещё не ушла, мост молчит. */
function crashingBridge(client: PaseoBridgeClient): PaseoBridgeClient {
  let silentAnswers = 0
  return {
    async health() {
      const working = (await doctor?.caseBook.getCase(1))?.state === 'paseo_working'
      if (working) crash('paseo_working')
      const up = await client.health()
      // Второй немой ответ, пока агент работает: начало молчания записано при первом. Немой ответ ещё до «взял» не в счёт:
      // принятие задачи пришло через мост, и отсчёт молчания в `paseo_working` начинается заново.
      if (!up && working && (silentAnswers += 1) === 2) crash('bridge_silent')
      return up
    },
    async sendTask(task) {
      const sent = await client.sendTask(task)
      if (sent && crashAt === 'handoff_sent') {
        await printState()
        crash('handoff_sent')
      }
      return sent
    },
    async cancel(taskId, reason) {
      // Отчёт reclaimed уже записан: родитель видит его до смерти врача.
      if (crashAt === 'before_cancel') {
        await printState()
        crash('before_cancel')
      }
      return client.cancel(taskId, reason)
    },
  }
}

/** Модель по истории разговора: что уже сделано — видно по вызовам инструментов, поэтому после перезапуска она продолжает. */
function nextStep(context: TranscriptContext): AssistantMessage {
  const calls = context.messages.flatMap((message) =>
    message.role === 'assistant' ? message.content.filter((part) => part.type === 'toolCall') : [],
  )
  const called = (name: string, path?: string) => calls.some((call) => call.name === name && (path === undefined || call.arguments.path === path))
  const tool = (name: string, args: Record<string, unknown>) =>
    fauxAssistantMessage(fauxToolCall(name, args as Parameters<typeof fauxToolCall>[1]), { stopReason: 'toolUse' })
  const results = context.messages.filter((message) => message.role === 'toolResult').map((message) => JSON.stringify(message.content))
  if (withBrowser && !called('browser_url')) return tool('browser_url', { url: `${SITE}/captcha` })
  if (withBrowser && !called('browser_wait_human')) return tool('browser_wait_human', {})
  if (withBrowser && !called('read')) {
    if (results.some((text) => text.includes('Владелец вернул управление'))) process.stdout.write('HUMAN returned seen\n')
    if (results.some((text) => text.includes('не вернул управление'))) process.stdout.write('HUMAN timeout seen\n')
  }
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
    async mergeIntoMain(branch, commit) {
      await guard.mergeIntoMain(branch, commit)
      await crashAfterOwner('after_merge_push')
    },
    async commitAll(cwd, message) {
      if (faultAt === 'fixing') {
        faultAt = undefined
        throw new Error('подстроенный сбой коммита')
      }
      if (crashAt === 'mid_commit') {
        const gitDir = execFileSync('git', ['rev-parse', '--absolute-git-dir'], { cwd, encoding: 'utf8' }).trim()
        writeFileSync(join(gitDir, 'index.lock'), '')
        crash('mid_commit')
      }
      return guard.commitAll(cwd, message)
    },
  }
}

/** Проверки с точкой падения посреди тестов правки; при сломанном наборе тесты не запускаются. */
function crashingChecks(runner: CommandRunner): CommandRunner {
  return {
    ...runner,
    async run(command, options) {
      if (String(command).includes('node --test')) crash('verifying')
      if (brokenChecks && String(command).includes('node --test')) return { exitCode: 127, timedOut: false, aborted: false, output: 'sh: 1: pnpm: not found\n' }
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
  ...(withBrowser
    ? {
        browser: {
          enabled: true,
          profile: 'remontnik',
          allowedOrigins: [SITE],
          allowedMutations: [],
          pagesToCheck: [],
          live: { enabled: true, linkEnv: 'REMONTNIK_LIVE_LINK' },
        },
      }
    : {}),
  ...(world.paseoBridgeUrl
    ? {
        handoff: {
          mode: 'paseo-first' as const,
          paseo: { bridgeUrlEnv: 'TEST_BRIDGE_URL', bridgeSecretEnv: 'TEST_BRIDGE_SECRET', listenEnv: 'TEST_BRIDGE_LISTEN', acceptTimeoutMs: 3_600_000, workTimeoutMs: 3_600_000, bridgeSilenceMs: STAND_BRIDGE_SILENCE_MS },
        },
      }
    : {}),
})
let caseState: string | undefined
let caseEvents = 0
let reportCount = 0
let doctor: DoctorService | undefined

async function printState(): Promise<void> {
  if (!doctor) return
  const found = await doctor.caseBook.getCase(1)
  const reports = found ? await doctor.reports.list({ after: 0, limit: 50 }) : []
  if (found && (found.state !== caseState || found.events !== caseEvents || reports.length !== reportCount)) {
    caseState = found.state
    caseEvents = found.events
    reportCount = reports.length
    process.stdout.write(`STATE ${JSON.stringify({ state: found.state, events: found.events, reports: reports.map((report) => ({ type: report.type, short: report.short })) })}\n`)
  }
}
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
  mainCopyFor: () => ({ snapshot: async () => ({ commit: 'f'.repeat(40), dirty: app.mainCopyDirty(), files: { 'remontnik.config.ts': 'sha-1' } }) }),
  lockFor: () => createDeployLock(world.lockPath),
  async tagPreDeploy(name, version) {
    try {
      await guard.tagPreDeploy(name, version)
      crash('after_tag')
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
  controlSecret: CONTROL_SECRET,
  listen: { host: '127.0.0.1', port: 0 },
  telegram: { botToken: '123456:test-bot-token', chatId: 'owner-chat', apiBaseUrl: world.telegramUrl },
  log: (line) => process.stderr.write(`${line}\n`),
  ...(world.paseoBridgeUrl
    ? {
        reportsFeed: { bridge: { listen: { host: '127.0.0.1', port: 0 }, secret: BRIDGE_SECRET, appName: config.app.name } },
        // Частые проверки: часы врача перескакивают только на время пробуждения, сроки агента далеко.
        paseoBridge: { client: crashingBridge(createPaseoBridgeClient({ url: world.paseoBridgeUrl, secret: BRIDGE_SECRET, appName: config.app.name })), pollMs: 200 },
      }
    : {}),
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
    ...(withBrowser ? { browser: { client: fileBackedBrowser(), env: { REMONTNIK_LIVE_LINK: 'http://127.0.0.1:7701' }, pollMs: 50 } } : {}),
  },
})

doctor = service
process.stdout.write(`URL ${service.url}\n`)
if (service.bridgeUrl) process.stdout.write(`BRIDGE ${service.bridgeUrl}\n`)
process.on('SIGTERM', () => {
  void service.close().then(() => process.exit(0))
})

if (process.env.REMONTNIK_TEST_SEND_EVENT) await service.receiveEvents([priceCrash()])

// Состояние случая — родителю в вывод: записи открыты этим процессом, читать их со стороны нельзя.
for (;;) {
  await printState()
  await new Promise((resolve) => setTimeout(resolve, 25))
}
