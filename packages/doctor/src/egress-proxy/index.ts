import { lookup as dnsLookup } from 'node:dns/promises'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import { BlockList, connect, isIP, type AddressInfo, type Socket } from 'node:net'

// Прокси выхода для контейнеров верстака. Модель врача и установка зависимостей сидят во внутренней сети Docker
// без шлюза: наружу у них один путь — этот прокси. Он пропускает только туннель (`CONNECT`) к именам из белого
// списка (реестр пакетов) и только на разрешённые порты. Имя разрешает сам прокси; если хоть один адрес имени —
// не публичный (локальная сеть, петля, метаданные облака), отказ. Соединение идёт на проверенный адрес, а не
// на имя: подмена ответа DNS между проверкой и соединением ничего не даёт. Адреса вместо имён не принимаются.

export interface EgressProxyOptions {
  /** Где слушать: адрес прокси во внутренней сети верстака. */
  listen: { host: string; port: number }
  /** Имена, куда можно: точное `registry.npmjs.org` или `*.example.com` (только поддомены). */
  allowedHosts: readonly string[]
  /** Порты туннеля; по умолчанию только 443. */
  allowedPorts?: readonly number[]
  /** Для проверок: подменить разрешение имён. */
  lookup?: (host: string) => Promise<readonly { address: string; family: number }[]>
  /** Для проверок: подменить соединение с проверенным адресом. */
  dial?: (address: string, port: number) => Socket
  connectTimeoutMs?: number
  /** Туннель без движения дольше — закрывается. */
  idleTimeoutMs?: number
  maxConnections?: number
  log?: (line: string) => void
}

export interface EgressProxy {
  url: string
  close(): Promise<void>
}

const CONNECT_TIMEOUT_MS = 15_000
const IDLE_TIMEOUT_MS = 300_000
const MAX_CONNECTIONS = 256
const HOST_NAME = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/

// Всё, что не интернет: частные сети, петля, метаданные облака (169.254/16), общие адреса операторов, служебные,
// документационные, групповые и зарезервированные диапазоны.
const NOT_PUBLIC = new BlockList()
for (const [network, bits] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 3],
] as const) {
  NOT_PUBLIC.addSubnet(network, bits, 'ipv4')
}
for (const [network, bits] of [
  ['::', 96], // неуказанный, петля и устаревшие адреса со вложенным IPv4
  ['64:ff9b::', 96], // NAT64: внутри может быть любой IPv4
  ['64:ff9b:1::', 48],
  ['100::', 64],
  ['2001::', 23],
  ['2001:db8::', 32],
  ['2002::', 16], // 6to4: внутри может быть любой IPv4
  ['fc00::', 7],
  ['fe80::', 10],
  ['fec0::', 10],
  ['ff00::', 8],
] as const) {
  NOT_PUBLIC.addSubnet(network, bits, 'ipv6')
}

/** Адрес в открытом интернете. IPv4, вложенный в IPv6 (`::ffff:a.b.c.d`), проверяется как IPv4. */
export function isPublicAddress(address: string): boolean {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address)?.[1]
  if (mapped) return isPublicAddress(mapped)
  const family = isIP(address)
  if (family === 0) return false
  return !NOT_PUBLIC.check(address, family === 4 ? 'ipv4' : 'ipv6')
}

/** Имя из белого списка: регистр и точка в конце не важны; `*.x` — только поддомены `x`. */
export function isAllowedHost(host: string, allowedHosts: readonly string[]): boolean {
  const name = host.toLowerCase().replace(/\.$/, '')
  if (!HOST_NAME.test(name)) return false
  return allowedHosts.some((allowed) => {
    const mask = allowed.toLowerCase()
    return mask.startsWith('*.') ? name.endsWith(mask.slice(1)) && name.length > mask.length - 1 : name === mask
  })
}

/** Цель туннеля `host:port`. Адреса вместо имён (и IPv6 в скобках) не принимаются. */
function connectTarget(raw: string | undefined): { host: string; port: number } | undefined {
  const match = /^([^:[\]/@\s]+):(\d{1,5})$/.exec(raw ?? '')
  if (!match) return undefined
  const port = Number(match[2])
  if (port < 1 || port > 65_535 || isIP(match[1]!) !== 0) return undefined
  return { host: match[1]!.toLowerCase().replace(/\.$/, ''), port }
}

