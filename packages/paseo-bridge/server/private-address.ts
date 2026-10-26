import { assertPrivateAddress } from '@ykurilov/remontnik-core/private-address'

// Адреса частной сети: мост слушает и ходит к врачу только по ним (FR-074). Проверка адреса — общая, из core.

export { assertPrivateAddress, isPrivateAddress } from '@ykurilov/remontnik-core/private-address'

export interface ListenAddress {
  host: string
  port: number
}

/** `100.64.0.10:7710` или `[fd7a::1]:7710` → адрес и порт; не частный адрес — ошибка. */
export function parseListenAddress(listen: string): ListenAddress {
  const match = /^(?:\[([^\]]+)\]|([^:]+)):(\d{1,5})$/.exec(listen.trim())
  if (!match) throw new Error('[remontnik] адрес моста: нужен вид «адрес:порт»')
  const host = (match[1] ?? match[2])!
  const port = Number(match[3])
  if (port > 65_535) throw new Error('[remontnik] адрес моста: порт вне диапазона')
  assertPrivateAddress(host, 'адрес моста')
  return { host, port }
}

export function hostForUrl(host: string): string {
  return host.includes(':') ? `[${host}]` : host
}
