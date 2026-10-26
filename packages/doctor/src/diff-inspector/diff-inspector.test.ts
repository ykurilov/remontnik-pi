import { describe, expect, it } from 'vitest'
import type { ChangedFile } from '../changed-files/index.js'
import { inspectDiff, type SuspiciousSignal } from './index.js'

const limits = { maxDiffLines: 300, maxDiffFiles: 15 }

function file(path: string, extra: Partial<ChangedFile> = {}): ChangedFile {
  return { path, status: 'modified', added: 1, removed: 0, ...extra }
}

function withAddedLines(path: string, ...lines: string[]): ChangedFile {
  const patch = ['@@ -1,1 +1,2 @@', ' context', ...lines.map((line) => `+${line}`)].join('\n')
  return file(path, { patch, added: lines.length })
}

function signalsOf(...files: ChangedFile[]): SuspiciousSignal[] {
  return inspectDiff(files, limits).suspicious.map((finding) => finding.signal)
}

describe('inspectDiff: существующие тесты и eval', () => {
  it('новый тест, новый сценарий eval и новая рубрика — можно', () => {
    const inspection = inspectDiff(
      [
        file('src/bot/greeting.test.ts', { status: 'added' }),
        file('eval/scenarios/refund.json', { status: 'added' }),
        file('eval/rubrics/politeness.md', { status: 'added' }),
        file('src/bot/greeting.ts'),
      ],
      limits,
    )
    expect(inspection.existingTestChanges).toEqual([])
  })

  it.each([
    'src/bot/greeting.test.ts',
    'src/bot/greeting.spec.tsx',
    'test/cycle/us1.test.ts',
    'packages/core/tests/helpers.ts',
    'src/__tests__/setup.ts',
    'src/__snapshots__/page.snap',
    'eval/scenarios/refund.json',
    'eval/run-eval.ts',
    'evals/rubrics/politeness.md',
    'eval/judges/strict-judge.ts',
    'src/quality-rubric.md',
    'vitest.config.ts',
    'apps/web/playwright.config.ts',
  ])('изменение существующего %s ловится', (path) => {
    const inspection = inspectDiff([file(path)], limits)
    expect(inspection.existingTestChanges).toEqual([{ path, status: 'modified' }])
  })

  it('удаление существующего теста ловится', () => {
    const inspection = inspectDiff([file('src/bot/greeting.test.ts', { status: 'deleted', removed: 40, added: 0 })], limits)
    expect(inspection.existingTestChanges).toEqual([{ path: 'src/bot/greeting.test.ts', status: 'deleted' }])
  })

  it('переименование теста — это правка существующего теста', () => {
    const renamed = file('src/bot/hello.test.ts', { status: 'renamed', previousPath: 'src/bot/greeting.test.ts' })
    expect(inspectDiff([renamed], limits).existingTestChanges).toEqual([
      { path: 'src/bot/hello.test.ts', status: 'renamed' },
    ])
  })

  it('переименование обычного файла в тест — не правка существующего теста', () => {
    const renamed = file('src/bot/new.test.ts', { status: 'renamed', previousPath: 'src/bot/draft.ts' })
    expect(inspectDiff([renamed], limits).existingTestChanges).toEqual([])
  })

  it('обычный код не считается тестом', () => {
    expect(inspectDiff([file('src/bot/greeting.ts'), file('src/contest.ts'), file('src/attest/index.ts')], limits).existingTestChanges).toEqual([])
  })
})

