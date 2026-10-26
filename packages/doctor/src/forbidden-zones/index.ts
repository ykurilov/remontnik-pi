import { DEFAULT_FORBIDDEN, type RemontnikConfig } from '@ykurilov/remontnik-core/config'
import { changedLinesOf, isDocumentationPath, type ChangedFile } from '../changed-files/index.js'
import { firstMatchingMask, matchesAnyMask, matchesMask, normalizeRepoPath } from '../path-mask/index.js'

// Запретные зоны (конституция III, R7): правка в них никогда не выкатывается сама.
// Проверка — кодом, по маскам путей и признакам в диффе; модель на неё не влияет.
// Защита рассчитана на ошибки и самоуверенность модели, а не на намеренную подмену: хитро спрятанный
// обход текстовым шаблоном не поймать. Остальную защиту дают права git, метки и откат.

export type ForbiddenZone =
  | 'schema'
  | 'money'
  | 'access'
  | 'agent_chat_sdk'
  | 'remontnik'
  | 'dependencies'
  | 'build_and_deploy'
  | 'app_extra'

export interface ForbiddenZoneHit {
  path: string
  zone: ForbiddenZone
  /** Маска или признак, по которому файл попал в зону. */
  rule: string
}

/** Что нужно знать о настройке: запреты и команды, из которых берутся защищаемые пути. */
export type ZoneConfig = Pick<RemontnikConfig, 'forbidden' | 'deploy' | 'checks' | 'workbench'>

// Не снимаются никакими флагами: хуки git, подмодули, настройки менеджера пакетов.
const ALWAYS_BUILD_AND_DEPLOY_MASKS = ['.husky/**', '.githooks/**', '**/.gitmodules']
const ALWAYS_DEPENDENCY_MASKS = ['**/.npmrc', '**/pnpm-workspace.yaml', '**/.pnpmfile.cjs', '**/.yarnrc*']
// Снимаются `allowBuildAndDeployChanges`.
const EXTRA_BUILD_AND_DEPLOY_MASKS = ['**/Makefile', '**/tsconfig*.json']
// Папки миграций — схема, даже если приложение их не указало.
const MIGRATION_FOLDER_MASKS = ['**/migrations/**', '**/migrate/**', '**/prisma/**', '**/drizzle/**']

const PACKAGE_MANIFEST = '**/package.json'
const WORKSPACE_FILE = '**/pnpm-workspace.yaml'
const DEPENDENCY_SECTIONS = new Set(['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'])
const PACKAGE_NAME = /@[\w.-]+\/[\w.-]+/g

// Признаки схемы в SQL-файлах (дополняют встроенные из core). Регистр не важен.
const SQL_EXTRA_SIGNALS = [
  /\bTRUNCATE\b/i,
  /\bDELETE\s+FROM\b/i,
  /\bCREATE\s+(?:OR\s+REPLACE\s+)?(?:UNIQUE\s+)?(?:INDEX|VIEW|FUNCTION|TRIGGER|TYPE|SCHEMA|EXTENSION)\b/i,
  /\bGRANT\b/i,
  /\bREVOKE\b/i,
]
// DDL внутри строк в коде. Короткие слова вроде delete/grant считаются только заглавными, чтобы не ловить обычные фразы.
const CODE_DDL_SIGNALS = [
  /\bDROP\s+(?:TABLE|INDEX|VIEW|SCHEMA|DATABASE|COLUMN|TRIGGER|TYPE|FUNCTION)\b/i,
  /\bALTER\s+TABLE\b/i,
  /\bCREATE\s+(?:OR\s+REPLACE\s+)?(?:UNIQUE\s+)?(?:TABLE|INDEX|VIEW|TRIGGER|FUNCTION|SCHEMA|TYPE|EXTENSION)\b/i,
  /\bTRUNCATE\s+\w/,
  /\bDELETE\s+FROM\b/,
  /\bGRANT\s+[A-Z][A-Z, ]*\s+ON\b/,
  /\bREVOKE\s+[A-Z][A-Z, ]*\s+ON\b/,
]

