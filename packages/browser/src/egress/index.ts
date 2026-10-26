// Выход браузера в сеть: весь трафик Chromium службы идёт через этот прокси внутри службы, и сетевой замок
// решает здесь, а не скриптом в странице — скрипт страницы до этой границы не достаёт. Видно, куда соединение:
// для http:// — точный origin, для туннеля (https, WebSocket, TURN по TCP) — хост и порт. Пока замок закрыт,
// соединения на адреса вне разрешённых не открываются, а уже открытые туннели и запросы туда рвутся.
// Дальше трафик идёт прямо или через прокси профиля (http:// или socks5://).
import { createServer, request as httpRequest, type IncomingMessage, type RequestOptions, type ServerResponse } from 'node:http'
import { connect, type AddressInfo, type Socket } from 'node:net'

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
  /** Рвёт открытые туннели и запросы, которые сейчас уже не разрешены (замок только что закрылся). */
  dropRefused(): void
  close(): Promise<void>
}

export interface EgressOptions {
  /** Можно ли соединиться с адресом сейчас: решение замка. */
  allows(target: EgressTarget): boolean
  onRefused(target: EgressTarget): void
  upstream?: UpstreamProxy
}

const DEFAULT_PORTS: Record<string, number> = { 'http:': 80, 'https:': 443 }

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

/** `host:port` из строки CONNECT, IPv6 — в скобках. */
function parseAuthority(authority: string): EgressTarget | null {
  const match = /^(?:\[([^\]]+)\]|([^:]+)):(\d{1,5})$/.exec(authority)
  const port = Number(match?.[3])
  if (!match || !(port > 0 && port < 65_536)) return null
  return { host: (match[1] ?? match[2]!).toLowerCase(), port }
}

function basicAuth(upstream: UpstreamProxy): string | undefined {
  if (upstream.username === undefined) return undefined
  return `Basic ${Buffer.from(`${upstream.username}:${upstream.password ?? ''}`).toString('base64')}`
}

/** Сокет до адреса: прямо, через CONNECT к http-прокси профиля или через socks5. */
function openTunnel(target: EgressTarget, upstream: UpstreamProxy | undefined): Promise<Socket> {
  if (!upstream) return connected(connect(target.port, target.host))
  const proxy = new URL(upstream.server.includes('://') ? upstream.server : `http://${upstream.server}`)
  const socket = connect(Number(proxy.port) || (proxy.protocol.startsWith('socks') ? 1080 : 80), proxy.hostname.replace(/^\[|\]$/g, ''))
  return connected(socket).then((open) => (proxy.protocol.startsWith('socks') ? socksHandshake(open, target, upstream) : httpConnect(open, target, upstream)))
}

function connected(socket: Socket): Promise<Socket> {
  return new Promise((resolve, reject) => {
    socket.once('connect', () => {
      socket.off('error', reject)
      resolve(socket)
    })
    socket.once('error', reject)
  })
}

/** Ждёт от сокета ровно `size` байт (или до `until` в тексте), остаток возвращает в поток. */
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
      socket.off('end', onEnd)
      socket.off('error', onEnd)
    }
    socket.on('data', onData)
    socket.on('end', onEnd)
    socket.on('error', onEnd)
  })
}

