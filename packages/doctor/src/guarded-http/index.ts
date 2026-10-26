import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo, Socket } from 'node:net'
import { assertPrivateAddress } from '@ykurilov/remontnik-core/private-address'

// HTTP-сервер для контейнеров случая (зеркало реестра, прокси eval). Код в контейнере чужой, поэтому
// соединения ограничены: всего, на одного клиента и по времени до первого запроса. Один обработчик слушает
// на нескольких адресах — на адресе врача в каждой сети случая; адрес закрывается вместе с сетью.

export interface GuardedHttpLimits {
  /** Всего соединений на всех адресах. */
  maxConnections: number
  /** Соединений с одного адреса клиента: один контейнер не забирает все места. */
  maxConnectionsPerClient: number
  /** Сколько ждать заголовков первого запроса (и каждого следующего). */
  firstRequestTimeoutMs: number
  /** Сколько держать соединение без запросов между ними. */
  idleTimeoutMs: number
}

export const DEFAULT_GUARDED_HTTP_LIMITS: GuardedHttpLimits = {
  maxConnections: 256,
  maxConnectionsPerClient: 32,
  firstRequestTimeoutMs: 10_000,
  idleTimeoutMs: 5_000,
}

export interface GuardedListener {
  url: string
  host: string
  port: number
  close(): Promise<void>
}

export interface GuardedHttp {
  /** Слушать ещё и на этом адресе (только частная сеть). Порт `0` — любой свободный. */
  listen(host: string, port: number): Promise<GuardedListener>
  close(): Promise<void>
}

type Handler = (request: IncomingMessage, response: ServerResponse) => void

function urlOf(host: string, port: number): string {
  return `http://${host.includes(':') ? `[${host}]` : host}:${port}`
}

export function createGuardedHttp(handler: Handler, limits: Partial<GuardedHttpLimits> = {}): GuardedHttp {
  const settings = { ...DEFAULT_GUARDED_HTTP_LIMITS, ...limits }
  const perClient = new Map<string, number>()
  const servers = new Set<Server>()
  let total = 0

  function admit(socket: Socket): void {
    const client = socket.remoteAddress ?? ''
    const mine = perClient.get(client) ?? 0
    if (total >= settings.maxConnections || mine >= settings.maxConnectionsPerClient) {
      socket.destroy()
      return
    }
    total += 1
    perClient.set(client, mine + 1)
    socket.once('close', () => {
      total -= 1
      const left = (perClient.get(client) ?? 1) - 1
      if (left > 0) perClient.set(client, left)
      else perClient.delete(client)
    })
    // Срок до первого запроса: Node проверяет `headersTimeout` лишь раз в `connectionsCheckingInterval`,
    // поэтому свой таймер на сокете; первый байт запроса его снимает, дальше — сроки сервера.
    const timer = setTimeout(() => socket.destroy(), settings.firstRequestTimeoutMs)
    timer.unref()
    socket.once('data', () => clearTimeout(timer))
    socket.once('close', () => clearTimeout(timer))
  }

  function closeServer(server: Server): Promise<void> {
    servers.delete(server)
    return new Promise<void>((resolve) => {
      server.close(() => resolve())
      server.closeAllConnections()
    })
  }

  return {
    async listen(host, port) {
      assertPrivateAddress(host, 'адрес сервера для контейнеров случая')
      const server = createServer(
        {
          headersTimeout: settings.firstRequestTimeoutMs,
          requestTimeout: Math.max(settings.firstRequestTimeoutMs, 30_000),
          keepAliveTimeout: settings.idleTimeoutMs,
          connectionsCheckingInterval: Math.min(1_000, settings.firstRequestTimeoutMs),
        },
        handler,
      )
      // Свой подсчёт мест — до того, как Node начнёт читать запрос.
      server.on('connection', admit)
      server.on('clientError', (_error, socket) => socket.destroy())
      // Туннелей нет: `CONNECT` и смена протокола получают отказ.
      for (const event of ['connect', 'upgrade'] as const) {
        server.on(event, (_request: IncomingMessage, socket: Socket) => {
          socket.end('HTTP/1.1 405 Method Not Allowed\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
        })
      }
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(port, host, () => {
          server.off('error', reject)
          resolve()
        })
      })
      servers.add(server)
      const bound = (server.address() as AddressInfo).port
      return { url: urlOf(host, bound), host, port: bound, close: () => closeServer(server) }
    },
    async close() {
      await Promise.all([...servers].map(closeServer))
    },
  }
}
