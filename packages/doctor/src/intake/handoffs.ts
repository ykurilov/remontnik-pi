import type { IncomingMessage, ServerResponse } from 'node:http'
import { NONCE_HEADER, ReplayGuard, precheckSignedRequest, signResponse, verifySignedRequest } from '@ykurilov/remontnik-core/signed-http'
import { HANDOFF_COLLECTION, handoffKey, type Handoff, type HandoffResult } from '../handoff/index.js'
import type { RecordStore, RecordTransaction } from '../records/index.js'
import { claimNonce, headerValue, readLimitedBody, refuse, type IntakeHandler } from './http-kit.js'

// Команды агента Paseo через мост (contracts/doctor-api.md): `POST /v1/handoffs/:caseId/accepted|result`.
// Только на адресе частной сети и только с подписью моста; ответ подписан и привязан к разовой метке запроса.
// Правит случай один: врач забрал случай — «взял» отвечает `409 reclaimed`, итог пишется только в `lateResult`.
// Поздняя выкатка агента не теряется: врач берёт её под наблюдение под этим же случаем (`adoptLateDeployIn`).

const BODY_LIMIT_BYTES = 16 * 1024
const BODY_TIMEOUT_MS = 10_000
const COMMIT = /^[0-9a-f]{7,40}$/
const VERSION = /^[A-Za-z0-9._+-]{1,100}$/
const TASK_ID = /^[0-9A-HJKMNP-TV-Z]{26}$/
const REASON_LIMIT = 1_000
const AGENT_LIMIT = 200

export interface HandoffsHandlerOptions {
  records: RecordStore
  secret: string
  appName: string
  /** Общая с лентой отчётов память подписей: одну подпись не принять дважды ни там, ни здесь. */
  replayGuard?: ReplayGuard
  /** Внутри транзакции позднего итога: выкатку агента взять под наблюдение, если лечение случая уже закончилось. */
  adoptLateDeployIn?(records: RecordTransaction, caseId: number): Promise<void>
  bodyTimeoutMs?: number
  /** Часы подписей: отметки времени моста. */
  now?: () => number
  /** Часы врача: время «взял» и итога в документе передачи. */
  clock?: () => number
}

interface Answer {
  status: number
  body: unknown
  signed: boolean
}

const answer = (status: number, body: unknown): Answer => ({ status, body, signed: true })
const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)

function parseResult(body: Record<string, unknown>): HandoffResult | undefined {
  if (body.kind === 'done') {
    const { commit, version, deployed } = body
    if (commit !== undefined && (typeof commit !== 'string' || !COMMIT.test(commit))) return undefined
    if (version !== undefined && (typeof version !== 'string' || !VERSION.test(version))) return undefined
    if (typeof deployed !== 'boolean' || deployed !== (version !== undefined)) return undefined
    return { kind: 'done', ...(commit === undefined ? {} : { commit: commit as string }), deployed, ...(version === undefined ? {} : { version: version as string }) }
  }
  if (body.kind === 'cannot') {
    const { reason } = body
    if (typeof reason !== 'string' || reason.trim() === '' || reason.length > REASON_LIMIT) return undefined
    return { kind: 'cannot', reason }
  }
  return undefined
}

const sameResult = (left: HandoffResult | undefined, right: HandoffResult) => left !== undefined && JSON.stringify({ ...left, receivedAt: undefined }) === JSON.stringify(right)

