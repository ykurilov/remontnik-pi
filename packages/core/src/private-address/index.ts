import { isIPv4, isIPv6 } from 'node:net'

// Адрес частной сети: на нём слушают мост Paseo, приём врача, живой экран браузера и прокси eval.
// Имя хоста не принимается: неизвестно, куда оно разрешится. «Все адреса» (`0.0.0.0`, `::`) и публичные — тоже нет.

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
    return lower === '::1' || /^f[cd][0-9a-f]{2}:/.test(lower)
  }
  return false
}

export function assertPrivateAddress(host: string, what: string): void {
  if (!isPrivateAddress(host)) {
    throw new Error(`[remontnik] ${what}: нужен адрес частной сети (100.64.0.0/10, 10/8, 172.16/12, 192.168/16, fc00::/7, петля)`)
  }
}
