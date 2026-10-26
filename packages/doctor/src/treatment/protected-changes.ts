import { DEFAULT_FORBIDDEN, type RemontnikConfig } from '@ykurilov/remontnik-core/config'
import type { ChangedFile } from '../changed-files/index.js'
import { inspectDiff, isRunnerConfigOrEvalPath, TEST_FILE_MASKS } from '../diff-inspector/index.js'
import { findForbiddenZones } from '../forbidden-zones/index.js'
import { firstMatchingMask, matchesAllowMask, matchesAnyMask } from '../path-mask/index.js'

// Защищённые пути правки. Правка может менять только код по маскам `fixablePaths` (по умолчанию `src/**`)
// и добавлять новые тесты по маскам тестов. Всё остальное — то, чем врач проверяет правку (тесты, настройки
// их запуска, eval), то, что ставит и собирает приложение (зависимости, сборка, выкатка, настройки пакетного
// менеджера и компилятора, окружение), и сам Ремонтник — врач не проверяет и не отправляет: модель могла бы
// подделать собственную проверку. Флаги `allow*` эту защиту не снимают. Белый список (`fixablePaths`, маски
// файлов тестов) различает регистр и не принимает путь с `\`.

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
  // Сборка: её подхватывают и тесты.
  '**/next.config.*',
  '**/webpack.*',
  '**/rollup.*',
  '**/tsup.*',
  '**/vite.*',
  '**/.swcrc',
  '**/.babelrc*',
]
const ALWAYS_PROTECTED_MASKS = [...TOOLCHAIN_MASKS, ...DEFAULT_FORBIDDEN.dependencyMasks, ...DEFAULT_FORBIDDEN.buildAndDeployMasks]
// Обвязка тестов — подставные модули, данные, снимки, подготовка — подменяет то, на что опираются
// существующие тесты: это не новый тест, даже внутри `fixablePaths`.
const TEST_SUPPORT_MASKS = [
  '**/__mocks__/**',
  '**/__fixtures__/**',
  '**/fixtures/**',
  '**/__snapshots__/**',
  '**/mocks/**',
  '**/testing/**',
  '**/setupTests.*',
  '**/test-utils.*',
  '**/globalSetup.*',
]
// В папках тестов можно только добавить файл теста; любой другой файл там — обвязка.
const TEST_DIR_MASKS = ['**/test/**', '**/tests/**', '**/__tests__/**', '**/e2e/**']

/** Новый файл теста: по маске файла теста, но не настройка запуска, не eval и не обвязка. */
function isNewTest(file: ChangedFile): boolean {
  return file.status === 'added' && matchesAllowMask(TEST_FILE_MASKS, file.path) && !isRunnerConfigOrEvalPath(file.path) && !matchesAnyMask(TEST_SUPPORT_MASKS, file.path)
}

/** `configFiles` — файлы, которые подключает настройка на основе и на правке (`config-files`). */
export function findProtectedChanges(config: RemontnikConfig, files: readonly ChangedFile[], configFiles: readonly string[]): ProtectedChange[] {
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
      if (matchesAnyMask(TEST_SUPPORT_MASKS, path)) add(file.path, 'обвязка тестов: подставные модули, данные, снимки, подготовка')
      if (!isNewTest(file) && matchesAnyMask(TEST_DIR_MASKS, path)) add(file.path, 'в папке тестов, но не новый файл теста')
      if (!isNewTest(file) && !matchesAllowMask(config.fixablePaths, path)) add(file.path, `вне путей, которые можно править (${config.fixablePaths.join(', ')})`)
    }
  }
  for (const hit of findForbiddenZones(config, files, configFiles)) {
    if (PROTECTED_ZONES.has(hit.zone)) add(hit.path, `зона ${hit.zone} (${hit.rule})`)
  }
  return files.flatMap((file) => {
    const why = found.get(file.path) ?? (file.previousPath ? found.get(file.previousPath) : undefined)
    return why ? [{ path: file.path, why }] : []
  })
}