function zoneOfProtectedPackage(pattern: string): ForbiddenZone {
  return pattern.startsWith('@ykurilov/agent-chat-') ? 'agent_chat_sdk' : 'remontnik'
}

function changedText(patch: string): string {
  const { added, removed } = changedLinesOf(patch)
  return [...added, ...removed].join('\n')
}

function protectedPackageHit(config: ZoneConfig, patch: string): { zone: ForbiddenZone; rule: string } | undefined {
  for (const name of changedText(patch).match(PACKAGE_NAME) ?? []) {
    const pattern = config.forbidden.builtIn.protectedPackages.find((candidate) => matchesMask(candidate, name))
    if (pattern) return { zone: zoneOfProtectedPackage(pattern), rule: `пакет ${pattern}` }
  }
  return undefined
}

function parseManifest(text: string | undefined): Record<string, unknown> | undefined {
  if (text === undefined) return undefined
  try {
    const parsed: unknown = JSON.parse(text)
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : undefined
  } catch {
    return undefined
  }
}

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

/** Когда приложение разрешило менять зависимости: менять можно только разделы зависимостей. Проверка — по полному тексту до и после. */
function manifestViolation(config: ZoneConfig, file: ChangedFile): { zone: ForbiddenZone; rule: string } | undefined {
  const after = parseManifest(file.contentAfter)
  const before = file.status === 'added' ? {} : parseManifest(file.contentBefore)
  if (file.status === 'deleted' || !after || !before) {
    return { zone: 'dependencies', rule: 'package.json: полный текст до и после недоступен, проверить нечем' }
  }
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (DEPENDENCY_SECTIONS.has(key)) {
      const beforeSection = (before[key] ?? {}) as Record<string, unknown>
      const afterSection = (after[key] ?? {}) as Record<string, unknown>
      for (const name of new Set([...Object.keys(beforeSection), ...Object.keys(afterSection)])) {
        const pattern = config.forbidden.builtIn.protectedPackages.find((candidate) => matchesMask(candidate, name))
        if (pattern && !sameValue(beforeSection[name], afterSection[name])) {
          return { zone: zoneOfProtectedPackage(pattern), rule: `пакет ${pattern}` }
        }
      }
    } else if (!sameValue(before[key], after[key])) {
      return { zone: 'dependencies', rule: `package.json: изменено «${key}» (разрешены только разделы зависимостей)` }
    }
  }
  return undefined
}

function sqlRule(config: ZoneConfig, file: ChangedFile): string | undefined {
  const paths = file.previousPath ? [file.path, file.previousPath] : [file.path]
  const isSql = paths.some((path) => matchesAnyMask(config.forbidden.builtIn.schemaSignalFiles, path))
  if (isSql) {
    if (file.patch === undefined || file.patch.trim() === '') return 'SQL без текста правки: изменения схемы проверить нечем'
    const text = changedText(file.patch)
    const signal = [...config.forbidden.builtIn.schemaSignals, ...SQL_EXTRA_SIGNALS].find((candidate) => candidate.test(text))
    return signal ? `признак схемы ${signal.source}` : undefined
  }
  if (file.patch === undefined || isDocumentationPath(file.path)) return undefined
  const text = changedText(file.patch)
  const signal = CODE_DDL_SIGNALS.find((candidate) => candidate.test(text))
  return signal ? `DDL в коде ${signal.source}` : undefined
}

