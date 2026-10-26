import { NONCE_HEADER, ReplayGuard, precheckSignedRequest, verifySignedRequest } from '@ykurilov/remontnik-core/signed-http'
import type { Controls } from '../ledgers/controls.js'
import { assertOwnerSecrets, claimNonce, headerValue, readLimitedBody, refuse, sendJson, type IntakeHandler } from './http-kit.js'

// Стоп-кран по HTTP (contracts/doctor-api.md): `POST /v1/control/deploys` `{ action: "stop" | "resume", by }`.
// Жмёт кнопку Telegram приложение (или консольная команда): запрос подписан `signRequest` с разовой меткой.
// Остановить можно общим секретом: он есть у приложения. Снова пустить выкатки — только секретом владельца
// `REMONTNIK_CONTROL_SECRET`: утечка общего секрета не должна снимать стоп-кран. Им же — `{ action:
// "confirm_version", version, by }`: владелец подтверждает работающую версию брошенной выкатки, и от неё снова
// можно выкатываться. Повтор метки и подпись раньше запуска врача отвергаются, как у моста.

const BODY_LIMIT_BYTES = 4 * 1024
const BODY_TIMEOUT_MS = 10_000
const BY_MAX_LENGTH = 100
/** Версия — полный хеш коммита (sha1 или sha256). */
const VERSION = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/

export interface DeployControlsOptions {
  controls: Pick<Controls, 'set'>
  secret: string
  /** Секрет владельца: им подписывают пуск и подтверждение версии. Не задан — по HTTP этого не сделать. */
  controlSecret?: string
  /** Снять блок `unconfirmed_version` с версии; `wasBlocked` — была ли она в неподтверждённых. */
  confirmVersion?(version: string): Promise<{ wasBlocked: boolean }>
  replayGuard?: ReplayGuard
  bodyTimeoutMs?: number
  now?: () => number
}

type ControlCommand = { action: 'stop' | 'resume'; by: string } | { action: 'confirm_version'; version: string; by: string }

function parseCommand(body: string): ControlCommand | undefined {
  try {
    const parsed = JSON.parse(body) as { action?: unknown; by?: unknown; version?: unknown } | null
    const action = parsed?.action
    const by = parsed?.by
    if (typeof by !== 'string' || by.trim() === '' || by.length > BY_MAX_LENGTH) return undefined
    if (action === 'stop' || action === 'resume') return { action, by: by.trim() }
    const version = parsed?.version
    if (action === 'confirm_version' && typeof version === 'string' && VERSION.test(version)) return { action, version, by: by.trim() }
    return undefined
  } catch {
    return undefined
  }
}

export function createDeployControlsHandler(options: DeployControlsOptions): IntakeHandler {
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
    const command = parseCommand(read.body)
    if (!command || (command.action === 'confirm_version' && !options.confirmVersion)) {
      sendJson(response, 400, { error: 'bad_request' })
      return
    }
    if (command.action !== 'stop' && !byOwner) {
      sendJson(response, 403, { error: 'control_secret_required' })
      return
    }
    // Метка занимается только запросом, который исполнится: отказ по роли память повторов не заполняет.
    const claimed = claimNonce(replayGuard, nonce, now())
    if (claimed) {
      sendJson(response, claimed.status, claimed.body)
      return
    }
    if (command.action === 'confirm_version') {
      const { wasBlocked } = await options.confirmVersion!(command.version)
      sendJson(response, 200, { version: command.version, wasBlocked })
      return
    }
    const { action, by } = command
    const controls = await options.controls.set(action, by)
    sendJson(response, 200, { autoDeploy: controls.autoDeploy })
  }
}
