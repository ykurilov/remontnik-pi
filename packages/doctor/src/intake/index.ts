import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { INCIDENT_KINDS, type IncidentEvent } from '@ykurilov/remontnik-core/incident'
import { redactValue } from '@ykurilov/remontnik-core/redact'
import { verifySignedBody } from '@ykurilov/remontnik-core/signed-http'

// Приём событий от сторожей: подписанный POST /v1/events и открытый GET /health.

export const INTAKE_MAX_EVENTS = 50
export const INTAKE_MAX_BODY_BYTES = 1024 * 1024

export interface IntakeHandlerOptions {
  secret: string
  /** Записывает принятые события; повтор того же eventId должен быть безопасен. */
  receiveEvents(events: IncidentEvent[]): Promise<{ accepted: string[] }>
  health(): unknown
}

export type IntakeHandler = (request: IncomingMessage, response: ServerResponse) => Promise<void>

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  if (response.headersSent) return
  response.writeHead(status, { 'content-type': 'application/json' })
  response.end(JSON.stringify(body))
}

/** Тело целиком; `null`, если оно больше предела (дочитываем его впустую, чтобы ответ дошёл). */
async function readLimitedBody(request: IncomingMessage, limit: number): Promise<string | null> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    size += (chunk as Buffer).length
    if (size <= limit) chunks.push(chunk as Buffer)
  }
  return size > limit ? null : Buffer.concat(chunks).toString('utf8')
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

    const body = await readLimitedBody(request, INTAKE_MAX_BODY_BYTES)
    if (body === null) {
      sendJson(response, 413, { error: 'too_large' })
      return
    }
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
