import { createHmac, timingSafeEqual } from 'node:crypto'

// Подпись запросов между частями Ремонтника (сторож → врач, мост Paseo ↔ врач).
// HMAC-SHA256 покрывает отметку времени и тело: `<секунды>.<тело>`, поэтому отметку нельзя подменить.

export const SIGNATURE_HEADER = 'X-Remontnik-Signature'
export const TIMESTAMP_HEADER = 'X-Remontnik-Timestamp'
export const DEFAULT_MAX_SKEW_MS = 300_000

export type SignatureHeaders = { [SIGNATURE_HEADER]: string; [TIMESTAMP_HEADER]: string }

export type SignatureCheck = { ok: true } | { ok: false; reason: 'missing' | 'bad_signature' | 'stale' }

function computeSignature(timestamp: string, body: string, secret: string): string {
  return createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')
}

/** Заголовки подписи для тела запроса. */
export function signBody(body: string, secret: string, now: number = Date.now()): SignatureHeaders {
  if (secret === '') throw new Error('[remontnik] пустой секрет подписи')
  const timestamp = String(Math.floor(now / 1000))
  return {
    [SIGNATURE_HEADER]: `sha256=${computeSignature(timestamp, body, secret)}`,
    [TIMESTAMP_HEADER]: timestamp,
  }
}

type HeaderSource = Headers | Record<string, string | string[] | undefined>

function readHeader(headers: HeaderSource, name: string): string | undefined {
  if (headers instanceof Headers) return headers.get(name) ?? undefined
  const wanted = name.toLowerCase()
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === wanted) return Array.isArray(value) ? value[0] : value
  }
  return undefined
}

export interface VerifySignedBodyInput {
  /** Тело запроса ровно в том виде, как пришло. */
  body: string
  headers: HeaderSource
  secret: string
  now?: number
  maxSkewMs?: number
}

/** Проверка подписи: верная, с отметкой времени не старше и не новее `maxSkewMs` (5 минут). */
export function verifySignedBody(input: VerifySignedBodyInput): SignatureCheck {
  const signature = readHeader(input.headers, SIGNATURE_HEADER)
  const timestamp = readHeader(input.headers, TIMESTAMP_HEADER)
  if (!signature || !timestamp) return { ok: false, reason: 'missing' }
  if (input.secret === '' || !/^\d+$/.test(timestamp) || !signature.startsWith('sha256=')) {
    return { ok: false, reason: 'bad_signature' }
  }

  const expected = Buffer.from(computeSignature(timestamp, input.body, input.secret), 'hex')
  const received = Buffer.from(signature.slice('sha256='.length), 'hex')
  if (received.length !== expected.length || !timingSafeEqual(received, expected)) {
    return { ok: false, reason: 'bad_signature' }
  }

  const skew = Math.abs((input.now ?? Date.now()) - Number(timestamp) * 1000)
  if (skew > (input.maxSkewMs ?? DEFAULT_MAX_SKEW_MS)) return { ok: false, reason: 'stale' }
  return { ok: true }
}
