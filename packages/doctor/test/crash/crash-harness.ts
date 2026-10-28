import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startFakeTelegram, type FakeTelegramServer } from '@ykurilov/remontnik-core/testing'
import { HANDOFF_COLLECTION, handoffKey, type Handoff } from '../../src/handoff/index.js'
import { emptyFingerprintLedger, LEDGER, type FingerprintLedger } from '../../src/ledgers/fingerprint-ledger.js'
import { copyRecord } from '../../src/records/index.js'
import { seedDoctorRecords } from '../../src/testing/doctor-records.js'
import { workbenchPath } from '../../src/workbench/index.js'
import { runDoctorCommand } from '../../src/cli/run-doctor-command.js'
import { startFakePaseoBridge, type FakePaseoBridge } from '../../src/testing/fake-paseo-bridge.js'
import { BRIDGE_SECRET, BUGGY, CONTROL_SECRET, OLD_TEST, type ChildWorld, type CrashPoint, type FakeAppState, type FakeBrowserState, writeJsonAtomically } from './world.js'

// Стенд падений (T081): врач идёт отдельным процессом (`doctor-child.ts`), его убивают в заданной точке
// (`REMONTNIK_TEST_CRASH_AT`) и запускают снова на тех же записях, git и приложении. Итог читается после остановки.

const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url))
const loader = join(repoRoot, 'scripts/source-loader/register.mjs')
const childEntry = fileURLToPath(new URL('./doctor-child.ts', import.meta.url))

export const FINAL_STATES = ['healed', 'healed_by_paseo', 'rolled_back', 'not_helped', 'report_only', 'needs_human', 'no_cause_found', 'stand_broken']

export function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' } }).trim()
}

export interface CrashWorld extends ChildWorld {
  root: string
  origin: string
  base: string
  worldPath: string
  telegram: FakeTelegramServer
  /** Подставной мост Paseo, если мир в режиме «сначала Paseo». */
  bridge?: FakePaseoBridge
  appState(): FakeAppState
  editAppState(edit: (state: FakeAppState) => void): void
  browserState(): FakeBrowserState
  editBrowserState(edit: (state: FakeBrowserState) => void): void
  /** Сдвинуть часы врача: столько времени прошло, пока он лежал. */
  advanceClock(ms: number): void
  ledger(): Promise<FingerprintLedger>
  /** Документ передачи случая агенту Paseo; читать, когда врач остановлен. */
  handoff(caseId: number): Promise<Handoff | undefined>
  close(): Promise<void>
}

const readJson = <T>(path: string): T => JSON.parse(readFileSync(path, 'utf8')) as T

function editJson<T>(path: string, edit: (state: T) => void): void {
  const state = readJson<T>(path)
  edit(state)
  writeJsonAtomically(path, state)
}

/** Репозиторий приложения с ошибкой, подставное приложение на прежней версии и подставной Telegram. */
export async function createCrashWorld(options: { sickFix?: boolean; paseo?: boolean } = {}): Promise<CrashWorld> {
  const root = mkdtempSync(join(tmpdir(), 'remontnik-crash-'))
  const origin = join(root, 'origin.git')
  const repoDir = join(root, 'main')
  git(root, 'init', '--bare', '--initial-branch=main', origin)
  git(root, 'clone', origin, repoDir)
  git(repoDir, 'config', 'user.email', 'owner@example.com')
  git(repoDir, 'config', 'user.name', 'Owner')
  const files: Record<string, string> = { '.gitignore': 'node_modules\n.remontnik/\n', 'src/price.mjs': BUGGY, 'test/price.test.mjs': OLD_TEST }
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(repoDir, path)), { recursive: true })
    writeFileSync(join(repoDir, path), content)
  }
  git(repoDir, 'add', '-A')
  git(repoDir, 'commit', '-m', 'начало')
  git(repoDir, 'push', 'origin', 'main')
  const base = git(repoDir, 'rev-parse', 'HEAD')
  const telegram = await startFakeTelegram()
  const bridge = options.paseo ? await startFakePaseoBridge({ secret: BRIDGE_SECRET, appName: 'test-app' }) : undefined
  const worktreesDir = join(root, 'worktrees')
  const world: ChildWorld = {
    repoDir,
    stateDir: join(root, 'state'),
    worktreesDir,
    workbenchPath: workbenchPath(worktreesDir, 1),
    lockPath: join(repoDir, '.remontnik', 'deploy.lock'),
    telegramUrl: telegram.baseUrl,
    appStatePath: join(root, 'app.json'),
    clockPath: join(root, 'clock-offset'),
    browserStatePath: join(root, 'browser.json'),
    sickFix: options.sickFix ?? false,
    ...(bridge ? { paseoBridgeUrl: bridge.url } : {}),
  }
  const initial: FakeAppState = { running: base, previous: null, candidate: null, promotes: 0, rollbacks: 0, calls: [] }
  writeFileSync(world.appStatePath, JSON.stringify(initial))
  writeFileSync(world.browserStatePath, JSON.stringify({ ownerReturned: false, calls: [] } satisfies FakeBrowserState))
  const worldPath = join(root, 'world.json')
  writeFileSync(worldPath, JSON.stringify(world))
  return {
    ...world,
    root,
    origin,
    base,
    worldPath,
    telegram,
    ...(bridge ? { bridge } : {}),
    appState: () => readJson<FakeAppState>(world.appStatePath),
    editAppState: (edit) => editJson(world.appStatePath, edit),
    browserState: () => readJson<FakeBrowserState>(world.browserStatePath),
    editBrowserState: (edit) => editJson(world.browserStatePath, edit),
    advanceClock(ms) {
      const offset = existsSync(world.clockPath) ? Number(readFileSync(world.clockPath, 'utf8')) : 0
      writeFileSync(world.clockPath, String(offset + ms))
    },
    async ledger() {
      let found = emptyFingerprintLedger()
      await seedDoctorRecords(world.stateDir, async (tx) => {
        found = copyRecord(await tx.doc<FingerprintLedger>(LEDGER.collection, LEDGER.key, emptyFingerprintLedger()))
      })
      return found
    },
    async handoff(caseId) {
      let found: Handoff | undefined
      await seedDoctorRecords(world.stateDir, async (tx) => {
        const doc = await tx.doc<Handoff>(HANDOFF_COLLECTION, handoffKey(caseId), {} as Handoff)
        found = doc.caseId === undefined ? undefined : copyRecord(doc)
      })
      return found
    },
    async close() {
      await telegram.close()
      await bridge?.close()
      rmSync(root, { recursive: true, force: true })
    },
  }
}

