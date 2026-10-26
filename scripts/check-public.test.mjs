import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { checkPublic } from './check-public.mjs'

let root

function writeFile(relativePath, text) {
  const full = join(root, relativePath)
  mkdirSync(join(full, '..'), { recursive: true })
  writeFileSync(full, text)
}

// Опасные строки собираются из кусков, чтобы сам тест не срабатывал на проверке.
const publicIp = ['8', '8', '8', '8'].join('.')
const realDomain = ['my-app', 'cloud'].join('.')
const apiKey = 'sk' + '-' + 'a1B2c3D4e5F6g7H8i9J0k1L2'
const botToken = '1234567890' + ':' + 'AAEhBP0abcdefghijklmnopqrstuvwxyz12'
const githubToken = 'ghp' + '_' + 'a'.repeat(36)
const privateKeyHeader = '-----BEGIN ' + 'RSA PRIVATE KEY-----'

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'check-public-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('checkPublic', () => {
  it('пропускает чистый текст с example.com, .test и .invalid', () => {
    writeFile(
      'docs/a.md',
      'Пишите на admin@example.com, смотрите api.example.com, my.test, bad.invalid, 10.0.0.5, 127.0.0.1, 192.168.1.1, версия 1.4.0',
    )
    expect(checkPublic(root)).toEqual([])
  })

  it('находит публичный IPv4', () => {
    writeFile('docs/a.md', `сервер ${publicIp} живёт тут`)
    const problems = checkPublic(root)
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain('docs/a.md:1')
  })

  it('находит настоящий домен', () => {
    writeFile('src/a.ts', `const url = 'https://${realDomain}/x'`)
    expect(checkPublic(root)).toHaveLength(1)
  })

  it('не принимает имена файлов за домены', () => {
    writeFile('docs/a.md', 'смотри package.json, README.md, index.ts и check.sh')
    expect(checkPublic(root)).toEqual([])
  })

  it('не принимает обращение к полям в коде за домен', () => {
    writeFile('src/a.ts', 'const name = config.app.name; const live = options.dev.enabled')
    expect(checkPublic(root)).toEqual([])
  })

  it('пропускает известные публичные сервисы', () => {
    writeFile('README.md', 'https://github.com/x/y и https://www.npmjs.com/package/z')
    expect(checkPublic(root)).toEqual([])
  })

  it.each([
    ['ключ вида sk-', apiKey],
    ['токен бота Telegram', botToken],
    ['токен GitHub', githubToken],
    ['заголовок Bearer', 'Authorization: Bearer ' + 'abcdefghijklmnopqrstuvwxyz0123456789'],
    ['закрытый ключ', privateKeyHeader],
  ])('находит %s', (_name, secret) => {
    writeFile('src/a.ts', `const x = '${secret}'`)
    expect(checkPublic(root).length).toBeGreaterThan(0)
  })

  it('не заглядывает в node_modules, .git, .private и файл-замок', () => {
    writeFile('node_modules/x/a.js', publicIp)
    writeFile('.git/config', publicIp)
    writeFile('.private/notes.md', publicIp)
    writeFile('pnpm-lock.yaml', publicIp)
    expect(checkPublic(root)).toEqual([])
  })

  describe('частный запретный список', () => {
    it('находит слова из списка и не печатает само слово', () => {
      writeFile('docs/a.md', 'мой Секретный-Проект здесь')
      const denylistDir = mkdtempSync(join(tmpdir(), 'denylist-'))
      const denylistPath = join(denylistDir, 'denylist.txt')
      writeFileSync(denylistPath, '# комментарий\n\nсекретный-проект\n')
      const problems = checkPublic(root, { denylistPath })
      rmSync(denylistDir, { recursive: true, force: true })
      expect(problems).toHaveLength(1)
      expect(problems[0]).toContain('docs/a.md:1')
      expect(problems[0]).not.toMatch(/секретный-проект/i)
    })

    it('работает без файла списка', () => {
      writeFile('docs/a.md', 'чисто')
      expect(checkPublic(root, { denylistPath: join(root, 'нет-такого.txt') })).toEqual([])
    })
  })
})
