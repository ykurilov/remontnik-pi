import { DEFAULT_FORBIDDEN, type ResolvedForbidden } from '@ykurilov/remontnik-core/config'
import { changedLinesOf, type ChangedFile } from '../changed-files/index.js'
import { firstMatchingMask, matchesAnyMask, matchesMask } from '../path-mask/index.js'

// Запретные зоны (конституция III, R7): правка в них никогда не выкатывается сама.
// Проверка — кодом, по маскам путей и признакам в диффе; модель на неё не влияет.

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

const PACKAGE_MANIFEST = '**/package.json'
const WORKSPACE_FILE = '**/pnpm-workspace.yaml'
const DEPENDENCY_SECTION_LINE = /"(?:dependencies|devDependencies|peerDependencies|optionalDependencies|patchedDependencies|overrides|resolutions)"/
const DEPENDENCY_ENTRY_LINE = /^\s*"[^"]+"\s*:\s*"(?:[\^~<>=*v]*\d|[\^~<>=*]|workspace:|npm:|file:|link:|git\+|git:|github:|https?:|catalog:|latest)[^"]*"|\.patch"/
const PACKAGE_NAME = /@[\w.-]+\/[\w.-]+/g

function zoneOfProtectedPackage(pattern: string): ForbiddenZone {
  return pattern.startsWith('@ykurilov/agent-chat-') ? 'agent_chat_sdk' : 'remontnik'
}

function changedLineTexts(patch: string): string[] {
  const { added, removed } = changedLinesOf(patch)
  return [...added, ...removed]
}

function protectedPackageHit(forbidden: ResolvedForbidden, patch: string): { zone: ForbiddenZone; rule: string } | undefined {
  for (const line of changedLineTexts(patch)) {
    for (const name of line.match(PACKAGE_NAME) ?? []) {
      const pattern = forbidden.builtIn.protectedPackages.find((candidate) => matchesMask(candidate, name))
      if (pattern) return { zone: zoneOfProtectedPackage(pattern), rule: `пакет ${pattern}` }
    }
  }
  return undefined
}

function touchesDependencies(patch: string): boolean {
  return changedLineTexts(patch).some((line) => DEPENDENCY_SECTION_LINE.test(line) || DEPENDENCY_ENTRY_LINE.test(line))
}

function schemaSignalRule(forbidden: ResolvedForbidden, file: ChangedFile): string | undefined {
  if (!matchesAnyMask(forbidden.builtIn.schemaSignalFiles, file.path)) return undefined
  if (file.patch === undefined) return 'SQL без диффа: изменения схемы проверить нечем'
  const signal = forbidden.builtIn.schemaSignals.find((candidate) =>
    changedLineTexts(file.patch as string).some((line) => candidate.test(line)),
  )
  return signal ? `признак схемы ${signal.source}` : undefined
}

/**
 * Файлы правки, попавшие в запретные зоны. Пустой список — правка вне зон.
 * Маски: настройка приложения + встроенные запреты (их нельзя снять) + запреты по умолчанию, если приложение их не сняло.
 */
export function findForbiddenZones(forbidden: ResolvedForbidden, files: readonly ChangedFile[]): ForbiddenZoneHit[] {
  const pathRules: Array<{ zone: ForbiddenZone; masks: readonly string[] }> = [
    { zone: 'schema', masks: forbidden.schema },
    { zone: 'money', masks: forbidden.money },
    { zone: 'access', masks: [...forbidden.access, ...forbidden.builtIn.accessMasks] },
    { zone: 'app_extra', masks: forbidden.extra ?? [] },
    { zone: 'agent_chat_sdk', masks: forbidden.builtIn.agentChatSdkMasks },
    { zone: 'remontnik', masks: forbidden.builtIn.remontnikMasks },
    { zone: 'dependencies', masks: forbidden.allowDependencyChanges ? [] : DEFAULT_FORBIDDEN.dependencyMasks },
    { zone: 'build_and_deploy', masks: forbidden.allowBuildAndDeployChanges ? [] : DEFAULT_FORBIDDEN.buildAndDeployMasks },
  ]

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
    }

    const manifestOrLock =
      matchesAnyMask([PACKAGE_MANIFEST, WORKSPACE_FILE, ...DEFAULT_FORBIDDEN.dependencyMasks], file.path)
    if (manifestOrLock && file.patch !== undefined) {
      const protectedHit = protectedPackageHit(forbidden, file.patch)
      if (protectedHit) add(protectedHit.zone, protectedHit.rule)
    }

    if (!forbidden.allowDependencyChanges && matchesMask(PACKAGE_MANIFEST, file.path)) {
      if (file.patch === undefined) add('dependencies', 'package.json без диффа: зависимости проверить нечем')
      else if (touchesDependencies(file.patch)) add('dependencies', 'зависимости в package.json')
    }

    const schemaRule = schemaSignalRule(forbidden, file)
    if (schemaRule) add('schema', schemaRule)

    hits.push(...found.values())
  }
  return hits
}
