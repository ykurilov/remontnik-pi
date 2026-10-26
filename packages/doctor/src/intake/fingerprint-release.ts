import { NONCE_HEADER, ReplayGuard, precheckSignedRequest, verifySignedRequest } from '@ykurilov/remontnik-core/signed-http'
import { releaseFingerprint } from '../ledgers/fingerprint-ledger.js'
import type { RecordStore } from '../records/index.js'
import { headerValue, readLimitedBody, refuse, sendJson, type IntakeHandler } from './http-kit.js'

// Снятие «нужен человек» по HTTP (contracts/doctor-api.md): `POST /v1/control/fingerprints`
// `{ fingerprint, action: "release", by }` → `{ fingerprint, needsHuman }`. Снятие снова пускает автовыкатки по отпечатку,
// поэтому подписывается только секретом владельца `REMONTNIK_CONTROL_SECRET`: общий секрет есть у приложения.
// Повтор разовой метки и подпись раньше запуска врача отвергаются.

const BODY_LIMIT_BYTES = 4 * 1024
const BODY_TIMEOUT_MS = 10_000
const BY_MAX_LENGTH = 100
/** Отпечаток сбоя (`fingerprint()` ядра) — 16 шестнадцатеричных знаков; запас под другие длины. */
export const FINGERPRINT_FORMAT = /^[0-9a-f]{8,64}$/

export interface FingerprintReleaseOptions {
  records: RecordStore
  /** Общий секрет: им подписанный запрос узнаётся, но не исполняется. */
  secret: string
  /** Секрет владельца; не задан — снять пометку по HTTP нельзя. */
  controlSecret?: string
  replayGuard?: ReplayGuard
  bodyTimeoutMs?: number
  now?: () => number
}

function parseCommand(body: string): { fingerprint: string; by: string } | undefined {
  try {
    const parsed = JSON.parse(body) as { fingerprint?: unknown; action?: unknown; by?: unknown } | null
    const { fingerprint, action, by } = parsed ?? {}
    if (action !== 'release' || typeof fingerprint !== 'string' || !FINGERPRINT_FORMAT.test(fingerprint)) return undefined
    if (typeof by !== 'string' || by.trim() === '' || by.length > BY_MAX_LENGTH) return undefined
    return { fingerprint, by: by.trim() }
  } catch {
    return undefined
  }
}

export function createFingerprintReleaseHandler(options: FingerprintReleaseOptions): IntakeHandler {
  if (options.secret === '') throw new Error('[remontnik] общий секрет пуст')
  if (options.controlSecret === '') throw new Error('[remontnik] секрет владельца пуст')
  const replayGuard = options.replayGuard ?? new ReplayGuard()
  const now = options.now ?? Date.now
  /** Подписи до запуска врача не принимаются: память повторов после перезапуска пуста. */
  const startedAt = now()

  return async (request, response) => {
    if (request.method !== 'POST') {
      sendJson(response, 404, { error: 'not_found' })
      return
    }
    const early = precheckSignedRequest({ headers: request.headers, now: now(), notBefore: startedAt })
    if (!early.ok) {
      refuse(request, response, 401, { error: early.reason })
      return
    }
    const nonce = headerValue(request, NONCE_HEADER)!
    if (replayGuard.wasSeen(nonce, now())) {
      refuse(request, response, 401, { error: 'replayed' })
      return
    }
    const read = await readLimitedBody(request, BODY_LIMIT_BYTES, options.bodyTimeoutMs ?? BODY_TIMEOUT_MS)
    if (!read.ok) {
      if (read.reason === 'too_large') refuse(request, response, 413, { error: 'too_large' })
      else if (read.reason === 'timeout') refuse(request, response, 408, { error: 'body_timeout' })
      else request.destroy()
      return
    }
    const verify = (secret: string) =>
      verifySignedRequest({ method: 'POST', target: request.url ?? '/', body: read.body, headers: request.headers, secret, now: now(), notBefore: startedAt })
    const byOwner = options.controlSecret !== undefined && verify(options.controlSecret).ok
    const check = byOwner ? { ok: true as const } : verify(options.secret)
    if (!check.ok) {
      sendJson(response, 401, { error: check.reason })
      return
    }
    if (!replayGuard.firstSeen(nonce, now())) {
      sendJson(response, 401, { error: 'replayed' })
      return
    }
    const command = parseCommand(read.body)
    if (!command) {
      sendJson(response, 400, { error: 'bad_request' })
      return
    }
    if (!byOwner) {
      sendJson(response, 403, { error: 'control_secret_required' })
      return
    }
    const { fingerprint, by } = command
    const released = await releaseFingerprint(options.records, { fingerprint, by, at: now() })
    if (!released.found) {
      sendJson(response, 404, { error: 'unknown_fingerprint' })
      return
    }
    sendJson(response, 200, { fingerprint: command.fingerprint, needsHuman: released.needsHuman })
  }
}
