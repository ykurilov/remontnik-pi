import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

// Подпись запросов между частями Ремонтника.
// Сторож → врач: `signBody`, HMAC-SHA256 над `<секунды>.<тело>`.
// Мост Paseo ↔ врач: `signRequest` покрывает ещё метод, путь с запросом и разовую метку,
// а `signResponse` привязывает ответ к разовой метке запроса. Повтор отсекает `ReplayGuard`.

export const SIGNATURE_HEADER = 'X-Remontnik-Signature'
export const TIMESTAMP_HEADER = 'X-Remontnik-Timestamp'
export const NONCE_HEADER = 'X-Remontnik-Nonce'
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

const NONCE = /^[0-9a-f]{32}$/

export type RequestSignatureHeaders = SignatureHeaders & { [NONCE_HEADER]: string }

function requestMessage(timestamp: string, nonce: string, method: string, target: string, body: string): string {
  return `remontnik-request-v1\n${timestamp}\n${nonce}\n${method.toUpperCase()}\n${target}\n${body}`
}

function responseMessage(
  timestamp: string,
  request: { method: string; target: string; nonce: string },
  status: number,
  body: string,
): string {
  return `remontnik-response-v1\n${timestamp}\n${request.nonce}\n${request.method.toUpperCase()}\n${request.target}\n${status}\n${body}`
}

function hmac(message: string, secret: string): string {
  return createHmac('sha256', secret).update(message).digest('hex')
}

function timestampOf(now: number): string {
  return String(Math.floor(now / 1000))
}

function checkSignature(
  headers: HeaderSource,
  secret: string,
  now: number,
  maxSkewMs: number,
  message: (timestamp: string) => string,
): SignatureCheck {
  const signature = readHeader(headers, SIGNATURE_HEADER)
  const timestamp = readHeader(headers, TIMESTAMP_HEADER)
  if (!signature || !timestamp) return { ok: false, reason: 'missing' }
  if (secret === '' || !/^\d+$/.test(timestamp) || !signature.startsWith('sha256=')) return { ok: false, reason: 'bad_signature' }
  const expected = Buffer.from(hmac(message(timestamp), secret), 'hex')
  const received = Buffer.from(signature.slice('sha256='.length), 'hex')
  if (received.length !== expected.length || !timingSafeEqual(received, expected)) return { ok: false, reason: 'bad_signature' }
  if (Math.abs(now - Number(timestamp) * 1000) > maxSkewMs) return { ok: false, reason: 'stale' }
  return { ok: true }
}

export interface SignRequestInput {
  method: string
  /** Путь с запросом ровно как в строке запроса: `/v1/reports?after=3&limit=50`. */
  target: string
  /** Тело как есть; у GET — пустая строка. */
  body: string
  secret: string
  now?: number
}

/** Заголовки подписи запроса: метод, путь с запросом, отметка времени, разовая метка и тело. */
export function signRequest(input: SignRequestInput): RequestSignatureHeaders {
  if (input.secret === '') throw new Error('[remontnik] пустой секрет подписи')
  const timestamp = timestampOf(input.now ?? Date.now())
  const nonce = randomBytes(16).toString('hex')
  return {
    [SIGNATURE_HEADER]: `sha256=${hmac(requestMessage(timestamp, nonce, input.method, input.target, input.body), input.secret)}`,
    [TIMESTAMP_HEADER]: timestamp,
    [NONCE_HEADER]: nonce,
  }
}

export interface VerifySignedRequestInput {
  method: string
  target: string
  body: string
  headers: HeaderSource
  secret: string
  now?: number
  maxSkewMs?: number
}

/** Проверка подписи запроса. Повтор той же подписи отсекает `ReplayGuard` у принимающей стороны. */
export function verifySignedRequest(input: VerifySignedRequestInput): SignatureCheck {
  const nonce = readHeader(input.headers, NONCE_HEADER)
  if (!nonce) return { ok: false, reason: 'missing' }
  if (!NONCE.test(nonce)) return { ok: false, reason: 'bad_signature' }
  return checkSignature(input.headers, input.secret, input.now ?? Date.now(), input.maxSkewMs ?? DEFAULT_MAX_SKEW_MS, (timestamp) =>
    requestMessage(timestamp, nonce, input.method, input.target, input.body),
  )
}

export interface SignedRequestRef {
  method: string
  target: string
  /** Разовая метка запроса, на который отвечают. */
  nonce: string
}

/** Подпись ответа: привязана к запросу (метод, путь, разовая метка), статусу и телу ответа. */
export function signResponse(input: {
  request: SignedRequestRef
  status: number
  body: string
  secret: string
  now?: number
}): SignatureHeaders {
  if (input.secret === '') throw new Error('[remontnik] пустой секрет подписи')
  const timestamp = timestampOf(input.now ?? Date.now())
  return {
    [SIGNATURE_HEADER]: `sha256=${hmac(responseMessage(timestamp, input.request, input.status, input.body), input.secret)}`,
    [TIMESTAMP_HEADER]: timestamp,
  }
}

export function verifySignedResponse(input: {
  request: SignedRequestRef
  status: number
  body: string
  headers: HeaderSource
  secret: string
  now?: number
  maxSkewMs?: number
}): SignatureCheck {
  return checkSignature(input.headers, input.secret, input.now ?? Date.now(), input.maxSkewMs ?? DEFAULT_MAX_SKEW_MS, (timestamp) =>
    responseMessage(timestamp, input.request, input.status, input.body),
  )
}

/**
 * Память увиденных подписей на время окна: подпись, уже принятая раз, второй раз не проходит.
 * Окно по умолчанию — вдвое больше допуска по времени: подпись годна на `maxSkew` в обе стороны.
 */
export class ReplayGuard {
  private readonly seen = new Map<string, number>()
  private readonly windowMs: number
  private readonly maxEntries: number

  constructor(windowMs: number = 2 * DEFAULT_MAX_SKEW_MS, maxEntries = 100_000) {
    this.windowMs = windowMs
    this.maxEntries = maxEntries
  }

  firstSeen(signature: string, now: number = Date.now()): boolean {
    for (const [key, expires] of this.seen) {
      if (expires > now) break
      this.seen.delete(key)
    }
    const expires = this.seen.get(signature)
    if (expires !== undefined && expires > now) return false
    if (this.seen.size >= this.maxEntries) this.seen.delete(this.seen.keys().next().value!)
    this.seen.delete(signature)
    this.seen.set(signature, now + this.windowMs)
    return true
  }
}
