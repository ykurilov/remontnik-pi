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

function paths(files: ChangedFile[], from = config): string[] {
  return findProtectedChanges(from, files).map((change) => change.path)
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

  it('флаги allow* не снимают защиту package.json, замков и сборки', () => {
    expect(paths([file('package.json'), file('pnpm-lock.yaml'), file('Dockerfile')], allowAll)).toEqual(['package.json', 'pnpm-lock.yaml', 'Dockerfile'])
  })

  it('новый тест и правка кода — можно', () => {
    expect(paths([file('test/default-plan.test.mjs', 'added'), file('src/price.mjs')])).toEqual([])
  })

  it('у каждого отказа есть причина', () => {
    const [change] = findProtectedChanges(config, [file('test/price.test.mjs')])
    expect(change?.why).toMatch(/тест/)
  })
})
