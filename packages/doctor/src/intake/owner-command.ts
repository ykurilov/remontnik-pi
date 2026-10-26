import { NONCE_HEADER, ReplayGuard, precheckSignedRequest, verifySignedRequest } from '@ykurilov/remontnik-core/signed-http'
import { assertOwnerSecrets, claimNonce, headerValue, readLimitedBody, refuse, sendJson, type IntakeHandler } from './http-kit.js'

// Команда владельца по HTTP: подписанный `POST` только секретом владельца `REMONTNIK_CONTROL_SECRET`, общий секрет
// есть у приложения. Подпись общим секретом узнаётся (403 `control_secret_required`), но не исполняется.
// Повтор разовой метки и подпись раньше запуска врача отвергаются.

const BODY_LIMIT_BYTES = 4 * 1024
const BODY_TIMEOUT_MS = 10_000
export const BY_MAX_LENGTH = 100

export interface OwnerCommandOptions<C> {
  /** Общий секрет: им подписанный запрос узнаётся, но не исполняется. */
  secret: string
  /** Секрет владельца; не задан — команды по HTTP нет. */
  controlSecret?: string
  replayGuard?: ReplayGuard
  bodyTimeoutMs?: number
  now?: () => number
  /** Тело команды; `undefined` — 400 `bad_request`. */
  parse(body: unknown): C | undefined
  run(command: C): Promise<{ status: number; body: unknown }>
}

/** Кто подал команду (`by`): непустая строка разумной длины. */
export function parseBy(by: unknown): string | undefined {
  return typeof by === 'string' && by.trim() !== '' && by.length <= BY_MAX_LENGTH ? by.trim() : undefined
}

export function createOwnerCommandHandler<C>(options: OwnerCommandOptions<C>): IntakeHandler {
  assertOwnerSecrets(options)
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
    let command: C | undefined
    try {
      command = options.parse(JSON.parse(read.body) as unknown)
    } catch {
      command = undefined
    }
    if (command === undefined) {
      sendJson(response, 400, { error: 'bad_request' })
      return
    }
    if (!byOwner) {
      sendJson(response, 403, { error: 'control_secret_required' })
      return
    }
    // Метка занимается только запросом, который исполнится: отказ по роли память повторов не заполняет.
    const claimed = claimNonce(replayGuard, nonce, now())
    if (claimed) {
      sendJson(response, claimed.status, claimed.body)
      return
    }
    const answer = await options.run(command)
    sendJson(response, answer.status, answer.body)
  }
}
