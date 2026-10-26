// HTTP-служба браузера для врача: `POST /v1/<команда>` с `Authorization: Bearer <ключ врача>`.
// Все ответы и журнал проходят через фильтр сохранённых паролей.
import { createHash, timingSafeEqual } from 'node:crypto'
import { type IncomingMessage, type Server, type ServerResponse, createServer } from 'node:http'
import { BROWSER_COMMANDS, type BrowserCommandRunner } from '../actions/index.js'
import { createAttemptLimiter } from '../attempts.js'
import { type LogSink, createServiceLog } from '../log.js'
import type { OutputFilter } from '../vault/index.js'

const MAX_BODY_BYTES = 64 * 1024
export const DOCTOR_FAILURES_PER_MINUTE = 10

const digest = (text: string) => createHash('sha256').update(text).digest()

/** Сравнение за постоянное время: SHA-256 обоих ключей одной длины, длина ключа наружу не видна. */
export function sameToken(given: string, expected: string): boolean {
  return timingSafeEqual(digest(given), digest(expected)) && given.length > 0
}

export const clientAddress = (request: IncomingMessage) => request.socket.remoteAddress ?? 'unknown'

export function bearerToken(request: IncomingMessage): string {
  const header = request.headers.authorization ?? ''
  return header.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : ''
}

async function readJsonObject(request: IncomingMessage): Promise<Record<string, unknown> | null> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    size += (chunk as Buffer).length
    if (size > MAX_BODY_BYTES) return null
    chunks.push(chunk as Buffer)
  }
  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
  } catch {
    return null
  }
}

export function createBrowserHttpServer(options: { token: string; runner: BrowserCommandRunner; filter: OutputFilter; log: LogSink }): Server {
  const { token, runner, filter } = options
  const log = createServiceLog(options.log, filter)

  const failures = createAttemptLimiter({ limit: DOCTOR_FAILURES_PER_MINUTE, windowMs: 60_000 })
  const FILTER_FAILED = JSON.stringify({ ok: false, code: 'internal', message: 'фильтр паролей не сработал: ответ не выдан' })

  const send = (response: ServerResponse, status: number, body: unknown) => {
    // Без фильтра текст не уходит никогда: при сбое фильтра — только сообщение о сбое.
    let text: string
    try {
      text = filter.text(JSON.stringify(body))
    } catch {
      status = 500
      text = FILTER_FAILED
    }
    response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    response.end(text)
  }

  async function route(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const { pathname } = new URL(request.url ?? '/', 'http://browser.invalid')
    const command = /^\/v1\/([a-z-]+)$/.exec(pathname)?.[1]
    if (request.method === 'GET' && pathname === '/health') return send(response, 200, { ok: true })
    if (request.method !== 'POST' || !command || !(BROWSER_COMMANDS as readonly string[]).includes(command)) {
      return send(response, 404, { ok: false, code: 'not_found', message: 'нет такой команды' })
    }
    const client = clientAddress(request)
    if (failures.blocked(client)) return send(response, 429, { ok: false, code: 'too_many_attempts', message: 'слишком много неверных ключей; подождите минуту' })
    if (!sameToken(bearerToken(request), token)) {
      failures.fail(client)
      log({ event: 'unauthorized', command })
      return send(response, 401, { ok: false, code: 'unauthorized', message: 'нужен ключ врача' })
    }
    const input = await readJsonObject(request)
    if (!input) return send(response, 400, { ok: false, code: 'bad_request', message: 'ожидается JSON-объект' })
    send(response, 200, await runner.run(command, input))
  }

  const server = createServer((request, response) => {
    route(request, response).catch((error: unknown) => {
      const message = error instanceof Error ? error.message.split('\n')[0] : String(error)
      log({ event: 'error', url: request.url, message })
      if (!response.headersSent) send(response, 500, { ok: false, code: 'internal', message: `сбой службы браузера: ${message}` })
    })
  })
  return server
}
