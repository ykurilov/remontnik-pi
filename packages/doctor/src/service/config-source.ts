import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
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
  /** Файлы рабочей копии, которые настройка подключила (пути от корня копии). */
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

// Настройка исполняется как код, в отдельном процессе Node. Это не защита: файл основной ветки доверенный, а подсказка
// владельцу нужна, чтобы настройка не падала с ERR_MODULE_NOT_FOUND на сервере, где нет зависимостей приложения.
// Поэтому импорты самой настройки и её соседних файлов разрешаются так:
//  - пакеты Ремонтника, которые есть у врача (его зависимости `@ykurilov/remontnik-*`), — на пакеты врача: из `dist` в образе,
//    из исходников, когда сам врач запущен из исходников (тесты до сборки);
//  - относительные пути и встроенные модули Node — как обычно;
//  - любой другой пакет — понятная ошибка, даже если он лежит в `node_modules` рабочей копии.
// Файлы, которые настройка подключила из рабочей копии, возвращаются в ответе: `check-config` предупреждает о тех из них,
// что вне запретных зон (враче не стоит менять настройку косвенно).
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
  if (!/^(\\.{0,2}\\/|file:|data:|node:)/.test(specifier) && !isBuiltin(specifier)) {
    throw new Error('настройка должна быть данными; импорт ' + specifier + ' не поддерживается')
  }
  const resolved = await next(specifier, context)
  if (!resolved.url.startsWith('node:') && !resolved.url.includes('/node_modules/')) data.port.postMessage(resolved.url)
  return resolved
}
`

const CHILD_SCRIPT = `
import { register } from 'node:module'
import { MessageChannel, receiveMessageOnPort } from 'node:worker_threads'
import { pathToFileURL } from 'node:url'
const { port1, port2 } = new MessageChannel()
const options = JSON.parse(process.argv[3])
register('data:text/javascript,' + encodeURIComponent(process.argv[2]), { parentURL: import.meta.url, data: { ...options, port: port1 }, transferList: [port1] })
try {
  const loaded = await import(pathToFileURL(process.argv[1]).href)
  const imports = []
  for (let message = receiveMessageOnPort(port2); message; message = receiveMessageOnPort(port2)) imports.push(message.message)
  process.stdout.write(process.env.REMONTNIK_RESULT_MARKER + JSON.stringify({ config: loaded.default ?? null, imports }))
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

function hookOptions(checkout: string): string {
  const fromSource = import.meta.url.endsWith('.ts')
  return JSON.stringify({
    checkout: pathToFileURL(`${realpathSync(checkout)}${sep}`).href,
    allowed: ownRemontnikPackages(),
    base: import.meta.url,
    // Врач запущен из исходников (тесты до сборки): пакеты набора лежат рядом, `packages/<имя>/src`.
    sourceRoot: fromSource ? new URL('../../../', import.meta.url).href : null,
  })
}

function runConfigProcess(file: string, checkout: string): Promise<{ config: unknown; imports: string[] }> {
  const marker = `@@remontnik-config-${randomUUID()}@@`
  return new Promise((resolveOutput, reject) => {
    execFile(
      process.execPath,
      ['--no-warnings', '--input-type=module', '-e', CHILD_SCRIPT, file, RESOLVE_HOOKS, hookOptions(checkout)],
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
        resolveOutput(JSON.parse(stdout.slice(at + marker.length)) as { config: unknown; imports: string[] })
      },
    )
  })
}

async function readRawConfig(file: string, checkout: string): Promise<{ raw: unknown; imports: string[] }> {
  try {
    if (file.endsWith('.json')) return { raw: JSON.parse(readFileSync(file, 'utf8')), imports: [] }
    const { config, imports } = await runConfigProcess(file, checkout)
    const realCheckout = realpathSync(checkout)
    const own = [...new Set(imports.map((url) => fileURLToPath(url)))]
      .filter((path) => path !== realpathSync(file))
      .map((path) => relative(realCheckout, path).split(sep).join('/'))
    return { raw: config, imports: own }
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

  const { raw, imports } = await readRawConfig(file, checkout)
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
