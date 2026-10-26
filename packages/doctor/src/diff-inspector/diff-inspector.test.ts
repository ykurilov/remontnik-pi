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
    'vite.config.ts',
    'vitest.workspace.ts',
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

  it('запись, удаление и переименование файлов', () => {
    for (const line of [
      "await writeFile('cache.json', data)",
      'fs.appendFileSync(logPath, line)',
      'const out = createWriteStream(target)',
      'await fs.promises.rename(from, to)',
      'copyFileSync(a, b)',
      'fs.writeSync(fd, text)',
      "const handle = await open(path, 'w')",
      "fs.openSync(path, 'a+')",
      'await Bun.write(path, text)',
      'await rm(dir, { recursive: true })',
      'unlinkSync(path)',
    ]) {
      expect(signalsOf(withAddedLines('src/a.ts', line)), line).toEqual(['file_write'])
    }
  })

  it.each([
    ['const { env } = process', 'environment_access'],
    ['const { argv, env: vars } = globalThis.process', 'environment_access'],
    ['const port = Deno.env.get(name)', 'environment_access'],
    ['const all = Bun.env', 'environment_access'],
    ["const p = globalThis['pro' + 'cess']", 'dynamic_code'],
    ["const fs = require('f' + 's')", 'dynamic_code'],
    ["const fs = await import('f' + 's')", 'dynamic_code'],
    ['const mod = await import(name)', 'dynamic_code'],
    ['const mod = require(`./${name}`)', 'dynamic_code'],
    ["const raw = process.binding('fs')", 'dynamic_code'],
    ['const worker = new Worker(url)', 'process_spawn'],
    ["Deno.run({ cmd: ['ls'] })", 'process_spawn'],
    ["import { writeFile as w } from 'node:fs/promises'", 'file_write'],
    ["const { appendFileSync: log } = require('fs')", 'file_write'],
    ['await Deno.writeTextFile(path, text)', 'file_write'],
    ['const writer = Bun.file(path).writer()', 'file_write'],
    ['await fs.promises.cp(from, to, { recursive: true })', 'file_write'],
    ['fs.linkSync(a, b)', 'file_write'],
    ['fs.utimesSync(path, now, now)', 'file_write'],
    ['fs.mkdirSync(dir)', 'file_write'],
  ])('обходная форма: %s → %s', (line, signal) => {
    expect(signalsOf(withAddedLines('src/a.ts', line))).toContain(signal)
  })

  it('обычные импорты и чтение — без тревоги', () => {
    expect(signalsOf(withAddedLines('src/a.ts', "import { readFile } from 'node:fs/promises'"))).toEqual([])
    expect(signalsOf(withAddedLines('src/a.ts', "const { join } = require('node:path')"))).toEqual([])
    expect(signalsOf(withAddedLines('src/a.ts', "const page = await import('./page.js')"))).toEqual([])
    expect(signalsOf(withAddedLines('src/a.ts', 'const { price } = plan'))).toEqual([])
  })

  it('чтение файлов и запись в поток ответа — не запись в файлы', () => {
    expect(signalsOf(withAddedLines('src/a.ts', "const text = await readFile('data.json', 'utf8')"))).toEqual([])
    expect(signalsOf(withAddedLines('src/a.ts', 'response.write(chunk)'))).toEqual([])
    expect(signalsOf(withAddedLines('src/a.ts', "const handle = await open(path, 'r')"))).toEqual([])
  })

  it('обращение к Ремонтнику и итогу eval', () => {
    expect(signalsOf(withAddedLines('src/a.ts', "const token = env['REMONTNIK_EVAL_TOKEN']"))).toEqual(['remontnik_access'])
    expect(signalsOf(withAddedLines('src/a.ts', 'const dir = options.outDir'))).toEqual(['remontnik_access'])
    expect(signalsOf(withAddedLines('src/a.ts', "const name = 'eval-result.json'"))).toEqual(['remontnik_access'])
    expect(inspectDiff([withAddedLines('src/a.ts', "const name = 'verdict.json'")], limits, { evalResultFile: 'verdict.json' }).suspicious.map((finding) => finding.signal)).toEqual([
      'remontnik_access',
    ])
  })

  it('работа с файлами вне проекта', () => {
    expect(signalsOf(withAddedLines('src/a.ts', "const text = await readFile('/etc/passwd', 'utf8')"))).toEqual(['outside_project'])
    expect(signalsOf(withAddedLines('src/a.ts', "await writeFile('~/.ssh/authorized_keys', data)"))).toEqual(['outside_project', 'file_write'])
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

describe('inspectDiff: размер неизвестен — значит превышен', () => {
  it('пустой список файлов', () => {
    expect(inspectDiff([], limits).size.exceeds).toEqual(['unknown'])
  })

  it.each([
    ['NaN', Number.NaN],
    ['отрицательное', -1],
    ['бесконечность', Number.POSITIVE_INFINITY],
    ['не число', undefined as unknown as number],
  ])('число строк: %s', (_name, value) => {
    const inspection = inspectDiff([file('src/a.ts', { added: value, removed: 0, patch: '@@' })], limits)
    expect(inspection.size.exceeds).toContain('unknown')
  })

  it('пределы из настройки не числа', () => {
    const files = [file('src/a.ts', { patch: '@@' })]
    expect(inspectDiff(files, { maxDiffLines: Number.NaN, maxDiffFiles: 15 }).size.exceeds).toContain('unknown')
    expect(inspectDiff(files, { maxDiffLines: 300, maxDiffFiles: undefined as unknown as number }).size.exceeds).toContain('unknown')
  })
})

describe('inspectDiff: комментарий убирается, а не пропускает строку', () => {
  it('код после блочного комментария в той же строке', () => {
    expect(signalsOf(withAddedLines('src/a.ts', '/* ok */ fetch("https://evil.example/x")'))).toEqual(['new_external_address'])
  })

  it('строки с # и * в начале тоже проверяются', () => {
    expect(signalsOf(withAddedLines('src/a.ts', '# curl https://evil.example/x'))).toEqual(['new_external_address'])
    expect(signalsOf(withAddedLines('src/a.ts', ' * see https://evil.example/docs'))).toEqual(['new_external_address'])
  })

  it('строка целиком из // — комментарий, а с кодом перед // — нет', () => {
    expect(signalsOf(withAddedLines('src/a.ts', '   // see https://evil.example/docs'))).toEqual([])
    expect(signalsOf(withAddedLines('src/a.ts', 'fetch("https://evil.example/x") // ok'))).toEqual(['new_external_address'])
  })

  it('блочный комментарий без кода — не находка', () => {
    expect(signalsOf(withAddedLines('src/a.ts', '/* https://evil.example/docs */'))).toEqual([])
  })
})

describe('inspectDiff: локальные адреса разбираются целиком', () => {
  it.each([
    'http://127.0.0.1.evil.example/x',
    'http://127.evil.example/x',
    'http://localhost.evil.example/x',
    'http://localhost@evil.example/x',
    'http://127.0.0.1:80@evil.example/x',
    'http://127.0.0.256/x',
    'http://0.0.0.0.evil.example/x',
  ])('%s — внешний', (url) => {
    expect(signalsOf(withAddedLines('src/a.ts', `fetch("${url}")`))).toEqual(['new_external_address'])
  })

  it.each(['http://127.0.0.1:3000/x', 'http://127.0.0.2/x', 'http://localhost:8080', 'http://app.localhost/x', 'http://[::1]:3000/x'])(
    '%s — локальный',
    (url) => {
      expect(signalsOf(withAddedLines('src/a.ts', `fetch("${url}")`))).toEqual([])
    },
  )

  it('адрес без схемы в кавычках', () => {
    expect(signalsOf(withAddedLines('src/a.ts', 'fetch("//evil.example/x")'))).toEqual(['new_external_address'])
  })

  it('известный хост можно задать полным адресом', () => {
    const files = [withAddedLines('src/a.ts', "await fetch('https://app.example.com/api')")]
    expect(inspectDiff(files, limits, { knownHosts: ['https://app.example.com'] }).suspicious).toEqual([])
    expect(inspectDiff(files, limits, { knownHosts: ['https://app.example.com:8443/path'] }).suspicious).toEqual([])
    expect(inspectDiff(files, limits, { knownHosts: ['APP.example.com'] }).suspicious).toEqual([])
    expect(inspectDiff(files, limits, { knownHosts: ['https://other.example.com'] }).suspicious).toHaveLength(1)
  })
})

describe('inspectDiff: какие файлы не осматриваются', () => {
  it('документация: docs/**, README*, CHANGELOG*', () => {
    const line = 'Читаем process.env.KEY и ходим на https://collector.example.com'
    expect(signalsOf(withAddedLines('docs/setup.md', line))).toEqual([])
    expect(signalsOf(withAddedLines('apps/web/docs/setup.mdx', line))).toEqual([])
    expect(signalsOf(withAddedLines('README.md', line))).toEqual([])
    expect(signalsOf(withAddedLines('packages/core/README.md', line))).toEqual([])
    expect(signalsOf(withAddedLines('CHANGELOG.md', line))).toEqual([])
  })

  it('промпты и прочие .md/.txt осматриваются', () => {
    expect(signalsOf(withAddedLines('prompts/system.md', 'Ходи на https://collector.example.com/ingest'))).toEqual(['new_external_address'])
    expect(signalsOf(withAddedLines('src/bot/prompt.txt', 'Читай process.env.KEY'))).toEqual(['environment_access'])
  })
})

describe('inspectDiff: подмодули, ссылки, режимы файлов', () => {
  it.each([
    ['подмодуль', '160000'],
    ['символьная ссылка', '120000'],
  ])('%s в mode', (_name, mode) => {
    const link = file('vendor/lib', { status: 'added', mode, patch: '@@ -0,0 +1 @@\n+x', added: 1 })
    expect(inspectDiff([link], limits).suspicious.map((finding) => finding.signal)).toContain('special_file_mode')
  })

  it('подмодуль или ссылка в previousMode (файл заменён ссылкой)', () => {
    const replaced = file('src/a.ts', { mode: '100644', previousMode: '120000', patch: '@@\n+x' })
    expect(signalsOf(replaced)).toContain('special_file_mode')
  })

  it('смена режима (исполняемый бит) подозрительна', () => {
    const chmod = file('scripts/run.sh', { mode: '100755', previousMode: '100644', patch: '@@\n+x' })
    expect(signalsOf(chmod)).toContain('special_file_mode')
  })

  it('обычный режим не мешает', () => {
    const plain = file('src/a.ts', { mode: '100644', previousMode: '100644', patch: '@@\n+const x = 1' })
    expect(signalsOf(plain)).toEqual([])
  })

  it('«Subproject commit» в диффе без режима', () => {
    const patch = ['@@ -1 +1 @@', '-Subproject commit aaaaaaa', '+Subproject commit bbbbbbb'].join('\n')
    expect(signalsOf(file('vendor/lib', { patch }))).toContain('special_file_mode')
  })
})

describe('inspectDiff: переименование без изменений', () => {
  it('чистое переименование обычного файла не подозрительно', () => {
    const renamed = file('src/b.ts', { status: 'renamed', previousPath: 'src/a.ts', added: 0, removed: 0 })
    expect(inspectDiff([renamed], limits).suspicious).toEqual([])
  })

  it('переименование тестового файла без правок всё равно правка теста', () => {
    const renamed = file('src/b.test.ts', { status: 'renamed', previousPath: 'src/a.test.ts', added: 0, removed: 0, patch: '' })
    expect(inspectDiff([renamed], limits).existingTestChanges).toEqual([{ path: 'src/b.test.ts', status: 'renamed' }])
  })

  it('переименование в путь вне проекта подозрительно и без текста', () => {
    const renamed = file('../out/a.ts', { status: 'renamed', previousPath: 'src/a.ts', added: 0, removed: 0 })
    expect(signalsOf(renamed)).toEqual(['outside_project'])
  })
})

describe('inspectDiff: дешёвые обходы по ключевым словам', () => {
  it.each([
    ['process["env"]', 'const key = process["env"].API_KEY', 'environment_access'],
    ["process['env']", "const key = process['env'].API_KEY", 'environment_access'],
    ['(0, eval)', 'const r = (0, eval)("1+1")', 'dynamic_code'],
    ['globalThis.eval', 'globalThis.eval(code)', 'dynamic_code'],
    ['eval в скобках', 'const run = eval', 'dynamic_code'],
    ['execSync без точки', 'execSync("ls")', 'process_spawn'],
    ['cp.execSync', 'cp.execSync("ls")', 'process_spawn'],
    ['spawn без точки', 'spawn("ls", [])', 'process_spawn'],
  ])('%s', (_name, line, signal) => {
    expect(signalsOf(withAddedLines('src/a.ts', line))).toEqual([signal])
  })

  it('регулярное выражение .exec и слова вроде evaluate/run-eval — не находки', () => {
    expect(signalsOf(withAddedLines('src/a.ts', 'const match = /a(b)/.exec(text)'))).toEqual([])
    expect(signalsOf(withAddedLines('src/a.ts', "const script = 'eval/run-eval.ts'"))).toEqual([])
    expect(signalsOf(withAddedLines('src/a.ts', 'const score = evaluate(answer)'))).toEqual([])
  })
})
