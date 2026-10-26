import { describe, expect, it } from 'vitest'
import type { ChangedFile } from '../changed-files/index.js'
import { testRemontnikConfig } from '../testing/config.js'
import { findProtectedChanges } from './protected-changes.js'

// Правка, которая трогает проверки, зависимости, сборку или сам Ремонтник, не проверяется и не отправляется:
// иначе модель могла бы подделать то, чем её проверяют.

function file(path: string, status: ChangedFile['status'] = 'modified'): ChangedFile {
  return { path, status, added: 1, removed: status === 'added' ? 0 : 1, patch: '+x\n' }
}

const config = testRemontnikConfig()
const allowAll = testRemontnikConfig({ forbidden: { schema: ['db/**'], money: ['pay/**'], access: ['auth/**'], allowDependencyChanges: true, allowBuildAndDeployChanges: true } })

function paths(files: ChangedFile[], from = config, configFiles: string[] = []): string[] {
  return findProtectedChanges(from, files, configFiles).map((change) => change.path)
}

describe('защищённые пути правки', () => {
  it.each([
    ['существующий тест', file('test/price.test.mjs')],
    ['удалённый тест', file('src/price.test.ts', 'deleted')],
    ['новый конфиг запуска тестов', file('vitest.config.ts', 'added')],
    ['конфиг playwright', file('apps/web/playwright.config.ts')],
    ['новый файл eval', file('eval/scenarios/price.json', 'added')],
    ['package.json', file('package.json')],
    ['файл-замок', file('pnpm-lock.yaml')],
    ['настройка Ремонтника', file('remontnik.config.mjs')],
    ['служебные файлы Ремонтника', file('.remontnik/deploy.lock', 'added')],
    ['файл .remontnikrc', file('.remontnikrc', 'added')],
    ['сборка', file('Dockerfile')],
    ['CI', file('.github/workflows/ci.yml', 'added')],
  ])('%s → отказ', (_what, changed) => {
    expect(paths([changed])).toEqual([changed.path])
  })

  it.each([
    ['.npmrc', file('.npmrc', 'added')],
    ['pnpm-workspace.yaml', file('pnpm-workspace.yaml')],
    ['.pnpmfile.cjs', file('.pnpmfile.cjs', 'added')],
    ['tsconfig', file('tsconfig.json')],
    ['tsconfig сборки', file('packages/app/tsconfig.build.json')],
    ['.env.test', file('.env.test', 'added')],
    ['.env внутри src', file('src/.env.local', 'added')],
    ['tsconfig внутри src', file('src/tsconfig.json', 'added')],
    ['.mocharc', file('.mocharc.yml', 'added')],
    ['babel.config', file('babel.config.js')],
    ['bunfig.toml', file('bunfig.toml', 'added')],
    ['conftest.py', file('conftest.py', 'added')],
    ['pytest.ini', file('pytest.ini')],
    ['код вне fixablePaths', file('lib/price.ts')],
    ['новый код вне fixablePaths', file('scripts/patch.mjs', 'added')],
    ['новый __mocks__ — не новый тест', file('src/__mocks__/db.ts', 'added')],
    ['новый __fixtures__ — не новый тест', file('test/__fixtures__/plans.json', 'added')],
    ['новый снимок — не новый тест', file('test/__snapshots__/price.test.ts.snap', 'added')],
    ['существующий тест Python test_*.py', file('app/test_price.py')],
    ['существующий тест Python *_test.py', file('app/price_test.py')],
    ['существующий тест Go', file('pkg/price_test.go')],
    ['существующий тест *-test', file('src/price-test.ts')],
    ['setupTests внутри src', file('src/setupTests.ts')],
    ['новый setupTests внутри src', file('src/setupTests.ts', 'added')],
    ['test-utils внутри src', file('src/test-utils.tsx')],
    ['обработчики mocks внутри src', file('src/mocks/handlers.ts', 'added')],
    ['папка testing внутри src', file('src/testing/render.ts')],
    ['globalSetup внутри src', file('src/e2e-support/globalSetup.ts', 'added')],
    ['next.config', file('next.config.mjs')],
    ['webpack', file('webpack.config.js')],
    ['rollup', file('rollup.config.mjs')],
    ['tsup', file('tsup.config.ts')],
    ['vite', file('vite.config.ts')],
    ['.swcrc', file('src/.swcrc', 'added')],
    ['.babelrc', file('.babelrc')],
    ['новый не-тест в tests/', file('tests/setup.mjs', 'added')],
    ['новый помощник в test/', file('test/helpers/db.ts', 'added')],
    ['новый не-тест в __tests__ внутри src', file('src/__tests__/helpers.ts', 'added')],
    ['новый тест с другим регистром маски', file('test/plans.TEST.ts', 'added')],
    ['код в SRC/ — другая папка на Linux', file('SRC/price.ts')],
    ['путь с обратным слэшем', file('src\\price.ts')],
  ])('%s → нужен человек', (_what, changed) => {
    expect(paths([changed])).toEqual([changed.path])
  })

  it('переименование через границу fixablePaths — нужен человек в обе стороны', () => {
    expect(paths([{ ...file('lib/price.ts', 'renamed'), previousPath: 'src/price.ts' }])).toEqual(['lib/price.ts'])
    expect(paths([{ ...file('src/price.ts', 'renamed'), previousPath: 'lib/price.ts' }])).toEqual(['src/price.ts'])
  })

  it('новые тесты по маскам тестов — можно и вне fixablePaths', () => {
    expect(paths([file('test/plans.test.ts', 'added'), file('app/test_plans.py', 'added'), file('pkg/plans_test.go', 'added'), file('src/plans-test.ts', 'added')])).toEqual([])
  })

  it('свои fixablePaths: код там — можно, src — уже нет', () => {
    const own = testRemontnikConfig({ fixablePaths: ['app/**'] })
    expect(paths([file('app/price.py')], own)).toEqual([])
    expect(paths([file('src/price.ts')], own)).toEqual(['src/price.ts'])
  })

  it('файл служб для тестов (checks.services) — всегда защищён, даже если стоит в fixablePaths', () => {
    const own = testRemontnikConfig({
      checks: { test: 'pnpm test', services: './ci/services.yml' },
      fixablePaths: ['ci/**', 'src/**'],
      forbidden: { schema: ['db/**'], money: ['pay/**'], access: ['auth/**'], allowDependencyChanges: true, allowBuildAndDeployChanges: true },
    })
    expect(paths([file('ci/services.yml')], own)).toEqual(['ci/services.yml'])
    expect(paths([file('ci/other.yml')], own)).toEqual([])
  })

  it('флаги allow* не снимают защиту package.json, замков и сборки', () => {
    expect(paths([file('package.json'), file('pnpm-lock.yaml'), file('Dockerfile')], allowAll)).toEqual(['package.json', 'pnpm-lock.yaml', 'Dockerfile'])
  })

  it('новый тест и правка кода — можно', () => {
    expect(paths([file('test/default-plan.test.mjs', 'added'), file('src/price.mjs')])).toEqual([])
  })

  it('файл, который подключает настройка, защищён и внутри fixablePaths: правка, переименование, удаление', () => {
    const configFiles = ['remontnik.config.ts', 'src/bot/description.ts']
    expect(paths([file('src/bot/description.ts')], config, configFiles)).toEqual(['src/bot/description.ts'])
    expect(paths([file('src/bot/description.ts', 'deleted')], config, configFiles)).toEqual(['src/bot/description.ts'])
    expect(paths([{ ...file('src/bot/text.ts', 'renamed'), previousPath: 'src/bot/description.ts' }], config, configFiles)).toEqual(['src/bot/text.ts'])
    expect(paths([file('src/bot/bot.ts')], config, configFiles)).toEqual([])
    const [change] = findProtectedChanges(config, [file('src/bot/description.ts')], configFiles)
    expect(change?.why).toMatch(/настройка Ремонтника/)
  })

  it('у каждого отказа есть причина', () => {
    const [change] = findProtectedChanges(config, [file('test/price.test.mjs')], [])
    expect(change?.why).toMatch(/тест/)
  })
})
