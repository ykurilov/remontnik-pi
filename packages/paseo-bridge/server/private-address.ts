import { isIPv4, isIPv6 } from 'node:net'

// Адреса частной сети: мост слушает и ходит к врачу только по ним (FR-074).
// Имя хоста не принимается: неизвестно, куда оно разрешится.

const PRIVATE_IPV4_RANGES: [number, number][] = [
  [ipv4ToNumber('100.64.0.0'), 10], // Tailscale и другие сети с общими адресами
  [ipv4ToNumber('10.0.0.0'), 8],
  [ipv4ToNumber('172.16.0.0'), 12],
  [ipv4ToNumber('192.168.0.0'), 16],
  [ipv4ToNumber('127.0.0.0'), 8], // петля — для проверок на своём компьютере
]

function ipv4ToNumber(ip: string): number {
  return ip.split('.').reduce((sum, part) => sum * 256 + Number(part), 0)
}

function inRange(ip: number, [base, bits]: [number, number]): boolean {
  const size = 2 ** (32 - bits)
  return Math.floor(ip / size) === Math.floor(base / size)
}

export function isPrivateAddress(host: string): boolean {
  if (isIPv4(host)) return PRIVATE_IPV4_RANGES.some((range) => inRange(ipv4ToNumber(host), range))
  if (isIPv6(host)) {
    const lower = host.toLowerCase()
    return lower === '::1' || /^fd[0-9a-f]{2}:/.test(lower)
  }
  return false
}

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

export function assertPrivateAddress(host: string, what: string): void {
  if (!isPrivateAddress(host)) {
    throw new Error(`[remontnik] ${what}: нужен адрес частной сети (100.64.0.0/10, 10/8, 172.16/12, 192.168/16, fd00::/8)`)
  }
}

export function hostForUrl(host: string): string {
  return host.includes(':') ? `[${host}]` : host
}
