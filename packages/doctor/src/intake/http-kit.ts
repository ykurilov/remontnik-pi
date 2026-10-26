import type { IncomingMessage, ServerResponse } from 'node:http'
import { DEFAULT_MAX_SKEW_MS, SIGNATURE_HEADER, TIMESTAMP_HEADER } from '@ykurilov/remontnik-core/signed-http'

// Общие части HTTP врача: ответ JSON, отказ без чтения тела, заголовки, чтение тела с пределом и сроком.

export type IntakeHandler = (request: IncomingMessage, response: ServerResponse) => Promise<void>

const REFUSE_LINGER_MS = 1_000

export function sendJson(response: ServerResponse, status: number, body: unknown): void {
  if (response.headersSent) return
  response.writeHead(status, { 'content-type': 'application/json' })
  response.end(JSON.stringify(body))
}

/**
 * Отказ без чтения остатка тела: ответ сразу, остаток выбрасываем, через секунду соединение рвём,
 * даже если клиент ещё пишет. `Connection: close` не ставим: с ним Node закрывает сокет с непрочитанным телом,
 * и клиент получает сброс вместо ответа.
 */
export function refuse(request: IncomingMessage, response: ServerResponse, status: number, body: unknown): void {
  setTimeout(() => request.destroy(), REFUSE_LINGER_MS).unref()
  request.resume()
  sendJson(response, status, body)
}

export function headerValue(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name.toLowerCase()]
  return Array.isArray(value) ? value[0] : value
}

/** Проверка заголовков подписи до тела: нет их или отметка времени устарела — тело не нужно. */
export function precheckSignature(request: IncomingMessage, now: number): 'missing' | 'stale' | null {
  const signature = headerValue(request, SIGNATURE_HEADER)
  const timestamp = headerValue(request, TIMESTAMP_HEADER)
  if (!signature || !timestamp) return 'missing'
  if (/^\d+$/.test(timestamp) && Math.abs(now - Number(timestamp) * 1000) > DEFAULT_MAX_SKEW_MS) return 'stale'
  return null
}

export type BodyResult = { ok: true; body: string } | { ok: false; reason: 'too_large' | 'timeout' | 'aborted' }

/** Тело целиком, не больше предела и не дольше срока. */
export function readLimitedBody(request: IncomingMessage, limit: number, timeoutMs: number): Promise<BodyResult> {
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