async function httpConnect(socket: Socket, target: EgressTarget, upstream: UpstreamProxy): Promise<Socket> {
  const authority = describeTarget({ host: target.host, port: target.port })
  const auth = basicAuth(upstream)
  socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n${auth ? `Proxy-Authorization: ${auth}\r\n` : ''}\r\n`)
  const head = await readReply(socket, (buffer) => {
    const end = buffer.indexOf('\r\n\r\n')
    return end === -1 ? null : end + 4
  })
  if (!/^HTTP\/1\.[01] 2\d\d/.test(head.toString('latin1'))) {
    socket.destroy()
    throw new Error('прокси профиля отказал в соединении')
  }
  return socket
}

async function socksHandshake(socket: Socket, target: EgressTarget, upstream: UpstreamProxy): Promise<Socket> {
  const fail = (reason: string): never => {
    socket.destroy()
    throw new Error(`socks5: ${reason}`)
  }
  const withAuth = upstream.username !== undefined
  socket.write(Buffer.from(withAuth ? [5, 1, 2] : [5, 1, 0]))
  const method = await readReply(socket, (buffer) => (buffer.length >= 2 ? 2 : null))
  if (method[0] !== 5 || method[1] !== (withAuth ? 2 : 0)) fail('способ входа не принят')
  if (withAuth) {
    const user = Buffer.from(upstream.username ?? '')
    const password = Buffer.from(upstream.password ?? '')
    socket.write(Buffer.concat([Buffer.from([1, user.length]), user, Buffer.from([password.length]), password]))
    const status = await readReply(socket, (buffer) => (buffer.length >= 2 ? 2 : null))
    if (status[1] !== 0) fail('имя или пароль не приняты')
  }
  const host = Buffer.from(target.host)
  socket.write(Buffer.concat([Buffer.from([5, 1, 0, 3, host.length]), host, Buffer.from([target.port >> 8, target.port & 0xff])]))
  const reply = await readReply(socket, (buffer) => {
    if (buffer.length < 5) return null
    const length = buffer[3] === 1 ? 4 : buffer[3] === 4 ? 16 : 1 + buffer[4]!
    return buffer.length >= 4 + length + 2 ? 4 + length + 2 : null
  })
  if (reply[1] !== 0) fail('соединение не открыто')
  return socket
}

export async function startEgressProxy(options: EgressOptions): Promise<EgressProxy> {
  /** Открытые соединения с адресом: туннели и запросы http:// в работе. */
  const open = new Map<{ destroy(): void }, EgressTarget>()
  const track = (connection: { destroy(): void; once(event: 'close', listener: () => void): unknown }, target: EgressTarget) => {
    open.set(connection, target)
    connection.once('close', () => open.delete(connection))
  }
  const refuse = (target: EgressTarget) => {
    options.onRefused(target)
    return false
  }
  const permitted = (target: EgressTarget) => options.allows(target) || refuse(target)

  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
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
    if (!permitted(target)) {
      response.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' }).end('соединение закрыто Ремонтником')
      return
    }
    const headers = { ...request.headers }
    delete headers['proxy-authorization']
    delete headers['proxy-connection']
    const upstream = options.upstream
    const viaHttpProxy = upstream && !upstream.server.startsWith('socks')
    const auth = upstream && basicAuth(upstream)
    const proxyUrl = viaHttpProxy ? new URL(upstream.server.includes('://') ? upstream.server : `http://${upstream.server}`) : undefined
    const outgoing = httpRequest({
      ...(proxyUrl
        ? { host: proxyUrl.hostname, port: Number(proxyUrl.port) || 80, path: url.href, headers: { ...headers, ...(auth ? { 'proxy-authorization': auth } : {}) } }
        : { host: target.host, port: target.port, path: `${url.pathname}${url.search}`, headers }),
      method: request.method,
      // Через socks — своё соединение; Node зовёт createConnection, только когда agent не задан вовсе.
      ...(upstream && !viaHttpProxy
        ? { createConnection: (_options: unknown, ready: (error: Error | null, socket?: Socket) => void) => void openTunnel(target, upstream).then((socket) => ready(null, socket), (error: Error) => ready(error)) }
        : { agent: false }),
    } as RequestOptions)
    track(outgoing, target)
    track(response, target)
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

  server.on('connect', (request: IncomingMessage, client: Socket, head: Buffer) => {
    client.on('error', () => {})
    const target = parseAuthority(request.url ?? '')
    if (!target) return void client.end('HTTP/1.1 400 Bad Request\r\n\r\n')
    if (!permitted(target)) return void client.end('HTTP/1.1 403 Forbidden\r\n\r\n')
    track(client, target)
    openTunnel(target, options.upstream).then(
      (remote) => {
        remote.on('error', () => client.destroy())
        if (client.destroyed) return void remote.destroy()
        track(remote, target)
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
        if (head.length > 0) remote.write(head)
        remote.pipe(client)
        client.pipe(remote)
        client.once('close', () => remote.destroy())
        remote.once('close', () => client.destroy())
      },
      () => client.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'),
    )
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}`,
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
