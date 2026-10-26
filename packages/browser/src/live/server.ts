// Живой экран владельца: отдельный адрес только в частной сети, вход по ключу владельца (не врача),
// куки HttpOnly + SameSite=Strict, кадры и ввод по WebSocket. Без REMONTNIK_BROWSER_LIVE_LISTEN не включается.
import { randomBytes } from 'node:crypto'
import { type IncomingMessage, type ServerResponse, createServer } from 'node:http'
import { isIP } from 'node:net'
import type { Duplex } from 'node:stream'
import { WebSocketServer, type WebSocket } from 'ws'
import type { ServiceLog } from '../log.js'
import { sameToken } from '../service/index.js'
import { type ControlLock, handleOwnerInput } from './control.js'
import { liveLoginPage, liveScreenPage } from './page/index.js'
import type { LiveTargets } from './stream.js'

const SESSION_COOKIE = 'remontnik_live'
const SESSION_TTL_MS = 12 * 60 * 60_000
const LOGIN_ATTEMPTS_PER_MINUTE = 5
const PING_INTERVAL_MS = 15_000
const PROFILE = /^[a-z0-9][a-z0-9_-]{0,63}$/i

export interface LiveAddress {
  host: string
  port: number
}

function isPrivateAddress(host: string): boolean {
  if (isIP(host) === 4) {
    const [a = 0, b = 0] = host.split('.').map(Number)
    return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127)
  }
  if (isIP(host) === 6) {
    const lower = host.toLowerCase()
    return lower === '::1' || /^f[cd][0-9a-f]{2}:/.test(lower)
  }
  return false
}

/** `адрес:порт` частной сети (10/8, 172.16/12, 192.168/16, 100.64/10, fc00::/7, петля). «Все адреса» и публичные — нельзя. */
export function parseLiveListen(value: string): LiveAddress {
  const match = /^(?:\[([0-9a-f:]+)\]|([\d.]+)):(\d{1,5})$/i.exec(value.trim())
  const host = match?.[1] ?? match?.[2]
  const port = Number(match?.[3])
  if (!host || !Number.isInteger(port) || port > 65_535) {
    throw new Error(`REMONTNIK_BROWSER_LIVE_LISTEN: ожидается «адрес:порт» частной сети, получено «${value}»`)
  }
  if (!isPrivateAddress(host)) {
    throw new Error(`REMONTNIK_BROWSER_LIVE_LISTEN: ${host} — не адрес частной сети; живой экран слушает только частную сеть`)
  }
  return { host, port }
}

export interface LiveScreen {
  address: LiveAddress
  url: string
  close(): Promise<void>
}

export interface LiveScreenOptions {
  listen: LiveAddress
  ownerToken: string
  doctorToken: string
  control: ControlLock
  targets: LiveTargets
  log: ServiceLog
}

