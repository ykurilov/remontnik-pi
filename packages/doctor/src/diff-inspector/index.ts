import { changedLinesOf, type ChangedFile } from '../changed-files/index.js'
import { matchesAnyMask, normalizeRepoPath } from '../path-mask/index.js'

// Осмотр диффа правки врача (R6, пункты 3–5): ослабленные тесты и eval, подозрительный код, размер.
// Чистая функция: ни файлов, ни сети; выводы идут в `deploy-gate`.

export type SuspiciousSignal =
  | 'environment_access'
  | 'new_external_address'
  | 'process_spawn'
  | 'dynamic_code'
  | 'outside_project'
  | 'patch_unavailable'

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
  size: { files: number; lines: number; exceeds: Array<'lines' | 'files'> }
}

export interface DiffLimits {
  maxDiffLines: number
  maxDiffFiles: number
}

export interface InspectDiffOptions {
  /** Хосты, которые приложению уже известны (например, из `browser.allowedOrigins`): новыми не считаются. */
  knownHosts?: readonly string[]
}

const TEST_AND_EVAL_MASKS = [
  '**/*.test.*',
  '**/*.spec.*',
  '**/test/**',
  '**/tests/**',
  '**/__tests__/**',
  '**/__snapshots__/**',
  '**/__mocks__/**',
  '**/fixtures/**',
  '**/e2e/**',
  '**/vitest.config.*',
  '**/vitest.setup.*',
  '**/jest.config.*',
  '**/jest.setup.*',
  '**/playwright.config.*',
  '**/eval/**',
  '**/evals/**',
  '**/scenarios/**',
  '**/*rubric*',
  '**/*judge*',
]

const DOCUMENT_FILE = /\.(?:md|mdx|txt|rst)$/i
const COMMENT_LINE = /^\s*(?:\/\/|\/\*|\*|#|<!--)/
const IMPORT_LINE = /^\s*(?:import\b|export\b.*\bfrom\b)|\brequire\s*\(/
const URL_WITH_HOST = /\b(?:https?|wss?|ftp):\/\/([^\s/'"`?#)]+)/gi
const IPV4 = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g
const LOCAL_HOSTS = new Set(['localhost', '[::1]', '0.0.0.0'])

const ENVIRONMENT_ACCESS = /\bprocess\.env\b|\bimport\.meta\.env\b/
const PROCESS_SPAWN = /\bchild_process\b|\bBun\.spawn\b|\bDeno\.Command\b/
const DYNAMIC_CODE = /\beval\s*\(|\bnew\s+Function\b|\bFunction\s*\(|(?:from\s+|require\(\s*|import\(\s*)['"](?:node:)?vm['"]/
const SYSTEM_PATH_LITERAL = /['"`](?:\/(?:etc|root|proc|usr|Users|Volumes|home|var|opt|mnt|sys)\/|~\/|[A-Za-z]:\\)/
const HOME_DIRECTORY = /\bhomedir\s*\(/
const FILE_CALL_WITH_PARENT_PATH =
  /\b(?:readFile|writeFile|appendFile|readdir|readFileSync|writeFileSync|appendFileSync|readdirSync|createReadStream|createWriteStream|unlink|unlinkSync|rm|rmSync|rmdir|copyFile|rename|mkdir|mkdirSync|open|openSync|stat|existsSync)\s*\(\s*['"`]\.\.[/\\]/

export function isTestOrEvalPath(path: string): boolean {
  return matchesAnyMask(TEST_AND_EVAL_MASKS, path)
}

function isOutsideProject(path: string): boolean {
  const normalized = normalizeRepoPath(path)
  return normalized === '..' || normalized.startsWith('../') || normalized.startsWith('/') || normalized.startsWith('~') || /^[A-Za-z]:/.test(normalized)
}

function hostOf(rawHost: string): string {
  return rawHost.replace(/:\d+$/, '').replace(/[.,;]+$/, '').toLowerCase()
}

function isLocalHost(host: string): boolean {
  return LOCAL_HOSTS.has(host) || host.endsWith('.localhost') || host.startsWith('127.')
}

function isIpv4(candidate: string): boolean {
  return candidate.split('.').every((octet) => Number(octet) <= 255)
}

/** Адреса из строки: хосты ссылок и «голые» IPv4. Хост, собранный из переменных (`${host}`), узнать нельзя — пропускается. */
function addressesIn(line: string): string[] {
  const hosts: string[] = []
  const rest = line.replace(URL_WITH_HOST, (_match, rawHost: string) => {
    const host = hostOf(rawHost)
    if (!host.includes('$') && !host.includes('{')) hosts.push(host)
    return ' '
  })
  for (const candidate of rest.match(IPV4) ?? []) if (isIpv4(candidate)) hosts.push(candidate)
  return hosts
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

function findingsInAddedLines(file: ChangedFile, patch: string, knownHosts: ReadonlySet<string>): SuspiciousFinding[] {
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

    if (!COMMENT_LINE.test(line)) {
      const isNewExternal = addressesIn(line).some((host) => !isLocalHost(host) && !knownHosts.has(host) && !hostsInFile.has(host))
      if (isNewExternal) report('new_external_address', line)
    }
  }
  return findings
}

function inspectSuspicious(files: readonly ChangedFile[], knownHosts: ReadonlySet<string>): SuspiciousFinding[] {
  const findings: SuspiciousFinding[] = []
  for (const file of files) {
    if (isOutsideProject(file.path) || (file.previousPath && isOutsideProject(file.previousPath))) {
      findings.push({ path: file.path, signal: 'outside_project', line: '' })
    }
    if (DOCUMENT_FILE.test(file.path)) continue
    if (file.patch === undefined) {
      if (file.status !== 'deleted') findings.push({ path: file.path, signal: 'patch_unavailable', line: '' })
      continue
    }
    findings.push(...findingsInAddedLines(file, file.patch, knownHosts))
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

function inspectSize(files: readonly ChangedFile[], limits: DiffLimits): DiffInspection['size'] {
  const lines = files.reduce((sum, file) => sum + file.added + file.removed, 0)
  const exceeds: Array<'lines' | 'files'> = []
  if (lines > limits.maxDiffLines) exceeds.push('lines')
  if (files.length > limits.maxDiffFiles) exceeds.push('files')
  return { files: files.length, lines, exceeds }
}

/** Осмотр диффа правки: что не должно уходить в выкатку само. Решение принимает `deploy-gate`. */
export function inspectDiff(files: readonly ChangedFile[], limits: DiffLimits, options: InspectDiffOptions = {}): DiffInspection {
  const knownHosts = new Set((options.knownHosts ?? []).map((host) => host.toLowerCase()))
  return {
    existingTestChanges: inspectExistingTests(files),
    suspicious: inspectSuspicious(files, knownHosts),
    size: inspectSize(files, limits),
  }
}
