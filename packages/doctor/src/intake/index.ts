import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { INCIDENT_KINDS, type IncidentEvent } from '@ykurilov/remontnik-core/incident'
import { redactValue } from '@ykurilov/remontnik-core/redact'
import {
  DEFAULT_MAX_SKEW_MS,
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
  verifySignedBody,
} from '@ykurilov/remontnik-core/signed-http'

// Приём событий от сторожей: подписанный POST /v1/events и открытый GET /health.

export const INTAKE_MAX_EVENTS = 50
export const INTAKE_MAX_BODY_BYTES = 1024 * 1024
export const INTAKE_BODY_TIMEOUT_MS = 10_000
const REFUSE_LINGER_MS = 1_000

export interface IntakeHandlerOptions {
  secret: string
  /** Записывает принятые события; повтор того же eventId должен быть безопасен. */
  receiveEvents(events: IncidentEvent[]): Promise<{ accepted: string[] }>
  health(): unknown
  /** Срок на чтение тела; не успел — 408 и соединение закрывается. */
  bodyTimeoutMs?: number
}

export type IntakeHandler = (request: IncomingMessage, response: ServerResponse) => Promise<void>

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  if (response.headersSent) return
  response.writeHead(status, { 'content-type': 'application/json' })
  response.end(JSON.stringify(body))
}

/**
 * Отказ без чтения остатка тела: ответ сразу, остаток выбрасываем, через секунду соединение рвём,
 * даже если клиент ещё пишет. `Connection: close` не ставим: с ним Node закрывает сокет с непрочитанным телом,
 * и клиент получает сброс вместо ответа.
 */
function refuse(request: IncomingMessage, response: ServerResponse, status: number, body: unknown): void {
  setTimeout(() => request.destroy(), REFUSE_LINGER_MS).unref()
  request.resume()
  sendJson(response, status, body)
}

function headerValue(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name.toLowerCase()]
  return Array.isArray(value) ? value[0] : value
}

/** Проверка заголовков подписи до тела: нет их или отметка времени устарела — тело не нужно. */
function precheckSignature(request: IncomingMessage, now: number): 'missing' | 'stale' | null {
  const signature = headerValue(request, SIGNATURE_HEADER)
  const timestamp = headerValue(request, TIMESTAMP_HEADER)
  if (!signature || !timestamp) return 'missing'
  if (/^\d+$/.test(timestamp) && Math.abs(now - Number(timestamp) * 1000) > DEFAULT_MAX_SKEW_MS) return 'stale'
  return null
}

type BodyResult = { ok: true; body: string } | { ok: false; reason: 'too_large' | 'timeout' | 'aborted' }

/** Тело целиком, не больше предела и не дольше срока. */
function readLimitedBody(request: IncomingMessage, limit: number, timeoutMs: number): Promise<BodyResult> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    let size = 0
    let settled = false
    const finish = (result: BodyResult) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      request.off('data', onData)
      request.off('end', onEnd)
      request.off('error', onAbort)
      request.off('aborted', onAbort)
      resolve(result)
    }
    const onData = (chunk: Buffer) => {
      size += chunk.length
      if (size > limit) finish({ ok: false, reason: 'too_large' })
      else chunks.push(chunk)
    }
    const onEnd = () => finish({ ok: true, body: Buffer.concat(chunks).toString('utf8') })
    const onAbort = () => finish({ ok: false, reason: 'aborted' })
    const timer = setTimeout(() => finish({ ok: false, reason: 'timeout' }), timeoutMs)
    request.on('data', onData)
    request.on('end', onEnd)
    request.on('error', onAbort)
    request.on('aborted', onAbort)
  })
}

const isString = (value: unknown): value is string => typeof value === 'string'

function isIncidentEvent(value: unknown): value is IncidentEvent {
  if (value === null || typeof value !== 'object') return false
  const event = value as Record<string, unknown>
  return (
    isString(event.eventId) &&
    event.eventId.length > 0 &&
    event.eventId.length <= 64 &&
    isString(event.appName) &&
    (INCIDENT_KINDS as readonly unknown[]).includes(event.kind) &&
    isString(event.fingerprint) &&
    isString(event.where) &&
    isString(event.message) &&
    isString(event.stack) &&
    event.context !== null &&
    typeof event.context === 'object' &&
    !Array.isArray(event.context) &&
    isString(event.occurredAt) &&
    !Number.isNaN(Date.parse(event.occurredAt))
  )
}

export function createIntakeHandler(options: IntakeHandlerOptions): IntakeHandler {
  return async (request, response) => {
    const path = (request.url ?? '/').split('?')[0]
    if (request.method === 'GET' && path === '/health') {
      sendJson(response, 200, options.health())
      return
    }
    if (request.method !== 'POST' || path !== '/v1/events') {
      sendJson(response, 404, { error: 'not_found' })
      return
    }

    const early = precheckSignature(request, Date.now())
    if (early) {
      refuse(request, response, 401, { error: early })
      return
    }
    const declared = Number(headerValue(request, 'content-length'))
    if (Number.isFinite(declared) && declared > INTAKE_MAX_BODY_BYTES) {
      refuse(request, response, 413, { error: 'too_large' })
      return
    }
    const read = await readLimitedBody(request, INTAKE_MAX_BODY_BYTES, options.bodyTimeoutMs ?? INTAKE_BODY_TIMEOUT_MS)
    if (!read.ok) {
      if (read.reason === 'too_large') refuse(request, response, 413, { error: 'too_large' })
      else if (read.reason === 'timeout') refuse(request, response, 408, { error: 'body_timeout' })
      else request.destroy()
      return
    }
    const body = read.body
    const signature = verifySignedBody({ body, headers: request.headers, secret: options.secret })
    if (!signature.ok) {
      sendJson(response, 401, { error: signature.reason })
      return
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(body)
    } catch {
      sendJson(response, 400, { error: 'bad_json' })
      return
    }
    const events = (parsed as { events?: unknown } | null)?.events
    if (!Array.isArray(events) || events.length > INTAKE_MAX_EVENTS || !events.every(isIncidentEvent)) {
      sendJson(response, 400, { error: 'bad_events' })
      return
    }

    // Сторож уже вычистил секреты; врач чистит ещё раз — вдруг сторож старый или чужой.
    const result = await options.receiveEvents(events.map((event) => redactValue(event)))
    sendJson(response, 200, { accepted: result.accepted })
  }
}

export interface IntakeServer {
  url: string
  close(): Promise<void>
}

export async function startIntakeServer(options: {
  handler: IntakeHandler
  host: string
  port: number
  onError?: (error: unknown) => void
}): Promise<IntakeServer> {
  const server = createServer((request, response) => {
    options.handler(request, response).catch((error: unknown) => {
      options.onError?.(error)
      sendJson(response, 500, { error: 'internal' })
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.port, options.host, () => {
      server.off('error', reject)
      resolve()
    })
  })
  const { address, port } = server.address() as AddressInfo
  const host = address.includes(':') ? `[${address}]` : address
  return {
    url: `http://${host}:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
}