function cookieOf(request: IncomingMessage, name: string): string | undefined {
  for (const part of (request.headers.cookie ?? '').split(';')) {
    const [key, ...rest] = part.trim().split('=')
    if (key === name) return rest.join('=')
  }
  return undefined
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    size += (chunk as Buffer).length
    if (size > 8 * 1024) throw new Error('слишком большой запрос')
    chunks.push(chunk as Buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

export async function createLiveScreen(options: LiveScreenOptions): Promise<LiveScreen> {
  const { ownerToken, doctorToken, control, targets, log } = options
  if (ownerToken.length < 16) throw new Error('REMONTNIK_BROWSER_OWNER_TOKEN: нужен ключ не короче 16 знаков')
  if (sameToken(ownerToken, doctorToken)) throw new Error('ключ владельца совпадает с ключом врача: нужен отдельный')

  const sessions = new Map<string, number>()
  const failures: number[] = []

  const ownerSession = (request: IncomingMessage) => {
    const id = cookieOf(request, SESSION_COOKIE)
    const expires = id ? sessions.get(id) : undefined
    if (!id || expires === undefined) return false
    if (expires < Date.now()) {
      sessions.delete(id)
      return false
    }
    return true
  }

  const send = (response: ServerResponse, status: number, body: string, type: string, headers: Record<string, string> = {}) => {
    response.writeHead(status, {
      'content-type': type,
      'cache-control': 'no-store',
      'x-frame-options': 'DENY',
      'referrer-policy': 'no-referrer',
      'content-security-policy': "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'",
      ...headers,
    })
    response.end(body)
  }
  const json = (response: ServerResponse, status: number, body: unknown) => send(response, status, JSON.stringify(body), 'application/json; charset=utf-8')

  function tooManyFailures(): boolean {
    const minuteAgo = Date.now() - 60_000
    while (failures.length > 0 && failures[0]! < minuteAgo) failures.shift()
    return failures.length >= LOGIN_ATTEMPTS_PER_MINUTE
  }

  async function route(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', 'http://live.invalid')
    const profile = url.searchParams.get('profile') ?? ''

    if (request.method === 'GET' && url.pathname === '/live') {
      if (!PROFILE.test(profile)) return send(response, 400, 'нужен ?profile=', 'text/plain; charset=utf-8')
      const page = ownerSession(request) ? liveScreenPage(profile) : liveLoginPage(profile)
      return send(response, 200, page, 'text/html; charset=utf-8')
    }

    if (request.method === 'POST' && url.pathname === '/live/login') {
      if (tooManyFailures()) return send(response, 429, liveLoginPage('', 'Слишком много попыток. Подождите минуту.'), 'text/html; charset=utf-8')
      const form = new URLSearchParams(await readBody(request))
      const loginProfile = PROFILE.test(form.get('profile') ?? '') ? form.get('profile')! : ''
      if (!sameToken(form.get('token') ?? '', ownerToken)) {
        failures.push(Date.now())
        log({ event: 'live_login_refused' })
        return send(response, 401, liveLoginPage(loginProfile, 'Ключ не подошёл.'), 'text/html; charset=utf-8')
      }
      const id = randomBytes(32).toString('base64url')
      sessions.set(id, Date.now() + SESSION_TTL_MS)
      log({ event: 'live_login', profile: loginProfile })
      response.writeHead(303, {
        location: `/live?profile=${encodeURIComponent(loginProfile)}`,
        'set-cookie': `${SESSION_COOKIE}=${id}; Path=/live; HttpOnly; SameSite=Strict; Max-Age=${SESSION_TTL_MS / 1000}`,
        'cache-control': 'no-store',
      })
      return void response.end()
    }

    if (request.method === 'POST' && url.pathname === '/live/control') {
      if (!ownerSession(request)) return json(response, 401, { ok: false, code: 'unauthorized', message: 'нужен вход по ключу владельца' })
      if (!(request.headers['content-type'] ?? '').startsWith('application/json')) return json(response, 415, { ok: false, code: 'bad_request', message: 'нужен JSON' })
      const body = JSON.parse((await readBody(request)) || '{}') as { profile?: unknown; action?: unknown }
      if (typeof body.profile !== 'string' || !PROFILE.test(body.profile) || (body.action !== 'take' && body.action !== 'release')) {
        return json(response, 400, { ok: false, code: 'bad_request', message: '{ profile, action: "take" | "release" }' })
      }
      if (body.action === 'take') control.take(body.profile)
      else control.release(body.profile)
      log({ event: body.action === 'take' ? 'owner_took_control' : 'owner_released_control', profile: body.profile })
      return json(response, 200, { ok: true, holder: control.holder(body.profile) })
    }

    return json(response, 404, { ok: false, code: 'not_found', message: 'нет такого адреса' })
  }

  const sockets = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 })

  function serveStream(socket: WebSocket, profile: string): void {
    const disconnect = control.ownerConnected(profile)
    let alive = true
    let unsubscribe: (() => void) | null = null
    const sendState = () => socket.readyState === socket.OPEN && socket.send(JSON.stringify({ type: 'control', holder: control.holder(profile) }))
    socket.on('pong', () => {
      alive = true
      control.ownerSeen(profile)
    })
    const ping = setInterval(() => {
      if (!alive) return socket.terminate()
      alive = false
      socket.ping()
      sendState()
    }, PING_INTERVAL_MS)
    socket.on('close', () => {
      clearInterval(ping)
      unsubscribe?.()
      disconnect()
    })
    targets
      .open(profile)
      .then((target) => {
        if (socket.readyState !== socket.OPEN) return
        unsubscribe = target.subscribe((frame) => {
          // Кадр не догоняем, если владелец не успевает принять прошлый: очередь не копится.
          if (socket.readyState === socket.OPEN && socket.bufferedAmount < 2_000_000) socket.send(JSON.stringify({ type: 'frame', ...frame }))
        })
        // Ввод строго по очереди: иначе Enter может обогнать набранный перед ним текст.
        let inputQueue: Promise<void> = Promise.resolve()
        socket.on('message', (data) => {
          let input: unknown = null
          try {
            input = JSON.parse(String(data))
          } catch {
            // ниже — отказ bad_request
          }
          inputQueue = inputQueue.then(async () => {
            const result = await handleOwnerInput(control, profile, input, target).catch(() => ({ ok: false as const, code: 'internal', message: 'ввод не прошёл' }))
            if (!result.ok && socket.readyState === socket.OPEN) socket.send(JSON.stringify({ type: 'refused', code: result.code, message: result.message }))
          })
        })
        sendState()
      })
      .catch((error: unknown) => {
        log({ event: 'live_error', profile, message: error instanceof Error ? error.message.split('\n')[0] : String(error) })
        socket.close(1011, 'профиль недоступен')
      })
  }

  const server = createServer((request, response) => {
    route(request, response).catch((error: unknown) => {
      log({ event: 'live_error', message: error instanceof Error ? error.message.split('\n')[0] : String(error) })
      if (!response.headersSent) json(response, 500, { ok: false, code: 'internal', message: 'сбой живого экрана' })
    })
  })

  server.on('upgrade', (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(request.url ?? '/', 'http://live.invalid')
    const profile = url.searchParams.get('profile') ?? ''
    const refuse = (status: number, text: string) => {
      socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
    }
    if (url.pathname !== '/live/stream' || !PROFILE.test(profile)) return refuse(404, 'Not Found')
    if (!ownerSession(request)) return refuse(401, 'Unauthorized')
    // Поток открывает только своя страница: чужой сайт с куки владельца сюда не подключится.
    const origin = request.headers.origin
    if (origin !== undefined && origin !== `http://${request.headers.host}`) return refuse(403, 'Forbidden')
    sockets.handleUpgrade(request, socket, head, (ws) => serveStream(ws, profile))
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.listen.port, options.listen.host, () => resolve())
  })
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : options.listen.port
  const host = options.listen.host
  return {
    address: { host, port },
    url: `http://${host.includes(':') ? `[${host}]` : host}:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        for (const client of sockets.clients) client.terminate()
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
}

/** Живой экран из окружения: адреса нет — null; адрес есть, а ключа владельца нет — ошибка. */
export async function startLiveScreen(
  env: Record<string, string | undefined>,
  deps: Omit<LiveScreenOptions, 'listen' | 'ownerToken'>,
): Promise<LiveScreen | null> {
  const listen = env.REMONTNIK_BROWSER_LIVE_LISTEN
  if (!listen) return null
  const ownerToken = env.REMONTNIK_BROWSER_OWNER_TOKEN
  if (!ownerToken) throw new Error('REMONTNIK_BROWSER_LIVE_LISTEN задан, а REMONTNIK_BROWSER_OWNER_TOKEN нет: живой экран без ключа владельца не включается')
  return createLiveScreen({ ...deps, listen: parseLiveListen(listen), ownerToken })
}
