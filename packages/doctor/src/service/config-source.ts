import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { defineRemontnikConfig, type RemontnikConfig } from '@ykurilov/remontnik-core/config'
import { collectConfigFiles, CONFIG_FILE_NAMES } from '../config-files/index.js'
import { assertValidMask, matchesAllowMask, normalizeRepoPath, PathMaskError } from '../path-mask/index.js'
import type { ConfigCodeReader } from './config-reader.js'

// Источник настройки (R7): врач читает `remontnik.config.*` только из рабочей копии ОСНОВНОЙ ветки.
// Настройка в ветке врача на выкатку не влияет: ветка врача — не то место, откуда берутся запреты.
// Файл настройки — это код. Поэтому ветка проверяется ДО его выполнения, а выполняется он не в процессе врача:
// в отдельном контейнере без секретов врача, сокета Docker и сети (`config-reader.ts`), и только над копией
// файлов настройки. Подключённые файлы каждый раз читаются заново, а не берутся из кэша модулей.

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
  /** Где выполняется код настройки: на сервере — `containerConfigReader`, в тестах — `localConfigReader`. */
  reader: ConfigCodeReader
}

export interface LoadedConfig {
  config: RemontnikConfig
  /** Файл, из которого прочитана настройка. */
  file: string
  /** Файлы рабочей копии, которые подключает настройка, с вложенными (пути от корня копии; `config-files`). */
  localImports: string[]
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

// Как выполняется код настройки. Импорты самой настройки и её файлов разрешаются так:
//  - пакеты Ремонтника, которые есть у врача (его зависимости `@ykurilov/remontnik-*`), — на пакеты врача: из `dist` в образе,
//    из исходников, когда сам врач запущен из исходников (тесты до сборки);
//  - встроенные модули Node — как обычно;
//  - свои файлы — только по относительному пути и только из списка файлов настройки (`config-files`): импорт с вычисляемым
//    путём список не видит, поэтому он отклоняется, а не выполняется;
//  - любой другой пакет — понятная ошибка, даже если он лежит в `node_modules` рабочей копии.
const RESOLVE_HOOKS = `
import { isBuiltin } from 'node:module'
let data
export function initialize(value) { data = value }
const inside = (url) => typeof url === 'string' && url.startsWith(data.checkout)
export async function resolve(specifier, context, next) {
  if (data.sourceRoot && context.parentURL?.startsWith(data.sourceRoot) && /^\\.\\.?\\//.test(specifier) && specifier.endsWith('.js')) {
    return next(specifier.slice(0, -3) + '.ts', context)
  }
  if (!inside(context.parentURL)) return next(specifier, context)
  // Сам файл настройки: скрипт чтения запущен из копии и подключает его по полному адресу.
  if (data.files.includes(specifier)) return next(specifier, context)
  const own = /^(@ykurilov\\/remontnik-[a-z-]+)(?:\\/(.+))?$/.exec(specifier)
  if (own) {
    if (!data.allowed.includes(own[1])) {
      throw new Error('настройка может импортировать только пакеты Ремонтника, которые есть у врача (' + data.allowed.join(', ') + '); импорт ' + specifier + ' не поддерживается')
    }
    if (data.sourceRoot) {
      const name = own[1].slice('@ykurilov/remontnik-'.length)
      const url = data.sourceRoot + name + '/src/' + (own[2] ? own[2] + '/' : '') + 'index.ts'
      return next(url, context)
    }
    return next(specifier, { ...context, parentURL: data.base })
  }
  if (specifier.startsWith('node:') || isBuiltin(specifier)) return next(specifier, context)
  if (!/^\\.\\.?\\//.test(specifier)) {
    throw new Error('настройка должна быть данными; импорт ' + specifier + ' не поддерживается')
  }
  const target = new URL(specifier, context.parentURL)
  target.search = ''
  target.hash = ''
  if (!data.files.includes(target.href)) {
    throw new Error('настройка подключает ' + specifier + ' не строкой в кавычках: такие импорты врач не видит заранее и не выполняет')
  }
  return next(specifier, context)
}
`

const CHILD_SCRIPT = `
import { register } from 'node:module'
import { pathToFileURL } from 'node:url'
register('data:text/javascript,' + encodeURIComponent(process.argv[2]), { parentURL: import.meta.url, data: JSON.parse(process.argv[3]) })
try {
  const loaded = await import(pathToFileURL(process.argv[1]).href)
  // base64: метки в нём быть не может, даже если код настройки сам напечатает её раньше.
  process.stdout.write(process.env.REMONTNIK_RESULT_MARKER + Buffer.from(JSON.stringify({ config: loaded.default ?? null })).toString('base64'))
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
}
process.exit(0)
`

/** Пакеты Ремонтника, которые есть у врача: только их настройка вправе импортировать. */
function ownRemontnikPackages(): string[] {
  const manifest = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { dependencies?: Record<string, string> }
  return Object.keys(manifest.dependencies ?? {}).filter((name) => name.startsWith('@ykurilov/remontnik-'))
}

function hookOptions(copyDir: string, files: readonly string[]): string {
  const fromSource = import.meta.url.endsWith('.ts')
  return JSON.stringify({
    checkout: pathToFileURL(`${copyDir}${sep}`).href,
    files: files.map((file) => pathToFileURL(join(copyDir, file)).href),
    allowed: ownRemontnikPackages(),
    base: import.meta.url,
    // Врач запущен из исходников (тесты до сборки): пакеты набора лежат рядом, `packages/<имя>/src`.
    sourceRoot: fromSource ? new URL('../../../', import.meta.url).href : null,
  })
}

/** Текст файла рабочей копии; ссылка за пределы копии — отказ, не файл (папка, нет такого) — `undefined`. */
function checkoutFileReader(realCheckout: string): (path: string) => Promise<string | undefined> {
  return async (path) => {
    const absolute = join(realCheckout, path)
    if (!existsSync(absolute)) return undefined
    const real = realpathSync(absolute)
    if (!real.startsWith(realCheckout + sep)) throw new ConfigSourceError('outside_checkout', `Файл настройки ${path} ведёт за пределы рабочей копии`)
    return statSync(real).isFile() ? readFileSync(real, 'utf8') : undefined
  }
}

/**
 * Код настройки выполняется в копии, где есть только файлы настройки — ровно те тексты, по которым построен их список.
 * Сама копия и процесс чтения — у исполнителя (`ConfigCodeReader`): на сервере это отдельный контейнер.
 */
async function runConfigCode(file: string, checkout: string, reader: ConfigCodeReader): Promise<{ config: unknown; imports: string[] }> {
  const realCheckout = realpathSync(checkout)
  const entry = relative(realCheckout, realpathSync(file)).split(sep).join('/')
  const texts = new Map<string, string>()
  const readFile = checkoutFileReader(realCheckout)
  const { files, problems } = await collectConfigFiles(entry, async (path) => {
    if (!texts.has(path)) {
      const text = await readFile(path)
      if (text === undefined) return undefined
      texts.set(path, text)
    }
    return texts.get(path)
  })
  if (problems.length > 0) throw new Error(problems.join('; '))

  mkdirSync(reader.scratchDir, { recursive: true })
  const copyDir = realpathSync(mkdtempSync(join(reader.scratchDir, 'config-')))
  try {
    for (const path of files) {
      mkdirSync(dirname(join(copyDir, path)), { recursive: true })
      writeFileSync(join(copyDir, path), texts.get(path)!)
    }
    const marker = `@@remontnik-config-${randomUUID()}@@`
    const stdout = await reader.run({
      copyDir,
      args: ['--no-warnings', '--input-type=module', '-e', CHILD_SCRIPT, join(copyDir, entry), RESOLVE_HOOKS, hookOptions(copyDir, files)],
      env: { REMONTNIK_RESULT_MARKER: marker },
      timeoutMs: READ_TIMEOUT_MS,
      maxOutputBytes: MAX_OUTPUT_BYTES,
    })
    const at = stdout.lastIndexOf(marker)
    if (at === -1) throw new Error('процесс чтения не вернул результат')
    const { config } = JSON.parse(Buffer.from(stdout.slice(at + marker.length).trim(), 'base64').toString('utf8')) as { config: unknown }
    return { config, imports: files.filter((path) => path !== entry) }
  } finally {
    rmSync(copyDir, { recursive: true, force: true })
  }
}

async function readRawConfig(file: string, checkout: string, reader: ConfigCodeReader): Promise<{ raw: unknown; imports: string[] }> {
  try {
    if (file.endsWith('.json')) return { raw: JSON.parse(readFileSync(file, 'utf8')), imports: [] }
    const { config, imports } = await runConfigCode(file, checkout, reader)
    return { raw: config, imports }
  } catch (error) {
    if (error instanceof ConfigSourceError) throw error
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

  const { raw, imports } = await readRawConfig(file, checkout, options.reader)
  const config = defineRemontnikConfig(withoutResolvedBuiltIn(raw) as Parameters<typeof defineRemontnikConfig>[0])
  if (config.repo.mainBranch !== options.mainBranch) {
    throw new ConfigSourceError(
      'branch_mismatch',
      `Основная ветка по настройке — "${config.repo.mainBranch}", а вызывающий считает основной "${options.mainBranch}".`,
    )
  }
  assertMasksUnderstood(config, file)
  assertServicesNotFixable(config, file)
  return { config, file, localImports: imports }
}
