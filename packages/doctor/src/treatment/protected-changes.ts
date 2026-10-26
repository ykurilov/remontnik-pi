import { DEFAULT_FORBIDDEN, type RemontnikConfig } from '@ykurilov/remontnik-core/config'
import type { ChangedFile } from '../changed-files/index.js'
import { inspectDiff, isRunnerConfigOrEvalPath } from '../diff-inspector/index.js'
import { findForbiddenZones } from '../forbidden-zones/index.js'
import { firstMatchingMask } from '../path-mask/index.js'

// Защищённые пути правки: то, чем врач проверяет правку (тесты, настройки их запуска, eval), то, что ставит
// и собирает приложение (зависимости, сборка, выкатка), и сам Ремонтник. Такую правку врач не проверяет
// и не отправляет: модель могла бы подделать собственную проверку. Флаги `allow*` эту защиту не снимают.

export interface ProtectedChange {
  path: string
  why: string
}

const PROTECTED_ZONES = new Set(['dependencies', 'build_and_deploy', 'remontnik'])
const ALWAYS_PROTECTED_MASKS = ['**/package.json', ...DEFAULT_FORBIDDEN.dependencyMasks, ...DEFAULT_FORBIDDEN.buildAndDeployMasks]

export function findProtectedChanges(config: RemontnikConfig, files: readonly ChangedFile[]): ProtectedChange[] {
  const found = new Map<string, string>()
  const add = (path: string, why: string) => {
    if (!found.has(path)) found.set(path, why)
  }
  for (const change of inspectDiff(files, config.limits).existingTestChanges) add(change.path, `существующий тест или eval (${change.status})`)
  for (const file of files) {
    for (const path of file.previousPath ? [file.path, file.previousPath] : [file.path]) {
      if (isRunnerConfigOrEvalPath(path)) add(file.path, 'настройка запуска тестов или файл eval')
      const mask = firstMatchingMask(ALWAYS_PROTECTED_MASKS, path)
      if (mask) add(file.path, `зависимости или сборка (${mask})`)
    }
  }
  for (const hit of findForbiddenZones(config, files)) {
    if (PROTECTED_ZONES.has(hit.zone)) add(hit.path, `зона ${hit.zone} (${hit.rule})`)
  }
  return files.flatMap((file) => {
    const why = found.get(file.path) ?? (file.previousPath ? found.get(file.previousPath) : undefined)
    return why ? [{ path: file.path, why }] : []
  })
}
