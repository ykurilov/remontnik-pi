import type { AppCommands, CommandOutcome, HealthAnswer } from '../deployer/app-commands.js'
import type { MainCopy, MainCopySnapshot } from '../deployer/main-copy.js'

// Подставное приложение для проверок выкатки: сборки в памяти, `current`/`previous`, как у папочной выкатки
// «Пациента». Журнал вызовов показывает порядок шагов; счётчики — сколько раз выкатывали и откатывали.

export interface FakeDeployApp {
  commands: AppCommands
  /** Журнал вызовов команд: `current`, `build <версия>`, `promote`, `health`, `confirm`, `rollback`. */
  calls: string[]
  readonly running: string | null
  readonly previous: string | null
  readonly promotes: number
  readonly rollbacks: number
  /** Здоровье работающей версии; по умолчанию здорово всё. */
  setHealth(check: (running: string | null) => HealthAnswer): void
  /** `current` перестаёт отвечать (или снова отвечает). */
  setCurrentBroken(broken: boolean): void
  /** Команда падает с кодом не 0 (`times` раз подряд). */
  failNext(command: 'build' | 'promote' | 'rollback' | 'confirm', times?: number): void
  /** Человек выкатил свою версию руками. */
  humanDeploys(version: string): void
  /** Рабочая копия основной ветки на сервере: снимок для проверки, что её никто не трогал. */
  mainCopy: MainCopy
  /** Кто-то изменил рабочую копию: правка файла (`path`, по умолчанию `src/app.ts`; повтор — новая правка), другой коммит или настройка выкатки. */
  changeMainCopy(part: 'dirty' | 'commit' | 'file', path?: string): void
}

export function createFakeDeployApp(initial: { running: string | null; previous?: string | null }): FakeDeployApp {
  let running = initial.running
  let previous = initial.previous ?? null
  let candidate: string | null = null
  let promotes = 0
  let rollbacks = 0
  let currentBroken = false
  let health: (version: string | null) => HealthAnswer = () => ({ ok: true })
  const failing = new Map<string, number>()
  const calls: string[] = []
  const mainCopy: MainCopySnapshot = { commit: 'f'.repeat(40), dirty: {}, files: { 'remontnik.config.ts': 'sha-1' } }
  let edits = 0
  const done = (output: string): CommandOutcome => ({ ok: true, output })
  const fails = (name: string) => {
    const left = failing.get(name) ?? 0
    if (left === 0) return false
    failing.set(name, left - 1)
    return true
  }

  const commands: AppCommands = {
    async current() {
      calls.push('current')
      return currentBroken ? { ok: false, reason: 'current: тайм-аут 30 с' } : { ok: true, version: running, previous }
    },
    async health() {
      calls.push('health')
      return health(running)
    },
    async build(_copyDir, version) {
      calls.push(`build ${version}`)
      if (fails('build')) return { ok: false, output: 'сборка упала' }
      candidate = version
      return done(`собран ${version}`)
    },
    async promote() {
      calls.push('promote')
      if (fails('promote') || candidate === null) return { ok: false, output: 'promote упал' }
      if (running !== candidate) {
        previous = running
        running = candidate
        promotes += 1
      }
      return done(`работает ${running}`)
    },
    async confirm() {
      calls.push('confirm')
      return fails('confirm') ? { ok: false, output: 'confirm упал' } : done('подтверждено')
    },
    async rollback() {
      calls.push('rollback')
      if (fails('rollback') || previous === null) return { ok: false, output: 'откатывать некуда' }
      running = previous
      previous = null
      rollbacks += 1
      return done(`откат на ${running}`)
    },
  }

  return {
    commands,
    calls,
    get running() {
      return running
    },
    get previous() {
      return previous
    },
    get promotes() {
      return promotes
    },
    get rollbacks() {
      return rollbacks
    },
    setHealth: (check) => {
      health = check
    },
    setCurrentBroken: (broken) => {
      currentBroken = broken
    },
    failNext: (command, times = 1) => {
      failing.set(command, times)
    },
    humanDeploys: (version) => {
      previous = running
      running = version
    },
    mainCopy: { snapshot: async () => structuredClone(mainCopy) },
    changeMainCopy: (part, path = 'src/app.ts') => {
      // Каждая правка файла — новый отпечаток.
      if (part === 'dirty') mainCopy.dirty[path] = `sha-edit-${(edits += 1)}`
      else if (part === 'commit') mainCopy.commit = 'e'.repeat(40)
      else mainCopy.files['remontnik.config.ts'] = 'sha-2'
    },
  }
}
