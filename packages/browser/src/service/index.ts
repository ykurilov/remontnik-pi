// HTTP-служба браузера для врача: `POST /v1/<команда>` с `Authorization: Bearer <ключ врача>`.
// Все ответы и журнал проходят через фильтр сохранённых паролей.
import { timingSafeEqual } from 'node:crypto'
import { type IncomingMessage, type Server, type ServerResponse, createServer } from 'node:http'
import { BROWSER_COMMANDS, type BrowserCommandRunner } from '../actions/index.js'
import { type LogSink, createServiceLog } from '../log.js'
import type { OutputFilter } from '../vault/index.js'

const MAX_BODY_BYTES = 64 * 1024

export function sameToken(given: string, expected: string): boolean {
  const a = Buffer.from(given)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

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

  const send = (response: ServerResponse, status: number, body: unknown) => {
    response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    response.end(filter.text(JSON.stringify(body)))
  }

  async function route(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const { pathname } = new URL(request.url ?? '/', 'http://browser.invalid')
    const command = /^\/v1\/([a-z-]+)$/.exec(pathname)?.[1]
    if (request.method === 'GET' && pathname === '/health') return send(response, 200, { ok: true })
    if (request.method !== 'POST' || !command || !(BROWSER_COMMANDS as readonly string[]).includes(command)) {
      return send(response, 404, { ok: false, code: 'not_found', message: 'нет такой команды' })
    }
    if (!sameToken(bearerToken(request), token)) {
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