export function createHandoffsHandler(options: HandoffsHandlerOptions): IntakeHandler {
  if (options.secret === '') throw new Error('[remontnik] секрет моста пуст')
  const replayGuard = options.replayGuard ?? new ReplayGuard()
  const now = options.now ?? Date.now
  const clock = options.clock ?? now
  /** Запросы, подписанные до запуска врача, не принимаются: память повторов после перезапуска пуста. */
  const startedAt = now()

  async function accepted(caseId: number, body: Record<string, unknown>): Promise<Answer> {
    const { taskId, agent } = body
    if (typeof taskId !== 'string' || !TASK_ID.test(taskId) || typeof agent !== 'string' || agent.length > AGENT_LIMIT) return answer(400, { error: 'bad_request' })
    if (!(await options.records.read<Handoff>(HANDOFF_COLLECTION, handoffKey(caseId)))) return answer(404, { error: 'unknown_case' })
    return options.records.transaction(async (tx) => {
      const handoff = await tx.doc<Handoff>(HANDOFF_COLLECTION, handoffKey(caseId), {} as Handoff)
      if (handoff.taskId !== taskId) return answer(404, { error: 'unknown_task' })
      if (handoff.owner !== 'paseo') return answer(409, { error: 'reclaimed' })
      if (!handoff.acceptedAt) {
        handoff.acceptedAt = new Date(clock()).toISOString()
        handoff.agent = agent
      }
      return answer(200, { ok: true })
    })
  }

  async function result(caseId: number, body: Record<string, unknown>): Promise<Answer> {
    const { taskId } = body
    const outcome = parseResult(body)
    if (typeof taskId !== 'string' || !TASK_ID.test(taskId) || !outcome) return answer(400, { error: 'bad_request' })
    if (!(await options.records.read<Handoff>(HANDOFF_COLLECTION, handoffKey(caseId)))) return answer(404, { error: 'unknown_case' })
    return options.records.transaction(async (tx) => {
      const handoff = await tx.doc<Handoff>(HANDOFF_COLLECTION, handoffKey(caseId), {} as Handoff)
      if (handoff.taskId !== taskId) return answer(404, { error: 'unknown_task' })
      const at = new Date(clock()).toISOString()
      if (handoff.owner !== 'paseo') {
        if (handoff.lateResult) return sameResult(handoff.lateResult, outcome) ? answer(200, { ok: true, late: true }) : answer(409, { error: 'result_already_sent' })
        handoff.lateResult = { ...outcome, receivedAt: at }
        await options.adoptLateDeployIn?.(tx, caseId)
        return answer(200, { ok: true, late: true })
      }
      if (handoff.result) return sameResult(handoff.result, outcome) ? answer(200, { ok: true }) : answer(409, { error: 'result_already_sent' })
      handoff.result = outcome
      handoff.finishedAt = at
      return answer(200, { ok: true })
    })
  }

  function reply(request: IncomingMessage, response: ServerResponse, sent: Answer): void {
    const text = JSON.stringify(sent.body)
    const headers: Record<string, string> = { 'content-type': 'application/json' }
    const nonce = headerValue(request, NONCE_HEADER)
    if (sent.signed && nonce) {
      Object.assign(headers, signResponse({ request: { method: request.method ?? 'POST', target: request.url ?? '/', nonce }, status: sent.status, body: text, secret: options.secret, now: now() }))
    }
    if (response.headersSent) return
    response.writeHead(sent.status, headers)
    response.end(text)
  }

  return async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://doctor.invalid')
    const route = /^\/v1\/handoffs\/([1-9]\d{0,14})\/(accepted|result)$/.exec(url.pathname)
    if (request.method !== 'POST' || !route) {
      refuse(request, response, 404, { error: 'not_found' })
      return
    }
    // Всё, что видно по заголовкам, решается до чтения тела: вид подписи и метки, время, повтор метки.
    const early = precheckSignedRequest({ headers: request.headers, now: now(), notBefore: startedAt })
    if (!early.ok) {
      refuse(request, response, 401, { error: early.reason })
      return
    }
    if (replayGuard.wasSeen(headerValue(request, NONCE_HEADER)!, now())) {
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
    const check = verifySignedRequest({ method: 'POST', target: request.url ?? '/', body: read.body, headers: request.headers, secret: options.secret, now: now(), notBefore: startedAt })
    if (!check.ok) {
      reply(request, response, { status: 401, body: { error: check.reason }, signed: false })
      return
    }
    const claimed = claimNonce(replayGuard, headerValue(request, NONCE_HEADER)!, now())
    if (claimed) {
      reply(request, response, answer(claimed.status, claimed.body))
      return
    }
    let body: unknown
    try {
      body = JSON.parse(read.body)
    } catch {
      reply(request, response, answer(400, { error: 'bad_json' }))
      return
    }
    if (!isObject(body)) {
      reply(request, response, answer(400, { error: 'bad_request' }))
      return
    }
    // Секрет и так привязан к приложению: `app` не обязателен, но если указан — должен совпасть. Чужое приложение
    // отвечает так же, как неверная подпись: имена приложений не перебрать.
    const { app } = body
    if (app !== undefined && app !== options.appName) {
      reply(request, response, { status: 401, body: { error: 'bad_signature' }, signed: false })
      return
    }
    const caseId = Number(route[1])
    reply(request, response, route[2] === 'accepted' ? await accepted(caseId, body) : await result(caseId, body))
  }
}
