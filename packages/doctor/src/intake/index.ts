import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { INCIDENT_KINDS, type IncidentEvent } from '@ykurilov/remontnik-core/incident'
import { redactValue } from '@ykurilov/remontnik-core/redact'
import { DEFAULT_MAX_SKEW_MS, verifySignedBody } from '@ykurilov/remontnik-core/signed-http'
import { headerValue, precheckSignature, readLimitedBody, refuse, sendJson, type IntakeHandler } from './http-kit.js'

// Приём событий от сторожей: подписанный POST /v1/events и открытый GET /health; рядом — лента отчётов и стоп-кран.

export const INTAKE_MAX_EVENTS = 50
export const INTAKE_MAX_BODY_BYTES = 1024 * 1024
export const INTAKE_BODY_TIMEOUT_MS = 10_000

export interface IntakeHandlerOptions {
  secret: string
  /** Записывает принятые события; повтор того же eventId должен быть безопасен. */
  receiveEvents(events: IncidentEvent[]): Promise<{ accepted: string[] }>
  health(): unknown | Promise<unknown>
  /** Срок на чтение тела; не успел — 408 и соединение закрывается. */
  bodyTimeoutMs?: number
  /** Лента отчётов: `/v1/reports*` отдаются ей. Не задана — этих адресов нет. */
  reportsFeed?: IntakeHandler
  /** Снятие «нужен человек» по отпечатку: `POST /v1/control/fingerprints`. Не задано — адреса нет. */
  fingerprintRelease?: IntakeHandler
  /** Стоп-кран выкаток: `POST /v1/control/deploys`. Не задан — адреса нет. */
  deployControls?: IntakeHandler
  /** Снова поставить случай в работу: `POST /v1/control/cases`. Не задано — адреса нет. */
  caseRetry?: IntakeHandler
}

export type { IntakeHandler }

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

/**
 * Событие позже часов врача дальше допуска подписи — у сторожа сбились часы: время события — время приёма.
 * Отказ всей пачке тут не годится: сторож слал бы её снова, и с ней застряли бы и верные события.
 */
function clampFuture(event: IncidentEvent, receivedAt: number): IncidentEvent {
  return Date.parse(event.occurredAt) > receivedAt + DEFAULT_MAX_SKEW_MS ? { ...event, occurredAt: new Date(receivedAt).toISOString() } : event
}

export function createIntakeHandler(options: IntakeHandlerOptions): IntakeHandler {
  return async (request, response) => {
    const path = (request.url ?? '/').split('?')[0]
    if (request.method === 'GET' && path === '/health') {
      sendJson(response, 200, await options.health())
      return
    }
    if (options.deployControls && path === '/v1/control/deploys') {
      await options.deployControls(request, response)
      return
    }
    if (options.caseRetry && path === '/v1/control/cases') {
      await options.caseRetry(request, response)
      return
    }
    if (options.fingerprintRelease && path === '/v1/control/fingerprints') {
      await options.fingerprintRelease(request, response)
      return
    }
    if (options.reportsFeed && (path === '/v1/reports' || path === '/v1/reports/ack')) {
      await options.reportsFeed(request, response)
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
    const receivedAt = Date.now()
    const result = await options.receiveEvents(events.map((event) => clampFuture(redactValue(event), receivedAt)))
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