describe('inspectDiff: подозрительное в добавленных строках', () => {
  it('process.env и import.meta.env', () => {
    expect(signalsOf(withAddedLines('src/a.ts', 'const key = process.env.API_KEY'))).toEqual(['environment_access'])
    expect(signalsOf(withAddedLines('src/a.ts', 'const key = import.meta.env.VITE_KEY'))).toEqual(['environment_access'])
  })

  it('новый внешний адрес', () => {
    const findings = inspectDiff([withAddedLines('src/a.ts', "await fetch('https://collector.example.com/ingest')")], limits).suspicious
    expect(findings).toEqual([
      { path: 'src/a.ts', signal: 'new_external_address', line: "await fetch('https://collector.example.com/ingest')" },
    ])
  })

  it('внешний адрес по IP без схемы', () => {
    expect(signalsOf(withAddedLines('src/a.ts', "const host = '203.0.113.7:8080'"))).toEqual(['new_external_address'])
  })

  it('локальные адреса и адреса в комментариях — не новые внешние', () => {
    expect(signalsOf(withAddedLines('src/a.ts', "const url = 'http://localhost:3000/health'"))).toEqual([])
    expect(signalsOf(withAddedLines('src/a.ts', "const url = 'http://127.0.0.1:3000'"))).toEqual([])
    expect(signalsOf(withAddedLines('src/a.ts', '// подробности: https://example.com/docs'))).toEqual([])
  })

  it('адрес, который уже был в файле (есть среди убранных строк), не новый', () => {
    const patch = [
      '@@ -1,1 +1,1 @@',
      "-const url = 'https://api.example.com/v1/chat'",
      "+const url = 'https://api.example.com/v1/chat?stream=1'",
    ].join('\n')
    expect(signalsOf(file('src/a.ts', { patch }))).toEqual([])
  })

  it('адрес из списка известных хостов настройки не новый', () => {
    const files = [withAddedLines('src/a.ts', "await fetch('https://app.example.com/api')")]
    expect(inspectDiff(files, limits, { knownHosts: ['app.example.com'] }).suspicious).toEqual([])
  })

  it('запуск процессов', () => {
    expect(signalsOf(withAddedLines('src/a.ts', "import { exec } from 'node:child_process'"))).toEqual(['process_spawn'])
    expect(signalsOf(withAddedLines('src/a.ts', "const { spawn } = require('child_process')"))).toEqual(['process_spawn'])
    expect(signalsOf(withAddedLines('src/a.ts', "Bun.spawn(['ls'])"))).toEqual(['process_spawn'])
  })

  it('eval и динамический код', () => {
    expect(signalsOf(withAddedLines('src/a.ts', 'const result = eval(code)'))).toEqual(['dynamic_code'])
    expect(signalsOf(withAddedLines('src/a.ts', "const run = new Function('a', 'return a')"))).toEqual(['dynamic_code'])
    expect(signalsOf(withAddedLines('src/a.ts', "import vm from 'node:vm'"))).toEqual(['dynamic_code'])
  })

  it('слово evaluate — не eval', () => {
    expect(signalsOf(withAddedLines('src/a.ts', 'const score = evaluate(answer)'))).toEqual([])
  })

  it('работа с файлами вне проекта', () => {
    expect(signalsOf(withAddedLines('src/a.ts', "const text = await readFile('/etc/passwd', 'utf8')"))).toEqual(['outside_project'])
    expect(signalsOf(withAddedLines('src/a.ts', "await writeFile('~/.ssh/authorized_keys', data)"))).toEqual(['outside_project'])
    expect(signalsOf(withAddedLines('src/a.ts', "await readFile('../../other-app/.env')"))).toEqual(['outside_project'])
    expect(signalsOf(withAddedLines('src/a.ts', 'const home = os.homedir()'))).toEqual(['outside_project'])
  })

  it('обычные относительные импорты — не выход за проект', () => {
    expect(signalsOf(withAddedLines('src/a.ts', "import { x } from '../../shared/x.js'"))).toEqual([])
    expect(signalsOf(withAddedLines('src/a.ts', "const { x } = require('../shared/x.js')"))).toEqual([])
  })

  it('сам путь файла вне проекта', () => {
    const outside = [
      withAddedLines('../other-app/src/a.ts', 'const x = 1'),
      { ...withAddedLines('/etc/hosts', '127.0.0.1 example'), status: 'added' as const },
    ]
    const findings = inspectDiff(outside, limits).suspicious
    expect(findings.map((finding) => [finding.path, finding.signal])).toEqual([
      ['../other-app/src/a.ts', 'outside_project'],
      ['/etc/hosts', 'outside_project'],
    ])
  })

  it('смотрит только добавленные строки: контекст и убранные не в счёт', () => {
    const patch = [
      '@@ -1,2 +1,1 @@',
      ' const key = process.env.OLD_KEY',
      '-const other = process.env.REMOVED',
      '+const other = 1',
    ].join('\n')
    expect(signalsOf(file('src/a.ts', { patch }))).toEqual([])
  })

  it('строка заголовка +++ не считается добавленной', () => {
    const patch = ['--- a/src/a.ts', '+++ b/src/process.env.ts', '@@ -1,1 +1,1 @@', '-x', '+y'].join('\n')
    expect(signalsOf(file('src/a.ts', { patch }))).toEqual([])
  })

  it('в документах (.md) сигналы не ищутся', () => {
    expect(signalsOf(withAddedLines('docs/setup.md', 'Читаем process.env.KEY и вызываем https://collector.example.com'))).toEqual([])
  })

  it('двоичный или слишком большой файл без диффа — проверить нечем', () => {
    const findings = inspectDiff([file('assets/logo.png', { status: 'added' })], limits).suspicious
    expect(findings).toEqual([{ path: 'assets/logo.png', signal: 'patch_unavailable', line: '' }])
  })

  it('удалённый файл без диффа подозрения не вызывает', () => {
    expect(signalsOf(file('src/old.ts', { status: 'deleted', added: 0, removed: 12 }))).toEqual([])
  })

  it('каждая находка несёт путь и строку', () => {
    const [finding] = inspectDiff([withAddedLines('src/a.ts', 'const key = process.env.API_KEY')], limits).suspicious
    expect(finding).toEqual({ path: 'src/a.ts', signal: 'environment_access', line: 'const key = process.env.API_KEY' })
  })
})

describe('inspectDiff: размер', () => {
  function sizedFile(index: number, lines: number): ChangedFile {
    return file(`src/file-${index}.ts`, { added: lines, removed: 0, patch: '@@' })
  }

  it('в пределах — не слишком большой', () => {
    const files = Array.from({ length: 15 }, (_, index) => sizedFile(index, 20))
    expect(inspectDiff(files, limits).size).toEqual({ files: 15, lines: 300, exceeds: [] })
  })

  it('больше 300 строк (добавленные + убранные)', () => {
    const files = [file('src/a.ts', { added: 200, removed: 101, patch: '@@' })]
    expect(inspectDiff(files, limits).size).toEqual({ files: 1, lines: 301, exceeds: ['lines'] })
  })

  it('больше 15 файлов', () => {
    const files = Array.from({ length: 16 }, (_, index) => sizedFile(index, 1))
    expect(inspectDiff(files, limits).size).toEqual({ files: 16, lines: 16, exceeds: ['files'] })
  })

  it('пределы берутся из настройки', () => {
    const files = [file('src/a.ts', { added: 11, removed: 0, patch: '@@' })]
    expect(inspectDiff(files, { maxDiffLines: 10, maxDiffFiles: 15 }).size.exceeds).toEqual(['lines'])
  })

  it('превышены оба предела', () => {
    const files = Array.from({ length: 16 }, (_, index) => sizedFile(index, 30))
    expect(inspectDiff(files, limits).size.exceeds).toEqual(['lines', 'files'])
  })
})
