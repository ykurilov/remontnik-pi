// Хранилище сохранённых входов: пароли зашифрованы AES-256-GCM ключом из окружения контейнера браузера.
// Пароль приходит только потоком стандартного ввода и уходит только в поле пароля (fill-password).
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export { createOutputFilter, type OutputFilter } from './output-filter.js'

const ALGORITHM = 'aes-256-gcm'
const KEY_CHECK_TEXT = 'remontnik-browser-vault'

export class VaultKeyError extends Error {
  constructor() {
    super('ключ REMONTNIK_BROWSER_VAULT_KEY не подходит к хранилищу входов')
  }
}

export interface LoginSummary {
  id: number
  site: string
  login: string
  profile: string
}

interface Sealed {
  iv: string
  tag: string
  data: string
}

interface StoredEntry extends LoginSummary {
  createdAt: string
  secret: Sealed
}

interface StoredVault {
  format: 1
  algorithm: typeof ALGORITHM
  keyCheck: Sealed
  nextId: number
  entries: StoredEntry[]
}

export function parseVaultKey(base64: string | undefined): Buffer {
  if (!base64) throw new Error('REMONTNIK_BROWSER_VAULT_KEY не задан: нужен ключ 32 байта в base64')
  const key = Buffer.from(base64, 'base64')
  if (key.length !== 32) throw new Error('REMONTNIK_BROWSER_VAULT_KEY: нужно ровно 32 байта в base64')
  return key
}

export const loginVaultPath = (dataDir: string) => join(dataDir, 'logins.json')

function seal(key: Buffer, plain: string, context: string): Sealed {
  const iv = randomBytes(12)
  const cipher = createCipheriv(ALGORITHM, key, iv)
  cipher.setAAD(Buffer.from(context))
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  return { iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') }
}

function unseal(key: Buffer, sealed: Sealed, context: string): string {
  try {
    const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(sealed.iv, 'base64'))
    decipher.setAAD(Buffer.from(context))
    decipher.setAuthTag(Buffer.from(sealed.tag, 'base64'))
    return Buffer.concat([decipher.update(Buffer.from(sealed.data, 'base64')), decipher.final()]).toString('utf8')
  } catch {
    throw new VaultKeyError()
  }
}

// Шифротекст привязан к своему входу: перенос его к другому сайту или профилю не расшифруется.
const entryContext = ({ id, site, profile, login }: LoginSummary) => `${id}\n${site}\n${profile}\n${login}`

function siteOrigin(site: string): string {
  try {
    const url = new URL(site)
    if ((url.protocol === 'https:' || url.protocol === 'http:') && url.origin === site) return site
  } catch {
    // ниже — понятная ошибка
  }
  throw new Error(`--site: ожидается origin вида https://app.example.com, получено «${site}»`)
}

/** Читает пароль из потока стандартного ввода; убирается только перевод строки в конце. */
export async function readPasswordFromStdin(input: AsyncIterable<Uint8Array | string>): Promise<string> {
  if (input === null || typeof input !== 'object' || typeof (input as AsyncIterable<unknown>)[Symbol.asyncIterator] !== 'function') {
    throw new TypeError('пароль принимается только из стандартного ввода (--password-stdin)')
  }
  const chunks: Buffer[] = []
  for await (const chunk of input) chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : Buffer.from(chunk))
  const password = Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '')
  if (password === '') throw new Error('пароль пуст: передайте его в стандартный ввод')
  return password
}

export interface LoginVault {
  list(filter?: { site?: string }): LoginSummary[]
  add(entry: Omit<LoginSummary, 'id'>, passwordInput: AsyncIterable<Uint8Array | string>): Promise<LoginSummary>
  remove(id: number): boolean
  /** Только для вписывания в поле пароля самим браузером. */
  passwordFor(id: number): { entry: LoginSummary; password: string }
  /** Все сохранённые пароли — для фильтра выхода. */
  knownPasswords(): string[]
}

const summary = ({ id, site, login, profile }: LoginSummary): LoginSummary => ({ id, site, login, profile })

export function openLoginVault(options: { file: string; key: Buffer }): LoginVault {
  const { file, key } = options
  if (key.length !== 32) throw new Error('ключ хранилища входов — ровно 32 байта')

  // Файл читается заново на каждый вызов: консольная команда может добавить вход, пока служба работает.
  function load(): StoredVault {
    if (!existsSync(file)) return { format: 1, algorithm: ALGORITHM, keyCheck: seal(key, KEY_CHECK_TEXT, 'key-check'), nextId: 1, entries: [] }
    const stored = JSON.parse(readFileSync(file, 'utf8')) as StoredVault
    if (unseal(key, stored.keyCheck, 'key-check') !== KEY_CHECK_TEXT) throw new VaultKeyError()
    return stored
  }

  function save(vault: StoredVault): void {
    mkdirSync(dirname(file), { recursive: true })
    const temporary = `${file}.${process.pid}.tmp`
    writeFileSync(temporary, `${JSON.stringify(vault, null, 2)}\n`, { mode: 0o600 })
    renameSync(temporary, file)
  }

  function find(vault: StoredVault, id: number): StoredEntry {
    const entry = vault.entries.find((candidate) => candidate.id === id)
    if (!entry) throw Object.assign(new Error(`вход ${id} не найден`), { code: 'not_found' })
    return entry
  }

  return {
    list({ site: wanted } = {}) {
      return load()
        .entries.filter(({ site }) => wanted === undefined || site === wanted)
        .map(summary)
    },
    async add(entry, passwordInput) {
      const password = await readPasswordFromStdin(passwordInput)
      const site = siteOrigin(entry['site'])
      if (entry.login.trim() === '' || entry.profile.trim() === '') throw new Error('нужны --login и --profile')
      const vault = load()
      const created: LoginSummary = { id: vault.nextId, site, login: entry.login, profile: entry.profile }
      vault.entries.push({ ...created, createdAt: new Date().toISOString(), secret: seal(key, password, entryContext(created)) })
      vault.nextId += 1
      save(vault)
      return created
    },
    remove(id) {
      const vault = load()
      const before = vault.entries.length
      vault.entries = vault.entries.filter((entry) => entry.id !== id)
      if (vault.entries.length === before) return false
      save(vault)
      return true
    },
    passwordFor(id) {
      const entry = find(load(), id)
      return { entry: summary(entry), password: unseal(key, entry.secret, entryContext(entry)) }
    },
    knownPasswords() {
      return load().entries.map((entry) => unseal(key, entry.secret, entryContext(entry)))
    },
  }
}
