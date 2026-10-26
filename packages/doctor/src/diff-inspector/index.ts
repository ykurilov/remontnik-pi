import { changedLinesOf, isDocumentationPath, type ChangedFile } from '../changed-files/index.js'
import { matchesAnyMask, normalizeRepoPath } from '../path-mask/index.js'

// Осмотр диффа правки врача (R6, пункты 3–5): ослабленные тесты и eval, подозрительный код, размер.
// Чистая функция: ни файлов, ни сети; выводы идут в `deploy-gate`.
//
// Осмотр рассчитан на ошибки и самоуверенность модели, а не на намеренную подмену: признаки ищутся
// шаблонами по тексту, и хитро собранный обход (адрес из кусочков, `require` по вычисленному имени) они не поймают.
// Против такого стоят остальные замки: запретные зоны, права git, метка прежней версии и откат.
// Сомнение или нехватка данных (нет диффа, размер неизвестен) считаются находкой: ложная тревога лучше пропуска.

export type SuspiciousSignal =
  | 'environment_access'
  | 'new_external_address'
  | 'process_spawn'
  | 'dynamic_code'
  | 'outside_project'
  | 'special_file_mode'
  | 'patch_unavailable'
  /** Запись, удаление, переименование файлов: правка могла бы подделать итог проверки. */
  | 'file_write'
  /** Переменные `REMONTNIK*`, папка итога eval (`outDir`) или сам файл итога. */
  | 'remontnik_access'

export interface SuspiciousFinding {
  path: string
  signal: SuspiciousSignal
  /** Добавленная строка, на которой сработал признак. Пусто для признаков уровня файла. */
  line: string
}

export interface ExistingTestChange {
  path: string
  status: ChangedFile['status']
}

export interface DiffInspection {
  /** Изменены, удалены или переименованы существующие тест, сценарий eval, рубрика, судья. Новые файлы — можно. */
  existingTestChanges: ExistingTestChange[]
  suspicious: SuspiciousFinding[]
  /** `unknown` — размер определить нельзя (пустая правка, число строк не число, предел не число). */
  size: { files: number; lines: number; exceeds: Array<'lines' | 'files' | 'unknown'> }
}

export interface DiffLimits {
  maxDiffLines: number
  maxDiffFiles: number
}

export interface InspectDiffOptions {
  /** Хосты или полные адреса, которые приложению уже известны (например, `browser.allowedOrigins`): новыми не считаются. */
  knownHosts?: readonly string[]
  /** Имя файла итога eval (`checks.eval.resultFile`): упоминание в правке — обращение к итогу eval. */
  evalResultFile?: string
}

// Настройки запуска тестов и eval: их нельзя ни менять, ни добавлять заново.
const RUNNER_CONFIG_AND_EVAL_MASKS = [
  '**/vite.config.*',
  '**/vitest.config.*',
  '**/vitest.workspace.*',
  '**/vitest.setup.*',
  '**/jest.config.*',
  '**/jest.setup.*',
  '**/playwright.config.*',
  '**/.mocharc*',
  '**/babel.config.*',
  '**/.babelrc*',
  '**/bunfig.toml',
  '**/conftest.py',
  '**/pytest.ini',
  '**/eval/**',
  '**/evals/**',
  '**/scenarios/**',
  '**/*rubric*',
  '**/*judge*',
]

const TEST_AND_EVAL_MASKS = [
  '**/*.test.*',
  '**/*.spec.*',
  '**/*_test.*',
  '**/*-test.*',
  '**/test_*.py',
  '**/test/**',
  '**/tests/**',
  '**/__tests__/**',
  '**/__snapshots__/**',
  '**/__mocks__/**',
  '**/__fixtures__/**',
  '**/fixtures/**',
  '**/e2e/**',
  ...RUNNER_CONFIG_AND_EVAL_MASKS,
]

