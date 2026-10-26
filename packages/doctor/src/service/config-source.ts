import { createHash } from 'node:crypto'
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { isAbsolute, join, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { defineRemontnikConfig, type RemontnikConfig } from '@ykurilov/remontnik-core/config'

// Источник настройки (R7): врач читает `remontnik.config.*` только из рабочей копии ОСНОВНОЙ ветки.
// Настройка в ветке врача на выкатку не влияет: ветка врача — не то место, откуда берутся запреты.

const CONFIG_FILE_NAMES = ['remontnik.config.ts', 'remontnik.config.mts', 'remontnik.config.js', 'remontnik.config.mjs', 'remontnik.config.json']

/** Ветки врача называются `remontnik/<номер-случая>-<коротко>` (R8). */
const DOCTOR_BRANCH_PREFIX = 'remontnik/'

export type ConfigSourceErrorCode = 'not_found' | 'ambiguous' | 'outside_checkout' | 'unreadable' | 'branch_mismatch'

export class ConfigSourceError extends Error {
  readonly code: ConfigSourceErrorCode

  constructor(code: ConfigSourceErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'ConfigSourceError'
    this.code = code
  }
}

export interface LoadMainBranchConfigOptions {
  /** Рабочая копия основной ветки приложения (не копия ветки врача). */
  mainCheckoutDirectory: string
}

export interface LoadedConfig {
  config: RemontnikConfig
  /** Файл, из которого прочитана настройка. */
  file: string
}

/** Имя ветки, на которой стоит рабочая копия. `undefined` — не git, отдельная голова (detached) или файл не читается. */
function currentBranchOf(checkout: string): string | undefined {
  try {
    const dotGit = join(checkout, '.git')
    if (!existsSync(dotGit)) return undefined
    const gitDirectory = statSync(dotGit).isDirectory()
      ? dotGit
      : resolve(checkout, readFileSync(dotGit, 'utf8').replace(/^gitdir:\s*/, '').trim())
    const head = readFileSync(join(gitDirectory, 'HEAD'), 'utf8').trim()
    return head.startsWith('ref: refs/heads/') ? head.slice('ref: refs/heads/'.length) : undefined
  } catch {
    return undefined
  }
}

function findConfigFile(checkout: string): string {
  const found = CONFIG_FILE_NAMES.map((name) => join(checkout, name)).filter((file) => existsSync(file))
  if (found.length === 0) {
    throw new ConfigSourceError('not_found', `В ${checkout} нет файла настройки (${CONFIG_FILE_NAMES.join(', ')})`)
  }
  if (found.length > 1) {
    throw new ConfigSourceError('ambiguous', `В ${checkout} несколько файлов настройки: ${found.join(', ')}. Нужен один.`)
  }
  const [file] = found as [string]
  const realCheckout = realpathSync(checkout)
  const realFile = realpathSync(file)
  if (!realFile.startsWith(realCheckout + sep)) {
    throw new ConfigSourceError('outside_checkout', `Файл настройки ${file} ведёт за пределы рабочей копии`)
  }
  return file
}

async function readRawConfig(file: string): Promise<unknown> {
  const text = readFileSync(file, 'utf8')
  try {
    if (file.endsWith('.json')) return JSON.parse(text)
    // Отпечаток содержимого в адресе: изменившийся файл читается заново, прежний не берётся из кэша модулей.
    const version = createHash('sha256').update(text).digest('hex').slice(0, 16)
    const loaded = (await import(`${pathToFileURL(file).href}?version=${version}`)) as { default?: unknown }
    return loaded.default
  } catch (error) {
    throw new ConfigSourceError('unreadable', `Файл настройки ${file} не читается: ${error instanceof Error ? error.message : String(error)}`, {
      cause: error,
    })
  }
}

/** Встроенные запреты врач берёт из своего набора, а не из файла: убираем `builtIn`, если приложение уже вызвало `defineRemontnikConfig`. */
function withoutResolvedBuiltIn(raw: unknown): unknown {
  if (typeof raw !== 'object' || raw === null) return raw
  const forbidden = (raw as { forbidden?: unknown }).forbidden
  if (typeof forbidden !== 'object' || forbidden === null || !('builtIn' in forbidden)) return raw
  const { builtIn: _builtIn, ...ownForbidden } = forbidden as Record<string, unknown>
  return { ...raw, forbidden: ownForbidden }
}

/**
 * Читает и проверяет настройку приложения из рабочей копии основной ветки.
 * Если копия стоит на другой ветке (например, на ветке врача) — отказ: ветка узнаётся по `.git/HEAD`.
 * Если ветку узнать нельзя (нет `.git`, отдельная голова), копии доверяют как переданной.
 */
export async function loadMainBranchConfig(options: LoadMainBranchConfigOptions): Promise<LoadedConfig> {
  const checkout = isAbsolute(options.mainCheckoutDirectory) ? options.mainCheckoutDirectory : resolve(options.mainCheckoutDirectory)
  const file = findConfigFile(checkout)

  // Файл — это код, который выполняется при чтении: из ветки врача его не открываем вовсе.
  const branch = currentBranchOf(checkout)
  if (branch?.startsWith(DOCTOR_BRANCH_PREFIX)) {
    throw new ConfigSourceError(
      'branch_mismatch',
      `Рабочая копия ${checkout} стоит на ветке врача "${branch}". Настройка читается только из основной ветки.`,
    )
  }
  const config = defineRemontnikConfig(withoutResolvedBuiltIn(await readRawConfig(file)) as Parameters<typeof defineRemontnikConfig>[0])

  if (branch !== undefined && branch !== config.repo.mainBranch) {
    throw new ConfigSourceError(
      'branch_mismatch',
      `Рабочая копия ${checkout} стоит на ветке "${branch}", а основная ветка по настройке — "${config.repo.mainBranch}". Настройка читается только из основной.`,
    )
  }
  return { config, file }
}