export interface ChildReport {
  type: string
  short: string
}

export interface ChildState {
  state: string
  /** Сколько появлений сбоя склеено в случай. */
  events: number
  reports: ChildReport[]
}

export interface DoctorProcess {
  states: ChildState[]
  /** Адрес врача, когда он запустился. */
  url(): Promise<string>
  /** Адрес врача для моста Paseo. */
  bridgeUrl(): Promise<string>
  /** Команда владельца `remontnik-doctor …` этому врачу. */
  command(argv: string[]): Promise<{ code: number; out: string; err: string }>
  output(): string
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>
  waitForState(states: readonly string[], timeoutMs?: number): Promise<ChildState>
  waitForReport(type: string, timeoutMs?: number): Promise<ChildReport>
  /** Ждать условия со стороны (файлы мира), пока врач жив. */
  waitFor(check: () => boolean, what: string, timeoutMs?: number): Promise<void>
  stop(): Promise<{ code: number | null; signal: NodeJS.Signals | null }>
}

export interface RunDoctorOptions {
  /** Где врачу умереть. */
  crashAt?: CrashPoint
  /** Обычная ошибка один раз: при коммите правки или сразу после того, как мост принял задачу агенту. */
  faultAt?: 'fixing' | 'handoff_sent'
  /** Прислать сбой «Пациента» сразу после старта. */
  sendEvent?: boolean
  /** Перед смертью врача владелец нажимает стоп-кран. */
  stopBeforeCrash?: boolean
  /** У врача есть браузер, и модель начинает диагноз со страницы, где нужна проверка человеком. */
  browser?: boolean
  /** Набор врача сломан: тесты в копии не запускаются (`pnpm: not found`), лечение кончается «только отчётом». */
  brokenChecks?: boolean
}