async function defaultLookup(host: string): Promise<readonly { address: string; family: number }[]> {
  return dnsLookup(host, { all: true, verbatim: true })
}

export async function startEgressProxy(options: EgressProxyOptions): Promise<EgressProxy> {
  for (const allowed of options.allowedHosts) {
    if (!isAllowedHost(allowed.replace(/^\*\./, ''), [allowed.replace(/^\*\./, '')])) throw new Error(`прокси выхода: «${allowed}» — не имя хоста`)
  }
  const allowedPorts = options.allowedPorts ?? [443]
  const lookup = options.lookup ?? defaultLookup
  const dial = options.dial ?? ((host: string, port: number) => connect({ host, port }))
  const log = options.log ?? (() => {})
  const connectTimeoutMs = options.connectTimeoutMs ?? CONNECT_TIMEOUT_MS
  const idleTimeoutMs = options.idleTimeoutMs ?? IDLE_TIMEOUT_MS
  const tunnels = new Set<Socket>()

  const refuse = (client: Socket, status: number, text: string, what: string) => {
    log(`[прокси выхода] отказ ${status}: ${what} — ${text}`)
    client.end(`HTTP/1.1 ${status} ${text}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`)
  }

  async function tunnel(request: IncomingMessage, client: Socket, head: Buffer): Promise<void> {
    tunnels.add(client)
    client.on('close', () => tunnels.delete(client))
    client.on('error', () => {})
    const target = connectTarget(request.url)
    if (!target) return refuse(client, 400, 'Bad Request', String(request.url))
    const what = `${target.host}:${target.port}`
    if (!allowedPorts.includes(target.port)) return refuse(client, 403, 'Forbidden', what)
    if (!isAllowedHost(target.host, options.allowedHosts)) return refuse(client, 403, 'Forbidden', what)
    let addresses: readonly { address: string; family: number }[]
    try {
      addresses = await lookup(target.host)
    } catch {
      return refuse(client, 502, 'Bad Gateway', `${what} (имя не разрешилось)`)
    }
    // Хоть один внутренний адрес у разрешённого имени — подмена: отказ целиком, а не выбор «хорошего».
    if (addresses.length === 0 || addresses.some(({ address }) => !isPublicAddress(address))) {
      return refuse(client, 403, 'Forbidden', `${what} (адрес не в интернете)`)
    }
    const upstream = dial(addresses[0]!.address, target.port)
    let established = false
    tunnels.add(upstream)
    upstream.on('close', () => tunnels.delete(upstream))
    upstream.setTimeout(connectTimeoutMs, () => upstream.destroy(new Error(established ? 'туннель простаивал' : 'нет соединения')))
    upstream.on('error', () => {
      if (established) client.destroy()
      else refuse(client, 502, 'Bad Gateway', `${what} (не соединился)`)
    })
    upstream.once('connect', () => {
      established = true
      upstream.setTimeout(idleTimeoutMs)
      client.setTimeout(idleTimeoutMs, () => client.destroy())
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (head.length > 0) upstream.write(head)
      upstream.pipe(client)
      client.pipe(upstream)
      client.once('close', () => upstream.destroy())
      upstream.once('close', () => client.destroy())
    })
  }

  // Обычные запросы (`GET http://…`) не пропускаются: реестру хватает туннеля, а открытого HTTP-прокси нам не нужно.
  const server: Server = createServer((request, response) => {
    log(`[прокси выхода] отказ 405: ${request.method} ${request.url} — только CONNECT`)
    response.writeHead(405, { allow: 'CONNECT', 'content-type': 'text/plain; charset=utf-8' })
    response.end('прокси выхода пропускает только CONNECT')
  })
  server.maxConnections = options.maxConnections ?? MAX_CONNECTIONS
  server.on('connect', (request: IncomingMessage, client: Socket, head: Buffer) => {
    tunnel(request, client, head).catch(() => client.destroy())
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.listen.port, options.listen.host, () => {
      server.off('error', reject)
      resolve()
    })
  })
  const { address, port } = server.address() as AddressInfo
  return {
    url: `http://${address.includes(':') ? `[${address}]` : address}:${port}`,
    close() {
      return new Promise<void>((resolve) => {
        for (const socket of tunnels) socket.destroy()
        server.close(() => resolve())
        server.closeAllConnections()
      })
    },
  }
}
