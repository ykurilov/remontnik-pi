import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { isAbsolute, join, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { defineRemontnikConfig, type RemontnikConfig } from '@ykurilov/remontnik-core/config'
import { assertValidMask, matchesAllowMask, normalizeRepoPath, PathMaskError } from '../path-mask/index.js'

// Источник настройки (R7): врач читает `remontnik.config.*` только из рабочей копии ОСНОВНОЙ ветки.
// Настройка в ветке врача на выкатку не влияет: ветка врача — не то место, откуда берутся запреты.
// Файл настройки — это код. Поэтому ветка проверяется ДО его выполнения, а читается он в отдельном
// процессе Node: подключённые файлы каждый раз читаются заново, а не берутся из кэша модулей.

const CONFIG_FILE_NAMES = ['remontnik.config.ts', 'remontnik.config.mts', 'remontnik.config.js', 'remontnik.config.mjs', 'remontnik.config.json']

const READ_TIMEOUT_MS = 30_000
const MAX_OUTPUT_BYTES = 10 * 1024 * 1024

export type ConfigSourceErrorCode =
  | 'not_found'
  | 'ambiguous'
  | 'outside_checkout'
  | 'unreadable'
  | 'branch_mismatch'
  | 'branch_unknown'
  | 'invalid_mask'
  | 'services_fixable'

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
  /** Имя основной ветки, как его знает вызывающий (не файл настройки): копия должна стоять ровно на ней. */
  mainBranch: string
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

const CHILD_SCRIPT = `
import { pathToFileURL } from 'node:url'
const loaded = await import(pathToFileURL(process.argv[1]).href)
process.stdout.write(process.env.REMONTNIK_RESULT_MARKER + JSON.stringify(loaded.default ?? null))
`

function runConfigProcess(file: string, checkout: string): Promise<string> {
  const marker = `@@remontnik-config-${randomUUID()}@@`
  return new Promise((resolveOutput, reject) => {
    execFile(
      process.execPath,
      ['--no-warnings', '--input-type=module', '-e', CHILD_SCRIPT, file],
      {
        cwd: checkout,
        timeout: READ_TIMEOUT_MS,
        maxBuffer: MAX_OUTPUT_BYTES,
        env: { PATH: process.env.PATH ?? '', REMONTNIK_RESULT_MARKER: marker },
      },
      (error, stdout, stderr) => {
        if (error) return reject(new Error(stderr.trim() || error.message))
        const at = stdout.lastIndexOf(marker)
        if (at === -1) return reject(new Error('процесс чтения не вернул результат'))
        resolveOutput(stdout.slice(at + marker.length))
      },
    )
  })
}

async function readRawConfig(file: string, checkout: string): Promise<unknown> {
  try {
    if (file.endsWith('.json')) return JSON.parse(readFileSync(file, 'utf8'))
    return JSON.parse(await runConfigProcess(file, checkout))
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

/** Маска, которую наш разбор не понимает, молча не сработала бы: запрет оказался бы дырой. Поэтому — ошибка настройки. */
function assertMasksUnderstood(config: RemontnikConfig, file: string): void {
  const masks = [
    ...config.forbidden.schema,
    ...config.forbidden.money,
    ...config.forbidden.access,
    ...(config.forbidden.extra ?? []),
    ...config.closedPaths,
    ...config.fixablePaths,
    ...config.evalScope.flatMap((scope) => scope.paths),
  ]
  for (const mask of masks) {
    try {
      assertValidMask(mask)
    } catch (error) {
      if (error instanceof PathMaskError) {
        throw new ConfigSourceError('invalid_mask', `В настройке ${file} маска «${mask}» не поддерживается: ${error.message}`, { cause: error })
      }
      throw error
    }
  }
}

/** Файл служб для тестов задаёт, что поднимает врач: правка не может его менять, значит, он не в `fixablePaths`. */
function assertServicesNotFixable(config: RemontnikConfig, file: string): void {
  const services = config.checks.services
  if (!services) return
  const path = normalizeRepoPath(services.trim())
  const mask = config.fixablePaths.find((candidate) => matchesAllowMask([candidate], path))
  if (mask) {
    throw new ConfigSourceError(
      'services_fixable',
      `В настройке ${file} файл служб для тестов checks.services «${path}» попадает в fixablePaths («${mask}»). Этот файл врач не даёт править: уберите его из fixablePaths или перенесите вне их.`,
    )
  }
}

/**
 * Читает и проверяет настройку приложения из рабочей копии основной ветки.
 * Копия обязана стоять ровно на основной ветке из параметров. Отдельная голова (detached HEAD),
 * чужая ветка, ветка врача и «не git» — отказ, и файл при этом не выполняется.
 */
export async function loadMainBranchConfig(options: LoadMainBranchConfigOptions): Promise<LoadedConfig> {
  const checkout = isAbsolute(options.mainCheckoutDirectory) ? options.mainCheckoutDirectory : resolve(options.mainCheckoutDirectory)
  const file = findConfigFile(checkout)

  const branch = currentBranchOf(checkout)
  if (branch === undefined) {
    throw new ConfigSourceError(
      'branch_unknown',
      `Не удалось узнать ветку рабочей копии ${checkout} (нет git или отдельная голова). Настройка читается только из основной ветки "${options.mainBranch}".`,
    )
  }
  if (branch !== options.mainBranch) {
    throw new ConfigSourceError(
      'branch_mismatch',
      `Рабочая копия ${checkout} стоит на ветке "${branch}", а основная — "${options.mainBranch}". Настройка читается только из основной.`,
    )
  }

  const config = defineRemontnikConfig(withoutResolvedBuiltIn(await readRawConfig(file, checkout)) as Parameters<typeof defineRemontnikConfig>[0])
  if (config.repo.mainBranch !== options.mainBranch) {
    throw new ConfigSourceError(
      'branch_mismatch',
      `Основная ветка по настройке — "${config.repo.mainBranch}", а вызывающий считает основной "${options.mainBranch}".`,
    )
  }
  assertMasksUnderstood(config, file)
  assertServicesNotFixable(config, file)
  return { config, file }
}