/** Запустить врача на мире стенда. */
export function runDoctor(world: CrashWorld, options: RunDoctorOptions = {}): DoctorProcess {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' }
  delete env.REMONTNIK_TEST_CRASH_AT
  delete env.REMONTNIK_TEST_FAULT_AT
  delete env.REMONTNIK_TEST_SEND_EVENT
  delete env.REMONTNIK_TEST_STOP_BEFORE_CRASH
  delete env.REMONTNIK_TEST_BROWSER
  delete env.REMONTNIK_TEST_BROKEN_CHECKS
  if (options.stopBeforeCrash) env.REMONTNIK_TEST_STOP_BEFORE_CRASH = '1'
  if (options.browser) env.REMONTNIK_TEST_BROWSER = '1'
  if (options.brokenChecks) env.REMONTNIK_TEST_BROKEN_CHECKS = '1'
  if (options.crashAt) env.REMONTNIK_TEST_CRASH_AT = options.crashAt
  if (options.faultAt) env.REMONTNIK_TEST_FAULT_AT = options.faultAt
  if (options.sendEvent) env.REMONTNIK_TEST_SEND_EVENT = '1'
  const child = spawn(process.execPath, ['--import', loader, '--no-warnings', '--experimental-transform-types', childEntry, world.worldPath], {
    cwd: repoRoot,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const states: ChildState[] = []
  let address: string | undefined
  let bridgeAddress: string | undefined
  let output = ''
  let buffered = ''
  const waiters = new Set<() => void>()
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk: string) => {
    output += chunk
    buffered += chunk
    let newline: number
    while ((newline = buffered.indexOf('\n')) >= 0) {
      const line = buffered.slice(0, newline)
      buffered = buffered.slice(newline + 1)
      if (line.startsWith('STATE ')) states.push(JSON.parse(line.slice(6)) as ChildState)
      if (line.startsWith('URL ')) address = line.slice(4)
      if (line.startsWith('BRIDGE ')) bridgeAddress = line.slice(7)
    }
    for (const wake of waiters) wake()
  })
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk: string) => {
    output += chunk
  })
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.on('exit', (code, signal) => {
      resolve({ code, signal })
      for (const wake of waiters) wake()
    })
  })
  let gone = false
  void exited.then(() => {
    gone = true
  })
  async function until<T>(found: () => T | undefined, what: string, timeoutMs: number): Promise<T> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const value = found()
      if (value !== undefined) return value
      if (gone) throw new Error(`врач вышел, не дождавшись: ${what}; последнее: ${states.at(-1)?.state}\n${output.slice(-4000)}`)
      if (Date.now() > deadline) throw new Error(`не дождались: ${what}; последнее: ${states.at(-1)?.state}\n${output.slice(-4000)}`)
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 500)
        waiters.add(() => {
          clearTimeout(timer)
          resolve()
        })
      })
      waiters.clear()
    }
  }
  const url = () => until(() => address, 'адрес врача', 60_000)
  return {
    states,
    url,
    bridgeUrl: () => until(() => bridgeAddress, 'адрес врача для моста', 60_000),
    async command(argv) {
      const env = { REMONTNIK_DOCTOR_URL: await url(), REMONTNIK_CONTROL_SECRET: CONTROL_SECRET }
      let out = ''
      let err = ''
      const code = await runDoctorCommand(argv, { env, stdout: (text) => (out += text), stderr: (text) => (err += text) })
      return { code, out, err }
    },
    output: () => output,
    exited,
    waitForState: (wanted, timeoutMs = 60_000) => until(() => states.find((state) => wanted.includes(state.state)), `случай в ${wanted.join('/')}`, timeoutMs),
    waitForReport: (type, timeoutMs = 60_000) => until(() => states.findLast((state) => state.reports.some((report) => report.type === type))?.reports.find((report) => report.type === type), `отчёт ${type}`, timeoutMs),
    waitFor: async (check, what, timeoutMs = 60_000) => void (await until(() => (check() ? true : undefined), what, timeoutMs)),
    async stop() {
      if (!gone) child.kill('SIGTERM')
      return exited
    },
  }
}

export interface CrashOutcome {
  /** Что увидели после перезапуска: итог случая и отчёты. */
  final: ChildState
  /** Отчёты, записанные до смерти врача. */
  reportsBeforeCrash: string[]
  /** Вывод врача после перезапуска. */
  restartOutput: string
}

/**
 * Убить врача в точке `crashAt`, запустить снова и дождаться итога случая. `whileDown` — что случилось, пока врач
 * лежал; `afterRestart` — что делать с перезапущенным врачом, пока он лечит.
 */
export async function crashAndRestart(
  world: CrashWorld,
  crashAt: CrashPoint,
  options: Omit<RunDoctorOptions, 'crashAt' | 'sendEvent'> & {
    /** Что делать с первым врачом, пока он жив (агент Paseo берёт случай и т. п.). */
    whileUp?: (doctor: DoctorProcess) => Promise<void>
    whileDown?: () => void
    afterRestart?: (doctor: DoctorProcess) => Promise<void>
  } = {},
): Promise<CrashOutcome> {
  const { whileUp, whileDown, afterRestart, ...run } = options
  const first = runDoctor(world, { ...run, crashAt, sendEvent: true })
  // Ошибка помощника не важна, если врач всё равно умер в точке: её видно по итогу ниже.
  void whileUp?.(first).catch(() => {})
  const died = await Promise.race([
    first.exited,
    new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 60_000)),
  ])
  if (died === 'timeout') {
    await first.stop()
    throw new Error(`врач не дошёл до точки ${crashAt}: ${first.states.at(-1)?.state}\n${first.output().slice(-4000)}`)
  }
  if (died.signal !== 'SIGKILL' || !first.output().includes(`CRASH ${crashAt}`)) {
    throw new Error(`врач вышел не в точке ${crashAt} (${died.signal ?? died.code}): ${first.states.at(-1)?.state}\n${first.output().slice(-4000)}`)
  }
  whileDown?.()
  const second = runDoctor(world, { ...(run.browser ? { browser: true } : {}) })
  try {
    await afterRestart?.(second)
    const final = await second.waitForState(FINAL_STATES, 90_000)
    return {
      final,
      reportsBeforeCrash: (first.states.at(-1)?.reports ?? []).map((report) => report.type),
      restartOutput: second.output(),
    }
  } finally {
    const stopped = await second.stop()
    if (stopped.code !== 0 && stopped.signal !== 'SIGTERM') throw new Error(`врач не остановился чисто: ${stopped.signal ?? stopped.code}\n${second.output().slice(-4000)}`)
  }
}