/** Пути файлов, которые называют команды и замок из настройки: их правка подменяет проверки и выкатку. */
function settingsCommandPaths(config: ZoneConfig): string[] {
  const commands = [
    ...Object.values(config.deploy.commands),
    config.checks.test,
    config.checks.typecheck,
    config.checks.eval?.run,
    config.workbench.install,
  ]
  const files = [config.deploy.lockFile, config.checks.services]
  const paths = new Set<string>()
  const add = (candidate: string) => {
    const path = normalizeRepoPath(candidate.trim())
    if (path !== '.' && path !== '') paths.add(path.toLowerCase())
  }
  for (const file of files) if (file) add(file)
  for (const command of commands) {
    if (!command) continue
    for (const word of command.split(/[\s"'`;|&()<>]+/)) {
      for (const token of word.split('=')) {
        const looksLikePath = (token.includes('/') || /\.[A-Za-z0-9]+$/.test(token)) && !token.startsWith('-')
        if (looksLikePath && !/[{$]/.test(token) && !token.includes('://')) add(token)
      }
    }
  }
  return [...paths]
}

function commandPathRule(commandPaths: readonly string[], path: string): string | undefined {
  const normalized = normalizeRepoPath(path).toLowerCase()
  const found = commandPaths.find((candidate) => normalized === candidate || normalized.startsWith(`${candidate}/`))
  return found ? `команда или замок настройки: ${found}` : undefined
}

/**
 * Файлы правки, попавшие в запретные зоны. Пустой список — правка вне зон.
 * Маски: настройка приложения + встроенные запреты (их нельзя снять) + запреты по умолчанию, если приложение их не сняло.
 */
export function findForbiddenZones(config: ZoneConfig, files: readonly ChangedFile[]): ForbiddenZoneHit[] {
  const { forbidden } = config
  const pathRules: Array<{ zone: ForbiddenZone; masks: readonly string[] }> = [
    { zone: 'schema', masks: [...forbidden.schema, ...MIGRATION_FOLDER_MASKS] },
    { zone: 'money', masks: forbidden.money },
    { zone: 'access', masks: [...forbidden.access, ...forbidden.builtIn.accessMasks] },
    { zone: 'app_extra', masks: forbidden.extra ?? [] },
    { zone: 'agent_chat_sdk', masks: forbidden.builtIn.agentChatSdkMasks },
    { zone: 'remontnik', masks: forbidden.builtIn.remontnikMasks },
    { zone: 'dependencies', masks: ALWAYS_DEPENDENCY_MASKS },
    { zone: 'build_and_deploy', masks: ALWAYS_BUILD_AND_DEPLOY_MASKS },
    { zone: 'dependencies', masks: forbidden.allowDependencyChanges ? [] : DEFAULT_FORBIDDEN.dependencyMasks },
    {
      zone: 'build_and_deploy',
      masks: forbidden.allowBuildAndDeployChanges ? [] : [...DEFAULT_FORBIDDEN.buildAndDeployMasks, ...EXTRA_BUILD_AND_DEPLOY_MASKS],
    },
  ]
  const commandPaths = settingsCommandPaths(config)

  const hits: ForbiddenZoneHit[] = []
  for (const file of files) {
    const found = new Map<ForbiddenZone, ForbiddenZoneHit>()
    const add = (zone: ForbiddenZone, rule: string, path = file.path) => {
      if (!found.has(zone)) found.set(zone, { path, zone, rule })
    }

    const paths = file.previousPath ? [file.path, file.previousPath] : [file.path]
    for (const path of paths) {
      for (const { zone, masks } of pathRules) {
        const mask = firstMatchingMask(masks, path)
        if (mask) add(zone, mask, path)
      }
      const commandRule = commandPathRule(commandPaths, path)
      if (commandRule) add('build_and_deploy', commandRule, path)
    }

    const isManifest = paths.some((path) => matchesMask(PACKAGE_MANIFEST, path))
    const isLockOrWorkspace = paths.some((path) => matchesAnyMask([WORKSPACE_FILE, ...DEFAULT_FORBIDDEN.dependencyMasks], path))
    if ((isManifest || isLockOrWorkspace) && file.patch !== undefined) {
      const protectedHit = protectedPackageHit(config, file.patch)
      if (protectedHit) add(protectedHit.zone, protectedHit.rule)
    }

    if (isManifest) {
      const violation = forbidden.allowDependencyChanges
        ? manifestViolation(config, file)
        : { zone: 'dependencies' as const, rule: 'package.json: любая правка запрещена' }
      if (violation) add(violation.zone, violation.rule)
    }

    const schemaRule = sqlRule(config, file)
    if (schemaRule) add('schema', schemaRule)

    hits.push(...found.values())
  }
  return hits
}