const BLOCK_COMMENT = /\/\*.*?\*\//g
const LINE_COMMENT_ONLY = /^\s*\/\//
const IMPORT_LINE = /^\s*(?:import\b|export\b.*\bfrom\b)|\brequire\s*\(/
const URL_WITH_HOST = /\b(?:https?|wss?|ftp):\/\/([^\s/'"`?#)]+)/gi
const SCHEME_RELATIVE_HOST = /(?<=['"`])\/\/([a-z0-9][^\s/'"`?#)]*\.[^\s/'"`?#)]+)/gi
const IPV4 = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g
const LOCAL_HOSTS = new Set(['localhost', '[::1]'])

const ENVIRONMENT_ACCESS = /\bprocess\s*(?:\.\s*env\b|\[\s*['"`]env['"`]\s*\])|\bimport\.meta\.env\b/
const PROCESS_SPAWN =
  /\bchild_process\b|\bBun\.spawn\b|\bDeno\.Command\b|(?<![.\w])(?:exec|execSync|execFile|execFileSync|spawn|spawnSync|fork)\s*\(|\.(?:execSync|execFileSync|execFile|spawn|spawnSync)\s*\(/
const DYNAMIC_CODE =
  /(?<![\w./-])eval(?![\w./-])(?!\s*:)|\b(?:globalThis|window|self|global)\.eval\b|\bnew\s+Function\b|\bFunction\s*\(|(?:from\s+|require\(\s*|import\(\s*)['"](?:node:)?vm['"]/
const SYSTEM_PATH_LITERAL = /['"`](?:\/(?:etc|root|proc|usr|Users|Volumes|home|var|opt|mnt|sys)\/|~\/|[A-Za-z]:\\)/
const HOME_DIRECTORY = /\bhomedir\s*\(/
const FILE_CALL_WITH_PARENT_PATH =
  /\b(?:readFile|writeFile|appendFile|readdir|readFileSync|writeFileSync|appendFileSync|readdirSync|createReadStream|createWriteStream|unlink|unlinkSync|rm|rmSync|rmdir|copyFile|rename|mkdir|mkdirSync|open|openSync|stat|existsSync)\s*\(\s*['"`]\.\.[/\\]/
const SUBMODULE_IN_PATCH = /^Subproject commit\b/
const FILE_WRITE =
  /\b(?:writeFile|writeFileSync|appendFile|appendFileSync|createWriteStream|rename|renameSync|copyFile|copyFileSync|cpSync|writeSync|truncate|truncateSync|unlink|unlinkSync|rm|rmSync|rmdir|rmdirSync|symlink|symlinkSync|chmod|chmodSync)\s*\(|\bBun\.write\s*\(|\bfs\.write\s*\(|\bopen(?:Sync)?\s*\([^)]*,\s*['"`](?:[wa]|r\+)/
const REMONTNIK_ACCESS = /\bREMONTNIK\w*|\boutDir\b|eval-result/

const LINK_AND_SUBMODULE_MODES = new Set(['120000', '160000'])
const EXECUTABLE_MODE = '100755'

export function isTestOrEvalPath(path: string): boolean {
  return matchesAnyMask(TEST_AND_EVAL_MASKS, path)
}

/** Настройка запуска тестов, сценарий, рубрика или судья eval. */
export function isRunnerConfigOrEvalPath(path: string): boolean {
  return matchesAnyMask(RUNNER_CONFIG_AND_EVAL_MASKS, path)
}

function isOutsideProject(path: string): boolean {
  const normalized = normalizeRepoPath(path)
  return normalized === '..' || normalized.startsWith('../') || normalized.startsWith('/') || normalized.startsWith('~') || /^[A-Za-z]:/.test(normalized)
}

/** Хост из адреса или из голого хоста: без схемы, имени пользователя, порта, пути; строчными буквами. */
function hostOf(address: string): string {
  const withoutScheme = address.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/^\/\//, '')
  const authority = withoutScheme.split(/[/?#]/)[0] ?? ''
  const afterUser = authority.slice(authority.lastIndexOf('@') + 1)
  return afterUser.replace(/:\d+$/, '').replace(/[.,;]+$/, '').toLowerCase()
}

function parseIpv4(host: string): number[] | undefined {
  if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) return undefined
  const octets = host.split('.').map(Number)
  return octets.every((octet) => octet <= 255) ? octets : undefined
}

function isLocalHost(host: string): boolean {
  if (LOCAL_HOSTS.has(host) || host.endsWith('.localhost')) return true
  const octets = parseIpv4(host)
  return octets !== undefined && (octets[0] === 127 || octets.every((octet) => octet === 0))
}

/** Адреса из строки: хосты ссылок и «голые» IPv4. Хост, собранный из переменных (`${host}`), узнать нельзя — пропускается. */
function addressesIn(line: string): string[] {
  const hosts: string[] = []
  const collect = (_match: string, rawHost: string) => {
    const host = hostOf(rawHost)
    if (host !== '' && !host.includes('$') && !host.includes('{')) hosts.push(host)
    return ' '
  }
  const rest = line.replace(URL_WITH_HOST, collect).replace(SCHEME_RELATIVE_HOST, collect)
  for (const candidate of rest.match(IPV4) ?? []) if (parseIpv4(candidate)) hosts.push(candidate)
  return hosts
}

/** Код строки без комментариев: блочные `/* .. */` вырезаются, строка целиком из `//` — пустая. Всё остальное — код. */
function withoutComments(line: string): string {
  const stripped = line.replace(BLOCK_COMMENT, ' ')
  return LINE_COMMENT_ONLY.test(stripped) ? '' : stripped
}

function hostsAlreadyInFile(patch: string): Set<string> {
  const lines = patch.split('\n')
  const firstHunk = lines.findIndex((line) => line.startsWith('@@'))
  const known = new Set<string>()
  if (firstHunk === -1) return known
  for (const line of lines.slice(firstHunk)) {
    if (line.startsWith('+')) continue
    for (const host of addressesIn(line)) known.add(host)
  }
  return known
}

function findingsInAddedLines(file: ChangedFile, patch: string, knownHosts: ReadonlySet<string>, evalResultFile: string | undefined): SuspiciousFinding[] {
  const findings: SuspiciousFinding[] = []
  const hostsInFile = hostsAlreadyInFile(patch)
  const report = (signal: SuspiciousSignal, line: string) => findings.push({ path: file.path, signal, line })

  for (const line of changedLinesOf(patch).added) {
    if (ENVIRONMENT_ACCESS.test(line)) report('environment_access', line)
    if (PROCESS_SPAWN.test(line)) report('process_spawn', line)
    if (DYNAMIC_CODE.test(line)) report('dynamic_code', line)

    if (!IMPORT_LINE.test(line) && (SYSTEM_PATH_LITERAL.test(line) || HOME_DIRECTORY.test(line) || FILE_CALL_WITH_PARENT_PATH.test(line))) {
      report('outside_project', line)
    }

    const isNewExternal = addressesIn(withoutComments(line)).some(
      (host) => !isLocalHost(host) && !knownHosts.has(host) && !hostsInFile.has(host),
    )
    if (isNewExternal) report('new_external_address', line)
    if (FILE_WRITE.test(line)) report('file_write', line)
    if (REMONTNIK_ACCESS.test(line) || (evalResultFile && line.includes(evalResultFile))) report('remontnik_access', line)
  }
  return findings
}

function hasSpecialMode(file: ChangedFile): boolean {
  const { mode, previousMode } = file
  if ((mode && LINK_AND_SUBMODULE_MODES.has(mode)) || (previousMode && LINK_AND_SUBMODULE_MODES.has(previousMode))) return true
  if (mode === EXECUTABLE_MODE && previousMode !== EXECUTABLE_MODE) return true
  return Boolean(mode && previousMode && mode !== previousMode)
}

function isPureRename(file: ChangedFile): boolean {
  return file.status === 'renamed' && file.added === 0 && file.removed === 0
}

function inspectSuspicious(files: readonly ChangedFile[], knownHosts: ReadonlySet<string>, evalResultFile: string | undefined): SuspiciousFinding[] {
  const findings: SuspiciousFinding[] = []
  for (const file of files) {
    if (isOutsideProject(file.path) || (file.previousPath && isOutsideProject(file.previousPath))) {
      findings.push({ path: file.path, signal: 'outside_project', line: '' })
    }
    if (hasSpecialMode(file)) findings.push({ path: file.path, signal: 'special_file_mode', line: '' })
    if (file.patch !== undefined && changedLinesOf(file.patch).added.concat(changedLinesOf(file.patch).removed).some((line) => SUBMODULE_IN_PATCH.test(line))) {
      findings.push({ path: file.path, signal: 'special_file_mode', line: '' })
    }

    if (isDocumentationPath(file.path)) continue
    if (file.patch === undefined || file.patch.trim() === '') {
      if (file.status !== 'deleted' && !isPureRename(file)) findings.push({ path: file.path, signal: 'patch_unavailable', line: '' })
      continue
    }
    findings.push(...findingsInAddedLines(file, file.patch, knownHosts, evalResultFile))
  }
  return findings
}

function inspectExistingTests(files: readonly ChangedFile[]): ExistingTestChange[] {
  const changes: ExistingTestChange[] = []
  for (const file of files) {
    if (file.status === 'added') continue
    const existingPath = file.status === 'renamed' ? (file.previousPath ?? file.path) : file.path
    if (isTestOrEvalPath(existingPath)) changes.push({ path: file.path, status: file.status })
  }
  return changes
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function inspectSize(files: readonly ChangedFile[], limits: DiffLimits): DiffInspection['size'] {
  const counts = files.flatMap((file) => [file.added, file.removed])
  const lines = counts.filter(isCount).reduce((sum, count) => sum + count, 0)
  const exceeds: DiffInspection['size']['exceeds'] = []
  if (isCount(limits.maxDiffLines) && lines > limits.maxDiffLines) exceeds.push('lines')
  if (isCount(limits.maxDiffFiles) && files.length > limits.maxDiffFiles) exceeds.push('files')
  const unknown = files.length === 0 || !counts.every(isCount) || !isCount(limits.maxDiffLines) || !isCount(limits.maxDiffFiles)
  if (unknown) exceeds.push('unknown')
  return { files: files.length, lines, exceeds }
}

/** Осмотр диффа правки: что не должно уходить в выкатку само. Решение принимает `deploy-gate`. */
export function inspectDiff(files: readonly ChangedFile[], limits: DiffLimits, options: InspectDiffOptions = {}): DiffInspection {
  const knownHosts = new Set((options.knownHosts ?? []).map(hostOf))
  return {
    existingTestChanges: inspectExistingTests(files),
    suspicious: inspectSuspicious(files, knownHosts, options.evalResultFile),
    size: inspectSize(files, limits),
  }
}
