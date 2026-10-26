import type { RemontnikConfig } from '@ykurilov/remontnik-core/config'
import { spawnWithTimeout } from '../workbench/runner.js'

// Команды выкатки приложения (contracts/deploy-commands.md). Это команды приложения, не модели: они идут на сервере,
// в рабочей копии основной ветки (`build` — в копии правки). Окружение — врача, но без его секретов: `build`
// запускает код правки, а ключи моделей, Telegram и общий секрет ему не нужны. Свои секреты приложение берёт само.

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

export function createAppCommands(options: AppCommandsOptions): AppCommands {
  const env = deployEnv(options.env ?? process.env)
  const timeouts = { ...DEFAULT_TIMEOUTS_SECONDS, ...options.timeoutsSeconds }

  async function run(name: CommandName, cwd = options.repoDir, extraEnv: Record<string, string> = {}) {
    let stdout = ''
    const result = await spawnWithTimeout(
      { file: '/bin/sh', args: ['-c', options.commands[name]], cwd, env: { ...env, ...extraEnv } },
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

  const outcome = async (name: CommandName, cwd?: string, extraEnv?: Record<string, string>): Promise<CommandOutcome> => {
    const result = await run(name, cwd, extraEnv)
    return { ok: result.ok, output: result.ok ? result.output : `${result.why}\n${result.output}`.trim() }
  }

  return {
    async current() {
      const result = await run('current')
      if (!result.ok) return { ok: false, reason: `current: ${result.why}` }
      try {
        const parsed = JSON.parse(result.stdout.trim()) as { version?: unknown; previous?: unknown }
        const version = parsed.version === null ? null : typeof parsed.version === 'string' && parsed.version !== '' ? parsed.version : undefined
        if (version === undefined) return { ok: false, reason: 'current: нет version' }
        const previous = typeof parsed.previous === 'string' && parsed.previous !== '' ? parsed.previous : null
        return { ok: true, version, previous }
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

    build: (copyDir, version) => outcome('build', copyDir, { REMONTNIK_VERSION: version }),
    promote: () => outcome('promote'),
    confirm: () => outcome('confirm'),
    rollback: () => outcome('rollback'),
  }
}
