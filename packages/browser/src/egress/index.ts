// Выход браузера в сеть: весь трафик Chromium службы идёт через этот прокси внутри службы, и сетевой замок
// решает здесь, а не скриптом в странице — скрипт страницы до этой границы не достаёт. Видно, куда соединение:
// для http:// — точный origin, для туннеля (https, WebSocket, TURN по TCP) — хост и порт. Пока замок закрыт,
// соединения на адреса вне разрешённых не открываются, а уже открытые туннели и запросы туда рвутся.
// Внутренние адреса (петля, частные сети, link-local, CGNAT, адрес метаданных облака) закрыты всегда, кроме
// разрешённых сайтов: имя проверяется после разрешения, и соединение идёт на тот самый проверенный адрес.
// Прокси пускает только со своим случайным паролем. Дальше трафик идёт прямо или через прокси профиля.
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { lookup as dnsLookup } from 'node:dns/promises'
import { createServer, request as httpRequest, type IncomingMessage, type RequestOptions, type ServerResponse } from 'node:http'
import { connect, isIP, type AddressInfo, type Socket } from 'node:net'

export interface EgressTarget {
  /** Имя хоста без квадратных скобок IPv6, в нижнем регистре. */
  host: string
  port: number
  /** Для запроса `http://` — его origin; у туннеля схемы не видно. */
  origin?: string
}

export interface UpstreamProxy {
  server: string
  username?: string
  password?: string
}

export interface EgressProxy {
  /** Адрес для `--proxy-server` Chromium. */
  readonly url: string
  /** Пароль на прокси, свой на каждый запуск: без него — `407`. */
  readonly username: string
  readonly password: string
  /** Рвёт открытые туннели и запросы, которые сейчас уже не разрешены (замок только что закрылся). */
  dropRefused(): void
  close(): Promise<void>
}

export type RefusalReason = 'locked' | 'internal'

export interface EgressOptions {
  /** Можно ли соединиться с адресом сейчас: решение замка. */
  allows(target: EgressTarget): boolean
  /** Разрешённый сайт: ему можно и на внутренний адрес. */
  exempt(target: EgressTarget): boolean
  onRefused(target: EgressTarget, reason: RefusalReason): void
  upstream?: UpstreamProxy
  /** Внутренние `адрес:порт` (IPv6 — в скобках), куда можно и вне разрешённых сайтов: для тестов. */
  reachableInternal?: readonly string[]
  /** Разрешение имён; по умолчанию — системное. */
  lookup?: (host: string) => Promise<string[]>
  /** Срок на разрешение имени, подключение и рукопожатие с прокси профиля. */
  connectTimeoutMs?: number
}

const DEFAULT_PORTS: Record<string, number> = { 'http:': 80, 'https:': 443 }
const CONNECT_TIMEOUT_MS = 15_000

/** Адрес из разрешённых origin: для запроса http:// — точный origin, для туннеля — тот же хост и порт. */
export function isAllowedTarget(target: EgressTarget, allowedOrigins: readonly string[]): boolean {
  if (target.origin !== undefined) return allowedOrigins.includes(target.origin)
  return allowedOrigins.some((allowed) => {
    const url = new URL(allowed)
    const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase()
    return host === target.host && (Number(url.port) || DEFAULT_PORTS[url.protocol]) === target.port
  })
}

export function describeTarget(target: EgressTarget): string {
  return target.origin ?? `${target.host.includes(':') ? `[${target.host}]` : target.host}:${target.port}`
}

// --- Внутренние адреса ---

function ipv4Bytes(ip: string): number[] {
  return ip.split('.').map(Number)
}

/** 16 байт адреса IPv6, в том числе с IPv4 в конце (`::ffff:10.0.0.1`); зона (`%en0`) отбрасывается. */
function ipv6Bytes(ip: string): number[] {
  let text = ip.split('%')[0]!
  let tail: number[] = []
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(text)
  if (dotted) {
    tail = ipv4Bytes(dotted[1]!)
    text = text.slice(0, -dotted[1]!.length)
    if (!text.endsWith('::')) text = text.slice(0, -1)
  }
  const groups = (part: string) => (part === '' ? [] : part.split(':'))
  const double = text.indexOf('::')
  const left = groups(double === -1 ? text : text.slice(0, double))
  const right = double === -1 ? [] : groups(text.slice(double + 2))
  const middle = double === -1 ? [] : Array<string>(8 - tail.length / 2 - left.length - right.length).fill('0')
  return [...[...left, ...middle, ...right].flatMap((group) => [parseInt(group, 16) >> 8, parseInt(group, 16) & 0xff]), ...tail]
}

