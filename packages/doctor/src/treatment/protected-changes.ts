import { DEFAULT_FORBIDDEN, type RemontnikConfig } from '@ykurilov/remontnik-core/config'
import type { ChangedFile } from '../changed-files/index.js'
import { inspectDiff, isRunnerConfigOrEvalPath, isTestOrEvalPath } from '../diff-inspector/index.js'
import { findForbiddenZones } from '../forbidden-zones/index.js'
import { firstMatchingMask, matchesAnyMask } from '../path-mask/index.js'

// Защищённые пути правки. Правка может менять только код по маскам `fixablePaths` (по умолчанию `src/**`)
// и добавлять новые тесты по маскам тестов. Всё остальное — то, чем врач проверяет правку (тесты, настройки
// их запуска, eval), то, что ставит и собирает приложение (зависимости, сборка, выкатка, настройки пакетного
// менеджера и компилятора, окружение), и сам Ремонтник — врач не проверяет и не отправляет: модель могла бы
// подделать собственную проверку. Флаги `allow*` эту защиту не снимают.

export interface ProtectedChange {
  path: string
  why: string
}

const PROTECTED_ZONES = new Set(['dependencies', 'build_and_deploy', 'remontnik'])
// Даже внутри `fixablePaths`: установка, компиляция и окружение меняют то, как идут проверки.
const TOOLCHAIN_MASKS = [
  '**/package.json',
  '**/.npmrc',
  '**/.yarnrc*',
  '**/pnpm-workspace.yaml',
  '**/.pnpmfile.cjs',
  '**/tsconfig*.json',
  '**/jsconfig*.json',
  '**/.env*',
]
const ALWAYS_PROTECTED_MASKS = [...TOOLCHAIN_MASKS, ...DEFAULT_FORBIDDEN.dependencyMasks, ...DEFAULT_FORBIDDEN.buildAndDeployMasks]
// Подставные модули, данные и снимки подменяют то, на что опираются существующие тесты: это не новый тест.
const TEST_SUPPORT_MASKS = ['**/__mocks__/**', '**/__fixtures__/**', '**/fixtures/**', '**/__snapshots__/**']

/** Новый файл теста: по маскам тестов, но не настройка запуска, не eval и не подставные данные. */
function isNewTest(file: ChangedFile): boolean {
  return file.status === 'added' && isTestOrEvalPath(file.path) && !isRunnerConfigOrEvalPath(file.path) && !matchesAnyMask(TEST_SUPPORT_MASKS, file.path)
}

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
      if (mask) add(file.path, `зависимости, сборка или окружение (${mask})`)
      if (matchesAnyMask(TEST_SUPPORT_MASKS, path)) add(file.path, 'подставные модули, данные или снимки тестов')
      if (!isNewTest(file) && !matchesAnyMask(config.fixablePaths, path)) add(file.path, `вне путей, которые можно править (${config.fixablePaths.join(', ')})`)
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
