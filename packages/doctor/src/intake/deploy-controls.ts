import { NONCE_HEADER, ReplayGuard, precheckSignedRequest, verifySignedRequest } from '@ykurilov/remontnik-core/signed-http'
import type { Controls } from '../ledgers/controls.js'
import { headerValue, readLimitedBody, refuse, sendJson, type IntakeHandler } from './http-kit.js'

// Стоп-кран по HTTP (contracts/doctor-api.md): `POST /v1/control/deploys` `{ action: "stop" | "resume", by }`.
// Жмёт кнопку Telegram приложение (или консольная команда): запрос подписан `signRequest` с разовой меткой.
// Остановить можно общим секретом: он есть у приложения. Снова пустить выкатки — только секретом владельца
// `REMONTNIK_CONTROL_SECRET`: утечка общего секрета не должна снимать стоп-кран. Повтор метки и подпись раньше
// запуска врача отвергаются, как у моста.

const BODY_LIMIT_BYTES = 4 * 1024
const BODY_TIMEOUT_MS = 10_000
const BY_MAX_LENGTH = 100

export interface DeployControlsOptions {
  controls: Pick<Controls, 'set'>
  secret: string
  /** Секрет владельца: им подписывают пуск. Не задан — пустить выкатки по HTTP нельзя. */
  controlSecret?: string
  replayGuard?: ReplayGuard
  bodyTimeoutMs?: number
  now?: () => number
}

function parseCommand(body: string): { action: 'stop' | 'resume'; by: string } | undefined {
  try {
    const parsed = JSON.parse(body) as { action?: unknown; by?: unknown } | null
    const action = parsed?.action
    const by = parsed?.by
    if ((action !== 'stop' && action !== 'resume') || typeof by !== 'string' || by.trim() === '' || by.length > BY_MAX_LENGTH) return undefined
    return { action, by: by.trim() }
  } catch {
    return undefined
  }
}

export function createDeployControlsHandler(options: DeployControlsOptions): IntakeHandler {
  if (options.secret === '') throw new Error('[remontnik] общий секрет пуст')
  if (options.controlSecret === '') throw new Error('[remontnik] секрет владельца пуст')
  // Общий секрет знают сторож и кнопки Telegram: равный ему секрет владельца ничего не защищает.
  if (options.controlSecret === options.secret) throw new Error('[remontnik] секрет владельца совпадает с общим секретом')
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
    const { action, by } = command
    if (action === 'resume' && !byOwner) {
      sendJson(response, 403, { error: 'control_secret_required' })
      return
    }
    const controls = await options.controls.set(action, by)
    sendJson(response, 200, { autoDeploy: controls.autoDeploy })
  }
}