const inRange = (bytes: number[], base: number[], prefix: number) => {
  for (let bit = 0; bit < prefix; bit += 1) {
    const mask = 0x80 >> bit % 8
    if ((bytes[bit >> 3]! & mask) !== (base[bit >> 3]! & mask)) return false
  }
  return true
}

const INTERNAL_V4: [string, number][] = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 4], ['240.0.0.0', 4],
]
const INTERNAL_V6: [string, number][] = [
  ['::', 128], ['::1', 128], ['100::', 64], ['2001::', 32], ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8],
]
/** IPv6 с адресом IPv4 внутри: префикс и с какого байта лежит IPv4. */
const EMBEDDED_V4: [string, number, number][] = [
  ['::ffff:0:0', 96, 12], ['::', 96, 12], ['64:ff9b::', 96, 12], ['64:ff9b:1::', 48, 12], ['2002::', 16, 2],
]

/** Петля, частные сети, link-local, CGNAT, служебные и групповые адреса — и они же внутри IPv6. */
export function isInternalAddress(ip: string): boolean {
  if (isIP(ip) === 4) {
    const bytes = ipv4Bytes(ip)
    return INTERNAL_V4.some(([base, prefix]) => inRange(bytes, ipv4Bytes(base), prefix))
  }
  if (isIP(ip.split('%')[0]!) !== 6) return true
  const bytes = ipv6Bytes(ip)
  if (INTERNAL_V6.some(([base, prefix]) => inRange(bytes, ipv6Bytes(base), prefix))) return true
  return EMBEDDED_V4.some(([base, prefix, at]) => inRange(bytes, ipv6Bytes(base), prefix) && isInternalAddress(bytes.slice(at, at + 4).join('.')))
}

function isLoopback(ip: string): boolean {
  if (isIP(ip) === 4) return ip.startsWith('127.')
  const bytes = ipv6Bytes(ip)
  return bytes.every((byte, index) => byte === (index === 15 ? 1 : 0)) || (inRange(bytes, ipv6Bytes('::ffff:0:0'), 96) && bytes[12] === 127)
}

const addressKey = (ip: string, port: number) => `${isIP(ip.split('%')[0]!) === 6 ? `[${ip}]` : ip}:${port}`

// --- Соединение дальше ---

function proxyUrl(upstream: UpstreamProxy): URL {
  return new URL(upstream.server.includes('://') ? upstream.server : `http://${upstream.server}`)
}

const isSocks = (upstream: UpstreamProxy) => proxyUrl(upstream).protocol.startsWith('socks')

function basicAuth(upstream: UpstreamProxy): string | undefined {
  if (upstream.username === undefined) return undefined
  return `Basic ${Buffer.from(`${upstream.username}:${upstream.password ?? ''}`).toString('base64')}`
}

/** Сокет до `host:port`: прямо, через CONNECT к http-прокси профиля или через socks5. Срок и отмена — `signal`. */
async function openTunnel(host: string, port: number, upstream: UpstreamProxy | undefined, signal: AbortSignal): Promise<Socket> {
  const proxy = upstream && proxyUrl(upstream)
  const socket = proxy ? connect(Number(proxy.port) || (isSocks(upstream!) ? 1080 : 80), proxy.hostname.replace(/^\[|\]$/g, '')) : connect(port, host)
  socket.on('error', () => {})
  const abort = () => socket.destroy()
  if (signal.aborted) abort()
  signal.addEventListener('abort', abort, { once: true })
  try {
    await connected(socket)
    if (upstream) await (isSocks(upstream) ? socksHandshake(socket, host, port, upstream) : httpConnect(socket, host, port, upstream))
    return socket
  } catch (error) {
    socket.destroy()
    throw error
  } finally {
    signal.removeEventListener('abort', abort)
  }
}

