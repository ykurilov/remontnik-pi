import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startFakeTelegram, type FakeTelegramServer } from '@ykurilov/remontnik-core/testing'
import { emptyFingerprintLedger, LEDGER, type FingerprintLedger } from '../../src/ledgers/fingerprint-ledger.js'
import { copyRecord } from '../../src/records/index.js'
import { seedDoctorRecords } from '../../src/testing/doctor-records.js'
import { workbenchPath } from '../../src/workbench/index.js'
import { BUGGY, OLD_TEST, type ChildWorld, type CrashPoint, type FakeAppState } from './world.js'

// Стенд падений (T081): врач идёт отдельным процессом (`doctor-child.ts`), его убивают в заданной точке
// (`REMONTNIK_TEST_CRASH_AT`) и запускают снова на тех же записях, git и приложении. Итог читается после остановки.

const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url))
const loader = join(repoRoot, 'scripts/source-loader/register.mjs')
const childEntry = fileURLToPath(new URL('./doctor-child.ts', import.meta.url))

export const FINAL_STATES = ['healed', 'rolled_back', 'not_helped', 'report_only', 'needs_human', 'no_cause_found', 'stand_broken']

export function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' } }).trim()
}

export interface CrashWorld extends ChildWorld {
  root: string
  origin: string
  base: string
  worldPath: string
  telegram: FakeTelegramServer
  appState(): FakeAppState
  ledger(): Promise<FingerprintLedger>
  close(): Promise<void>
}

/** Репозиторий приложения с ошибкой, подставное приложение на прежней версии и подставной Telegram. */
export async function createCrashWorld(options: { sickFix?: boolean } = {}): Promise<CrashWorld> {
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
    sickFix: options.sickFix ?? false,
  }
  const initial: FakeAppState = { running: base, previous: null, candidate: null, promotes: 0, rollbacks: 0, calls: [] }
  writeFileSync(world.appStatePath, JSON.stringify(initial))
  const worldPath = join(root, 'world.json')
  writeFileSync(worldPath, JSON.stringify(world))
  return {
    ...world,
    root,
    origin,
    base,
    worldPath,
    telegram,
    appState: () => JSON.parse(readFileSync(world.appStatePath, 'utf8')) as FakeAppState,
    async ledger() {
      let found = emptyFingerprintLedger()
      await seedDoctorRecords(world.stateDir, async (tx) => {
        found = copyRecord(await tx.doc<FingerprintLedger>(LEDGER.collection, LEDGER.key, emptyFingerprintLedger()))
      })
      return found
    },
    async close() {
      await telegram.close()
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
  reports: ChildReport[]
}

export interface DoctorProcess {
  states: ChildState[]
  output(): string
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>
  waitForState(states: readonly string[], timeoutMs?: number): Promise<ChildState>
  stop(): Promise<{ code: number | null; signal: NodeJS.Signals | null }>
}

/** Запустить врача на мире стенда; `crashAt` — где ему умереть, `sendEvent` — прислать сбой «Пациента» сразу после старта. */
export function runDoctor(world: CrashWorld, options: { crashAt?: CrashPoint; sendEvent?: boolean } = {}): DoctorProcess {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' }
  delete env.REMONTNIK_TEST_CRASH_AT
  delete env.REMONTNIK_TEST_SEND_EVENT
  if (options.crashAt) env.REMONTNIK_TEST_CRASH_AT = options.crashAt
  if (options.sendEvent) env.REMONTNIK_TEST_SEND_EVENT = '1'
  const child = spawn(process.execPath, ['--import', loader, '--no-warnings', '--experimental-transform-types', childEntry, world.worldPath], {
    cwd: repoRoot,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const states: ChildState[] = []
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
  return {
    states,
    output: () => output,
    exited,
    async waitForState(wanted, timeoutMs = 60_000) {
      const deadline = Date.now() + timeoutMs
      for (;;) {
        const found = states.find((state) => wanted.includes(state.state))
        if (found) return found
        if (gone) throw new Error(`врач вышел, не дойдя до ${wanted.join('/')}; последнее: ${states.at(-1)?.state}\n${output.slice(-4000)}`)
        if (Date.now() > deadline) throw new Error(`случай не дошёл до ${wanted.join('/')}: ${states.at(-1)?.state}\n${output.slice(-4000)}`)
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 500)
          waiters.add(() => {
            clearTimeout(timer)
            resolve()
          })
        })
        waiters.clear()
      }
    },
    async stop() {
      if (!gone) child.kill('SIGTERM')
      return exited
    },
  }
}

export interface CrashOutcome {
  /** Что увидели после перезапуска: итог случая и отчёты. */
  final: ChildState
  /** Состояния случая в первом (убитом) запуске. */
  beforeCrash: string[]
  /** Вывод врача после перезапуска. */
  restartOutput: string
}

/** Убить врача в точке `crashAt`, запустить снова и дождаться итога случая. */
export async function crashAndRestart(world: CrashWorld, crashAt: CrashPoint): Promise<CrashOutcome> {
  const first = runDoctor(world, { crashAt, sendEvent: true })
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
  const second = runDoctor(world)
  try {
    const final = await second.waitForState(FINAL_STATES, 90_000)
    return { final, beforeCrash: first.states.map((state) => state.state), restartOutput: second.output() }
  } finally {
    const stopped = await second.stop()
    if (stopped.code !== 0 && stopped.signal !== 'SIGTERM') throw new Error(`врач не остановился чисто: ${stopped.signal ?? stopped.code}\n${second.output().slice(-4000)}`)
  }
}
