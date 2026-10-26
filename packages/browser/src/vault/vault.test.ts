import { randomBytes } from 'node:crypto'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { VaultKeyError, createOutputFilter, openLoginVault, parseVaultKey } from './index.js'

const PASSWORD = 'vault-test-password-7f3a'

function freshVault(key = randomBytes(32)) {
  const file = join(mkdtempSync(join(tmpdir(), 'remontnik-vault-')), 'logins.json')
  return { file, key, vault: openLoginVault({ file, key }) }
}

const stdinWith = (text: string) => Readable.from([Buffer.from(text)])

describe('хранилище входов', () => {
  it('шифрует пароль AES-256-GCM и отдаёт его обратно только для вписывания', async () => {
    const { file, vault } = freshVault()
    const entry = await vault.add({ site: 'https://app.example.com', login: 'bot@example.com', profile: 'remontnik' }, stdinWith(`${PASSWORD}\n`))

    expect(entry).toEqual({ id: 1, site: 'https://app.example.com', login: 'bot@example.com', profile: 'remontnik' })
    expect(readFileSync(file, 'utf8')).not.toContain(PASSWORD)
    expect(readFileSync(file, 'utf8')).toContain('aes-256-gcm')
    expect(vault.passwordFor(entry.id).password).toBe(PASSWORD)
  })

  it('чужой ключ не открывает хранилище', async () => {
    const { file, vault } = freshVault()
    await vault.add({ site: 'https://app.example.com', login: 'bot@example.com', profile: 'remontnik' }, stdinWith(PASSWORD))

    const stranger = openLoginVault({ file, key: randomBytes(32) })
    expect(() => stranger.passwordFor(1)).toThrow(VaultKeyError)
    expect(() => stranger.list()).toThrow(VaultKeyError)
  })

  it('подмена шифротекста между входами не проходит', async () => {
    const { file, key, vault } = freshVault()
    await vault.add({ site: 'https://app.example.com', login: 'a@example.com', profile: 'remontnik' }, stdinWith('first-password'))
    await vault.add({ site: 'https://other.example.com', login: 'b@example.com', profile: 'remontnik' }, stdinWith('second-password'))
    const stored = JSON.parse(readFileSync(file, 'utf8'))
    ;[stored.entries[0].secret, stored.entries[1].secret] = [stored.entries[1].secret, stored.entries[0].secret]
    const { writeFileSync } = await import('node:fs')
    writeFileSync(file, JSON.stringify(stored))

    expect(() => openLoginVault({ file, key }).passwordFor(1)).toThrow(VaultKeyError)
  })

  it('список входов — без паролей, с отбором по сайту', async () => {
    const { vault } = freshVault()
    await vault.add({ site: 'https://app.example.com', login: 'a@example.com', profile: 'remontnik' }, stdinWith(PASSWORD))
    await vault.add({ site: 'https://shop.example.com', login: 'b@example.com', profile: 'remontnik' }, stdinWith('another-secret-1'))

    const all = vault.list()
    expect(JSON.stringify(all)).not.toContain(PASSWORD)
    expect(all.map((entry) => Object.keys(entry).sort())).toEqual([
      ['id', 'login', 'profile', 'site'],
      ['id', 'login', 'profile', 'site'],
    ])
    expect(vault.list({ site: 'https://shop.example.com' }).map((entry) => entry.login)).toEqual(['b@example.com'])
  })

  it('пароль принимается только потоком стандартного ввода, не строкой', async () => {
    const { vault } = freshVault()
    const meta = { site: 'https://app.example.com', login: 'a@example.com', profile: 'remontnik' }
    await expect(vault.add(meta, PASSWORD as never)).rejects.toThrow(/стандартного ввода/)
    await expect(vault.add(meta, stdinWith('\n'))).rejects.toThrow(/пуст/)
    expect(vault.list()).toEqual([])
  })

  it('сайт входа — только origin http(s); удаление по номеру', async () => {
    const { vault } = freshVault()
    await expect(
      vault.add({ site: 'https://app.example.com/login', login: 'a@example.com', profile: 'remontnik' }, stdinWith(PASSWORD)),
    ).rejects.toThrow(/origin/)
    const entry = await vault.add({ site: 'https://app.example.com', login: 'a@example.com', profile: 'remontnik' }, stdinWith(PASSWORD))
    expect(vault.remove(entry.id)).toBe(true)
    expect(vault.remove(entry.id)).toBe(false)
    expect(vault.list()).toEqual([])
  })

  it('ключ — ровно 32 байта в base64', () => {
    expect(parseVaultKey(randomBytes(32).toString('base64'))).toHaveLength(32)
    expect(() => parseVaultKey(randomBytes(16).toString('base64'))).toThrow(/32 байта/)
    expect(() => parseVaultKey(undefined)).toThrow(/REMONTNIK_BROWSER_VAULT_KEY/)
  })
})

describe('фильтр выхода', () => {
  it('вырезает сохранённые пароли из текста и из любых значений, в том числе в кодировках', async () => {
    const { vault } = freshVault()
    const secret = 'p@ss word/+"7'
    await vault.add({ site: 'https://app.example.com', login: 'a@example.com', profile: 'remontnik' }, stdinWith(secret))
    const filter = createOutputFilter(() => vault.knownPasswords())

    expect(filter.text(`value: ${secret}!`)).toBe('value: [пароль скрыт]!')
    expect(filter.text(`password=${encodeURIComponent(secret)}`)).not.toContain(encodeURIComponent(secret))
    const json = filter.text(JSON.stringify({ snapshot: `поле: ${secret}` }))
    expect(json).not.toContain(JSON.stringify(secret).slice(1, -1))
    expect(filter.value({ nested: [secret, { deeper: `x${secret}x` }] })).toEqual({ nested: ['[пароль скрыт]', { deeper: 'x[пароль скрыт]x' }] })
  })
})
