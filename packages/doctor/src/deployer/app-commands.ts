import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { RemontnikConfig } from '@ykurilov/remontnik-core/config'
import { spawnWithTimeout } from '../workbench/runner.js'

// Команды выкатки приложения (contracts/deploy-commands.md). Это команды приложения, не модели: они идут на сервере,
// в рабочей копии основной ветки (`build` — в копии правки). `build` запускает код правки, поэтому видит только
// PATH, свой пустой HOME, REMONTNIK_VERSION и перечисленное в `deploy.buildEnv`. Остальным командам — окружение
// врача без его секретов. Свои секреты приложение берёт само.

export type DeployCommands = RemontnikConfig['deploy']['commands']
type CommandName = keyof DeployCommands

/** Секреты врача по имени. Фильтр — подсказка против утечки, а не гарантия: невинное имя он не узнает. */
const DOCTOR_SECRET_ENV = /^REMONTNIK_|KEY|TOKEN|SECRET|PASS|AUTH|CREDENTIAL|PRIVATE|COOKIE|SESSION/

const DEFAULT_TIMEOUTS_SECONDS: Record<CommandName, number> = {
  build: 30 * 60,
  promote: 5 * 60,
  confirm: 5 * 60,
  rollback: 5 * 60,
  current: 30,
  health: 30,
}

/** Версия в `current` — полный коммит: всё остальное — неизвестная версия. */
const FULL_SHA = /^[0-9a-f]{40}$/

/** `version: null` — работающей версии нет (приложение ещё ни разу не выкатывали этими командами). */
export type CurrentAnswer = { ok: true; version: string | null; previous: string | null } | { ok: false; reason: string }
export type HealthAnswer = { ok: true } | { ok: false; reason: string }
export interface CommandOutcome {
  ok: boolean
  /** Хвост вывода: для отчёта человеку. */
  output: string
}

export interface AppCommands {
  current(): Promise<CurrentAnswer>
  health(): Promise<HealthAnswer>
  build(copyDir: string, version: string): Promise<CommandOutcome>
  promote(): Promise<CommandOutcome>
  confirm(): Promise<CommandOutcome>
  rollback(): Promise<CommandOutcome>
}

export interface AppCommandsOptions {
  /** Рабочая копия основной ветки. */
  repoDir: string
  commands: DeployCommands
  /** Окружение врача; по умолчанию — `process.env`. Секреты из него убираются. */
  env?: Record<string, string | undefined>
  /** Какие переменные из `env` видит `build` (`deploy.buildEnv`); REMONTNIK_ — никогда. */
  buildEnv?: readonly string[]
  timeoutsSeconds?: Partial<Record<CommandName, number>>
}

const OUTPUT_FOR_REPORT = 4000

export function deployEnv(env: Record<string, string | undefined>): Record<string, string> {
  const clean: Record<string, string> = {}
  for (const [name, value] of Object.entries(env)) {
    if (value !== undefined && !DOCTOR_SECRET_ENV.test(name.toUpperCase())) clean[name] = value
  }
  return clean
}

/** Окружение `build`: только белый список, без секретов врача. */
export function buildEnvOf(env: Record<string, string | undefined>, names: readonly string[], home: string, version: string): Record<string, string> {
  const clean: Record<string, string> = {}
  for (const name of names) {
    const value = env[name]
    if (value !== undefined && !name.toUpperCase().startsWith('REMONTNIK_')) clean[name] = value
  }
  return { ...clean, PATH: env.PATH ?? '/usr/bin:/bin', HOME: home, REMONTNIK_VERSION: version }
}

const version = (value: unknown): string | null | undefined => (value === null ? null : typeof value === 'string' && FULL_SHA.test(value) ? value : undefined)

export function createAppCommands(options: AppCommandsOptions): AppCommands {
  const doctorEnv = options.env ?? process.env
  const env = deployEnv(doctorEnv)
  const timeouts = { ...DEFAULT_TIMEOUTS_SECONDS, ...options.timeoutsSeconds }

  async function run(name: CommandName, cwd = options.repoDir, commandEnv: Record<string, string> = env) {
    let stdout = ''
    const result = await spawnWithTimeout(
      { file: '/bin/sh', args: ['-c', options.commands[name]], cwd, env: commandEnv },
      {
        cwd,
        timeoutSeconds: timeouts[name],
        onOutput: (text, stream) => {
          if (stream === 'stdout' && stdout.length < 64 * 1024) stdout += text
        },
      },
    )
    const ok = result.exitCode === 0
    const why = result.timedOut ? `тайм-аут ${timeouts[name]} с` : (result.spawnError ?? `код ${result.exitCode}`)
    return { ok, stdout, output: result.output.slice(-OUTPUT_FOR_REPORT), why }
  }

  const outcome = async (name: CommandName, cwd?: string, commandEnv?: Record<string, string>): Promise<CommandOutcome> => {
    const result = await run(name, cwd, commandEnv)
    return { ok: result.ok, output: result.ok ? result.output : `${result.why}\n${result.output}`.trim() }
  }

  return {
    async current() {
      const result = await run('current')
      if (!result.ok) return { ok: false, reason: `current: ${result.why}` }
      try {
        const parsed = JSON.parse(result.stdout.trim()) as { version?: unknown; previous?: unknown }
        const running = version(parsed.version)
        if (running === undefined) return { ok: false, reason: 'current: version — не полный коммит из 40 знаков' }
        const previous = parsed.previous === undefined ? null : version(parsed.previous)
        if (previous === undefined) return { ok: false, reason: 'current: previous — не полный коммит из 40 знаков' }
        return { ok: true, version: running, previous }
      } catch {
        return { ok: false, reason: 'current: ответ не JSON' }
      }
    },

    async health() {
      const result = await run('health')
      if (result.ok) return { ok: true }
      const reason = result.stdout.trim().split('\n').slice(-1)[0]?.slice(0, 300)
      return { ok: false, reason: reason || `health: ${result.why}` }
    },

    async build(copyDir, candidate) {
      const home = await mkdtemp(join(tmpdir(), 'remontnik-build-home-'))
      try {
        return await outcome('build', copyDir, buildEnvOf(doctorEnv, options.buildEnv ?? [], home, candidate))
      } finally {
        await rm(home, { recursive: true, force: true })
      }
    },
    promote: () => outcome('promote'),
    confirm: () => outcome('confirm'),
    rollback: () => outcome('rollback'),
  }
}
