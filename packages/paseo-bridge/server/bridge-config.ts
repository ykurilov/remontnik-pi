import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { assertPrivateAddress, parseListenAddress, type ListenAddress } from './private-address.js'

// Настройка моста на компьютере владельца: какой адрес слушать и какому агенту отдавать случаи какого приложения.
// Секрет лежит в отдельном файле; в тексты ошибок ни путь, ни содержимое секрета не попадают.
// Консольной агента секрет не нужен: она читает только адрес моста и имена приложений (`loadBridgeAddressBook`).

export const DEFAULT_CONFIG_PATH = join(homedir(), '.config', 'remontnik', 'paseo-bridge.json')
export const DEFAULT_STATE_FILE = join(homedir(), '.local', 'share', 'remontnik-paseo-bridge', 'state.json')

export interface BridgeApp {
  agentId: string
  /** Адрес врача в частной сети, без косой черты в конце. */
  doctorUrl: string
  secret: string
}

export interface BridgeConfig {
  listen: ListenAddress
  apps: Map<string, BridgeApp>
}

const APP_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

function fail(message: string): never {
  throw new Error(`[remontnik] настройка моста: ${message}`)
}

function nonEmptyString(value: unknown, what: string): string {
  if (typeof value !== 'string' || value.trim() === '') fail(`${what} — пустая строка или не строка`)
  return value.trim()
}

function parseDoctorUrl(value: unknown, app: string): string {
  const text = nonEmptyString(value, `apps.${app}.doctorUrl`)
  let url: URL
  try {
    url = new URL(text)
  } catch {
    fail(`apps.${app}.doctorUrl — не адрес`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') fail(`apps.${app}.doctorUrl — только http или https`)
  assertPrivateAddress(url.hostname.replace(/^\[|\]$/g, ''), `apps.${app}.doctorUrl`)
  return `${url.protocol}//${url.host}`
}

/** Адрес моста и приложения из настройки — без чтения файлов секретов. */
export interface BridgeAddressBook {
  listen: ListenAddress
  apps: Map<string, Record<string, unknown>>
}

export function loadBridgeAddressBook(path: string = DEFAULT_CONFIG_PATH): BridgeAddressBook {
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    fail(`не удалось прочитать JSON из ${path}`)
  }
  if (raw === null || typeof raw !== 'object') fail('ожидался объект')
  const { listen, apps } = raw as { listen?: unknown; apps?: unknown }

  const address = parseListenAddress(nonEmptyString(listen, 'listen'))
  if (apps === null || typeof apps !== 'object' || Array.isArray(apps)) fail('apps — ожидался объект')

  const result = new Map<string, Record<string, unknown>>()
  for (const [name, entry] of Object.entries(apps as Record<string, unknown>)) {
    if (!APP_NAME.test(name)) fail(`имя приложения «${name.slice(0, 64)}» — только буквы, цифры, «.», «_», «-»`)
    if (entry === null || typeof entry !== 'object') fail(`apps.${name} — ожидался объект`)
    result.set(name, entry as Record<string, unknown>)
  }
  if (result.size === 0) fail('apps — нет ни одного приложения')
  return { listen: address, apps: result }
}

export function loadBridgeConfig(path: string = DEFAULT_CONFIG_PATH): BridgeConfig {
  const book = loadBridgeAddressBook(path)
  const result = new Map<string, BridgeApp>()
  for (const [name, entry] of book.apps) {
    const { agentId, doctorUrl, secretFile } = entry
    const file = nonEmptyString(secretFile, `apps.${name}.secretFile`)
    let secret: string
    try {
      secret = readFileSync(file, 'utf8').trim()
    } catch {
      fail(`apps.${name}.secretFile — файл не читается`)
    }
    if (secret === '') fail(`apps.${name}.secretFile — файл секрета пуст`)
    result.set(name, {
      agentId: nonEmptyString(agentId, `apps.${name}.agentId`),
      doctorUrl: parseDoctorUrl(doctorUrl, name),
      secret,
    })
  }
  return { listen: book.listen, apps: result }
}
