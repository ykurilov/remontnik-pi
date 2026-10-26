import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createGitGuard } from '../git-guard/index.js'
import { collectConfigFiles, configFilesAt, configFilesOfFix } from './index.js'

// Файлы настройки по тексту, без выполнения: список, который шлюз правки защищает и на основе, и на правке.

function reader(files: Record<string, string>) {
  return async (path: string) => files[path]
}

describe('collectConfigFiles: что подключает настройка', () => {
  it('импорт, реэкспорт, импорт без имён, динамический импорт и require строкой — с вложенными', async () => {
    const found = await collectConfigFiles(
      'remontnik.config.ts',
      reader({
        'remontnik.config.ts': `import { a } from './src/a.ts'\nexport * from "./src/b.ts"\nimport './side.ts'\nconst c = await import('./lazy/c.ts')\nexport default { a, c }\n`,
        'src/a.ts': `import { nested } from '../shared/nested.ts'\nexport const a = nested\n`,
        'src/b.ts': 'export const b = 1\n',
        'side.ts': `const x = require('./cjs/x.cjs')\n`,
        'lazy/c.ts': `import data from './data.json' with { type: 'json' }\nexport default data\n`,
        'lazy/data.json': '{"from": "./not-an-import.ts"}',
        'shared/nested.ts': 'export const nested = 1\n',
        'cjs/x.cjs': 'module.exports = 1\n',
        'not-an-import.ts': 'export {}\n',
      }),
    )
    expect(found).toEqual({
      files: ['cjs/x.cjs', 'lazy/c.ts', 'lazy/data.json', 'remontnik.config.ts', 'shared/nested.ts', 'side.ts', 'src/a.ts', 'src/b.ts'],
      problems: [],
    })
  })

  it('пакеты и модули Node — не файлы репозитория; несуществующий файл пропускается', async () => {
    const found = await collectConfigFiles(
      'remontnik.config.ts',
      reader({ 'remontnik.config.ts': `import { defineRemontnikConfig } from '@ykurilov/remontnik-core/config'\nimport { join } from 'node:path'\nimport './missing.ts'\n` }),
    )
    expect(found).toEqual({ files: ['remontnik.config.ts'], problems: [] })
  })

  it('строка, похожая на импорт, в комментарии — лишний файл в списке (защищён), а не пропуск', async () => {
    const found = await collectConfigFiles('remontnik.config.ts', reader({ 'remontnik.config.ts': `// import './src/old.ts'\nexport default {}\n`, 'src/old.ts': '' }))
    expect(found.files).toEqual(['remontnik.config.ts', 'src/old.ts'])
  })

  it('ближайший package.json задаёт тип модулей — он тоже в списке', async () => {
    const found = await collectConfigFiles(
      'remontnik.config.ts',
      reader({ 'remontnik.config.ts': `import './apps/web/x.ts'\n`, 'apps/web/x.ts': '', 'apps/web/package.json': '{}', 'package.json': '{"type":"module"}' }),
    )
    expect(found.files).toEqual(['apps/web/package.json', 'apps/web/x.ts', 'package.json', 'remontnik.config.ts'])
  })

  it('выход за пределы репозитория и абсолютный путь — ошибки', async () => {
    const found = await collectConfigFiles(
      'remontnik.config.ts',
      reader({ 'remontnik.config.ts': `import '../outside.ts'\nimport '/etc/x.ts'\nimport 'file:///etc/y.ts'\n` }),
    )
    expect(found.problems).toEqual([
      'remontnik.config.ts: импорт ../outside.ts ведёт за пределы репозитория',
      'remontnik.config.ts: импорт /etc/x.ts — абсолютный путь; свои файлы подключайте по относительному пути',
      'remontnik.config.ts: импорт file:///etc/y.ts — абсолютный путь; свои файлы подключайте по относительному пути',
    ])
  })

  it('JSON-настройка ничего не подключает', async () => {
    expect(await collectConfigFiles('remontnik.config.json', reader({ 'remontnik.config.json': '{"x": "./src/a.ts"}', 'src/a.ts': '' }))).toEqual({
      files: ['remontnik.config.json'],
      problems: [],
    })
  })
})

describe('configFilesAt: файлы настройки на ревизии по git', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  function repo() {
    const root = mkdtempSync(join(tmpdir(), 'remontnik-config-files-'))
    dirs.push(root)
    const repoDir = join(root, 'main')
    mkdirSync(repoDir)
    const git = (...args: string[]) =>
      execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd: repoDir, encoding: 'utf8' }).trim()
    git('init', '--quiet', '--initial-branch=main')
    const write = (path: string, content: string) => {
      mkdirSync(dirname(join(repoDir, path)), { recursive: true })
      writeFileSync(join(repoDir, path), content)
    }
    const commit = (message: string) => {
      git('add', '-A')
      git('commit', '--quiet', '-m', message)
      return git('rev-parse', 'HEAD')
    }
    const guard = createGitGuard({ repoDir, worktreesDir: join(root, 'worktrees'), mainBranch: 'main', mainline: 'merge', author: { name: 'Ремонтник', email: 'doctor@example.invalid' } })
    return { write, commit, guard }
  }

  it('по тексту коммита, а не рабочей копии; правка добавила импорт — новый файл тоже в списке', async () => {
    const r = repo()
    r.write('remontnik.config.ts', `import { TEXT } from './src/bot/description.ts'\nexport default { TEXT }\n`)
    r.write('src/bot/description.ts', `export const TEXT = 'x'\n`)
    r.write('src/bot/plans.ts', `export const PLANS = []\n`)
    const base = r.commit('основа')
    r.write('src/bot/description.ts', `import { PLANS } from './plans.ts'\nexport const TEXT = String(PLANS)\n`)
    const head = r.commit('правка')
    r.write('src/bot/description.ts', `export const TEXT = 'не в коммите'\n`)

    expect(await configFilesAt(r.guard, base)).toEqual(['remontnik.config.ts', 'src/bot/description.ts'])
    expect(await configFilesAt(r.guard, head)).toEqual(['remontnik.config.ts', 'src/bot/description.ts', 'src/bot/plans.ts'])
    expect(await configFilesOfFix(r.guard, base, head)).toEqual(['remontnik.config.ts', 'src/bot/description.ts', 'src/bot/plans.ts'])
  })

  it('нет файла настройки — пустой список', async () => {
    const r = repo()
    r.write('src/a.ts', '')
    expect(await configFilesAt(r.guard, r.commit('без настройки'))).toEqual([])
  })
})