function connected(socket: Socket): Promise<void> {
  return new Promise((resolve, reject) => {
    const fail = () => reject(new Error('соединение не открыто'))
    socket.once('connect', () => {
      socket.off('error', fail)
      socket.off('close', fail)
      resolve()
    })
    socket.once('error', fail)
    socket.once('close', fail)
  })
}

/** Ждёт ответ прокси профиля: `done` говорит, сколько байт ответа уже есть; остаток возвращается в поток. */
function readReply(socket: Socket, done: (buffer: Buffer) => number | null): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0)
    const onData = (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk])
      const used = done(buffer)
      if (used === null) return
      cleanup()
      if (used < buffer.length) socket.unshift(buffer.subarray(used))
      resolve(buffer.subarray(0, used))
    }
    const onEnd = () => {
      cleanup()
      reject(new Error('прокси профиля закрыл соединение'))
    }
    const cleanup = () => {
      socket.off('data', onData)
      for (const event of ['end', 'error', 'close']) socket.off(event, onEnd)
    }
    socket.on('data', onData)
    for (const event of ['end', 'error', 'close']) socket.on(event, onEnd)
  })
}

async function httpConnect(socket: Socket, host: string, port: number, upstream: UpstreamProxy): Promise<void> {
  const authority = addressKey(host, port)
  const auth = basicAuth(upstream)
  socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n${auth ? `Proxy-Authorization: ${auth}\r\n` : ''}\r\n`)
  const head = await readReply(socket, (buffer) => {
    const end = buffer.indexOf('\r\n\r\n')
    return end === -1 ? null : end + 4
  })
  if (!/^HTTP\/1\.[01] 2\d\d/.test(head.toString('latin1'))) throw new Error('прокси профиля отказал в соединении')
}

/** Адрес назначения socks5: IPv4 и IPv6 — адресом (ATYP 1 и 4), остальное — именем (ATYP 3). */
function socksAddress(host: string): Buffer {
  if (isIP(host) === 4) return Buffer.from([1, ...ipv4Bytes(host)])
  if (isIP(host.split('%')[0]!) === 6) return Buffer.from([4, ...ipv6Bytes(host)])
  const name = Buffer.from(host)
  return Buffer.concat([Buffer.from([3, name.length]), name])
}

async function socksHandshake(socket: Socket, host: string, port: number, upstream: UpstreamProxy): Promise<void> {
  const withAuth = upstream.username !== undefined
  socket.write(Buffer.from(withAuth ? [5, 1, 2] : [5, 1, 0]))
  const method = await readReply(socket, (buffer) => (buffer.length >= 2 ? 2 : null))
  if (method[0] !== 5 || method[1] !== (withAuth ? 2 : 0)) throw new Error('socks5: способ входа не принят')
  if (withAuth) {
    const user = Buffer.from(upstream.username ?? '')
    const password = Buffer.from(upstream.password ?? '')
    socket.write(Buffer.concat([Buffer.from([1, user.length]), user, Buffer.from([password.length]), password]))
    const status = await readReply(socket, (buffer) => (buffer.length >= 2 ? 2 : null))
    if (status[1] !== 0) throw new Error('socks5: имя или пароль не приняты')
  }
  socket.write(Buffer.concat([Buffer.from([5, 1, 0]), socksAddress(host), Buffer.from([port >> 8, port & 0xff])]))
  const reply = await readReply(socket, (buffer) => {
    if (buffer.length < 5) return null
    const length = buffer[3] === 1 ? 4 : buffer[3] === 4 ? 16 : 1 + buffer[4]!
    return buffer.length >= 4 + length + 2 ? 4 + length + 2 : null
  })
  if (reply[1] !== 0) throw new Error('socks5: соединение не открыто')
}

function withDeadline<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new Error('срок вышел'))
    if (signal.aborted) return abort()
    signal.addEventListener('abort', abort, { once: true })
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
  })
}

type Admission = { ok: true; host: string } | { ok: false; status: 403 | 502 }

export async function startEgressProxy(options: EgressOptions): Promise<EgressProxy> {
  const username = randomBytes(8).toString('hex')
  const password = randomBytes(24).toString('hex')
  const expectedAuth = Buffer.from(`Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`)
  const authorized = (request: IncomingMessage) => {
    const given = Buffer.from(request.headers['proxy-authorization'] ?? '')
    return given.length === expectedAuth.length && timingSafeEqual(given, expectedAuth)
  }
  const lookup = options.lookup ?? (async (host: string) => (await dnsLookup(host, { all: true, verbatim: true })).map((entry) => entry.address))
  const timeoutMs = options.connectTimeoutMs ?? CONNECT_TIMEOUT_MS
  const reachable = new Set(options.reachableInternal ?? [])
  const upstream = options.upstream
  // Прокси профиля на своей машине или в частной сети видит наши внутренние адреса: имена тогда разрешаем сами.
  const upstreamHost = upstream && proxyUrl(upstream).hostname.replace(/^\[|\]$/g, '')
  const resolveHere = !upstreamHost || upstreamHost === 'localhost' || (isIP(upstreamHost) !== 0 && isInternalAddress(upstreamHost))
  let ownPort = 0

  /** Можно ли на этот адрес: внутренний — только если явно разрешён; петля на порт самого прокси — никогда. */
  const reachableAddress = (ip: string, port: number) =>
    !(isLoopback(ip) && port === ownPort) && (!isInternalAddress(ip) || reachable.has(addressKey(ip, port)))

  const refuse = (target: EgressTarget, reason: RefusalReason): Admission => {
    options.onRefused(target, reason)
    return { ok: false, status: 403 }
  }

  /** Решение о соединении и адрес, на который идти: проверенный IP, а не имя, которое могут переразрешить. */
  async function admit(target: EgressTarget, signal: AbortSignal): Promise<Admission> {
    if (!options.allows(target)) return refuse(target, 'locked')
    const literal = isIP(target.host) !== 0
    if (options.exempt(target) && !(target.port === ownPort && (target.host === 'localhost' || (literal && isLoopback(target.host))))) {
      return { ok: true, host: target.host }
    }
    if (literal) return reachableAddress(target.host, target.port) ? { ok: true, host: target.host } : refuse(target, 'internal')
    if (!resolveHere) return { ok: true, host: target.host }
    let addresses: string[]
    try {
      addresses = await withDeadline(lookup(target.host), signal)
    } catch {
      return { ok: false, status: 502 }
    }
    const usable = addresses.find((address) => reachableAddress(address, target.port))
    if (usable) return { ok: true, host: usable }
    return addresses.length > 0 ? refuse(target, 'internal') : { ok: false, status: 502 }
  }

  /** Открытые соединения с адресом: туннели и запросы http:// в работе. */
  const open = new Map<{ destroy(): void }, EgressTarget>()
  const track = (connection: { destroy(): void; once(event: 'close', listener: () => void): unknown }, target: EgressTarget) => {
    open.set(connection, target)
    connection.once('close', () => open.delete(connection))
  }
  /** Срок на подготовку соединения; закрылся клиент — неготовое соединение рвётся сразу. */
  const deadline = (client: { once(event: 'close', listener: () => void): unknown }) => {
    const closed = new AbortController()
    client.once('close', () => closed.abort())
    return AbortSignal.any([closed.signal, AbortSignal.timeout(timeoutMs)])
  }

  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    if (!authorized(request)) {
      response.writeHead(407, { 'proxy-authenticate': 'Basic realm="remontnik"' }).end()
      return
    }
    let url: URL
    try {
      url = new URL(request.url ?? '')
    } catch {
      response.writeHead(400).end()
      return
    }
    if (url.protocol !== 'http:') {
      response.writeHead(400).end()
      return
    }
    const target: EgressTarget = { host: url.hostname.replace(/^\[|\]$/g, '').toLowerCase(), port: Number(url.port) || 80, origin: url.origin }
    track(response, target)
    const signal = deadline(response)
    void admit(target, signal).then((admission) => {
      if (response.destroyed) return
      if (!admission.ok) {
        response.writeHead(admission.status, { 'content-type': 'text/plain; charset=utf-8' }).end(admission.status === 403 ? 'соединение закрыто Ремонтником' : '')
        return
      }
      const headers = { ...request.headers }
      delete headers['proxy-authorization']
      delete headers['proxy-connection']
      const viaHttpProxy = upstream && !isSocks(upstream)
      const auth = upstream && basicAuth(upstream)
      const proxy = viaHttpProxy ? proxyUrl(upstream) : undefined
      const path = `${url.pathname}${url.search}`
      const outgoing = httpRequest({
        ...(proxy
          ? { host: proxy.hostname, port: Number(proxy.port) || 80, path: `http://${addressKey(admission.host, target.port)}${path}`, headers: { ...headers, ...(auth ? { 'proxy-authorization': auth } : {}) } }
          : { host: admission.host, port: target.port, path, headers }),
        method: request.method,
        // Через socks — своё соединение; Node зовёт createConnection, только когда agent не задан вовсе.
        ...(upstream && !viaHttpProxy
          ? { createConnection: (_options: unknown, ready: (error: Error | null, socket?: Socket) => void) => void openTunnel(admission.host, target.port, upstream, signal).then((socket) => ready(null, socket), (error: Error) => ready(error)) }
          : { agent: false, timeout: timeoutMs }),
      } as RequestOptions)
      track(outgoing, target)
      response.once('close', () => outgoing.destroy())
      outgoing.on('timeout', () => outgoing.destroy())
      outgoing.on('response', (answer) => {
        response.writeHead(answer.statusCode ?? 502, answer.headers)
        answer.pipe(response)
      })
      outgoing.on('error', () => {
        if (!response.headersSent) response.writeHead(502).end()
        else response.destroy()
      })
      request.pipe(outgoing)
    })
  })

  server.on('connect', (request: IncomingMessage, client: Socket, head: Buffer) => {
    client.on('error', () => {})
    if (!authorized(request)) {
      return void client.end('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="remontnik"\r\nContent-Length: 0\r\n\r\n')
    }
    const authority = /^(?:\[([^\]]+)\]|([^:]+)):(\d{1,5})$/.exec(request.url ?? '')
    const port = Number(authority?.[3])
    if (!authority || !(port > 0 && port < 65_536)) return void client.end('HTTP/1.1 400 Bad Request\r\n\r\n')
    const target: EgressTarget = { host: (authority[1] ?? authority[2]!).toLowerCase(), port }
    track(client, target)
    const signal = deadline(client)
    // Пока туннель не готов, сокет клиента читается: иначе его закрытие не видно, и неготовое соединение висит.
    const early: Buffer[] = head.length > 0 ? [head] : []
    const keep = (chunk: Buffer) => early.push(chunk)
    const gone = () => client.destroy()
    client.on('data', keep)
    client.once('end', gone)
    void admit(target, signal)
      .then(async (admission) => {
        if (!admission.ok) return void client.end(admission.status === 403 ? 'HTTP/1.1 403 Forbidden\r\n\r\n' : 'HTTP/1.1 502 Bad Gateway\r\n\r\n')
        const remote = await openTunnel(admission.host, target.port, upstream, signal)
        if (client.destroyed) return void remote.destroy()
        remote.on('error', () => client.destroy())
        track(remote, target)
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
        client.off('data', keep)
        client.off('end', gone)
        for (const chunk of early) remote.write(chunk)
        remote.pipe(client)
        client.pipe(remote)
        client.once('close', () => remote.destroy())
        remote.once('close', () => client.destroy())
      })
      .catch(() => client.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'))
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  ownPort = (server.address() as AddressInfo).port
  return {
    url: `http://127.0.0.1:${ownPort}`,
    username,
    password,
    dropRefused() {
      for (const [connection, target] of [...open]) {
        if (options.allows(target)) continue
        open.delete(connection)
        connection.destroy()
      }
    },
    close: () =>
      new Promise((resolve) => {
        for (const connection of open.keys()) connection.destroy()
        server.close(() => resolve())
        server.closeAllConnections()
      }),
  }
}
