import { createHash, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  NONCE_HEADER,
  ReplayGuard,
  precheckSignedRequest,
  signResponse,
  verifySignedRequest,
} from '@ykurilov/remontnik-core/signed-http'
import type { Report, Reports } from '../reports/index.js'
import { claimNonce, headerValue, readLimitedBody, refuse, sendJson, type IntakeHandler } from './http-kit.js'

// Лента отчётов для Paseo (R13, contracts/doctor-api.md): `GET /v1/reports` и `POST /v1/reports/ack`.
// Два вида доступа, оба закрытые:
//  - `bridge`: подписанный запрос моста (метод, путь с запросом, отметка времени, разовая метка, тело), повтор подписи
//    отсекается, ответ подписан и привязан к разовой метке запроса. Этот обработчик вешается только на адрес частной сети;
//  - `token`: ключ владельца в `Authorization: Bearer` — для команд `reports pull|ack` по SSH, когда моста нет.
// Подписать можно только ответ на запрос, чья подпись уже проверена: иначе любой выбрал бы метку и получил подпись врача.

export const FEED_DEFAULT_LIMIT = 50
export const FEED_MAX_LIMIT = 100
/** Мост принимает ответ не больше 256 КиБ: страница собирается с запасом. */
export const FEED_PAGE_BYTES = 200_000
const ACK_BODY_LIMIT_BYTES = 16 * 1024
const ACK_BODY_TIMEOUT_MS = 10_000

export type ReportsFeedAccess =
  | { kind: 'bridge'; secret: string; appName: string; replayGuard?: ReplayGuard }
  | { kind: 'token'; token: string }

export interface ReportsFeedOptions {
  reports: Pick<Reports, 'list' | 'paseoAcked' | 'ackPaseo'>
  access: ReportsFeedAccess
  bodyTimeoutMs?: number
  now?: () => number
}

interface Answer {
  status: number
  body: unknown
  /** Ответ можно подписать: запрос уже прошёл проверку подписи. */
  signed: boolean
}

const unsigned = (status: number, error: string): Answer => ({ status, body: { error }, signed: false })

function digest(value: string): Buffer {
  return createHash('sha256').update(value).digest()
}

function bearerMatches(request: IncomingMessage, token: string): boolean {
  const header = headerValue(request, 'authorization') ?? ''
  const match = /^Bearer (.+)$/.exec(header)
  return match !== null && timingSafeEqual(digest(match[1]!), digest(token))
}

function nonNegativeInteger(value: string | null, fallback: number): number | null {
  if (value === null) return fallback
  if (!/^\d{1,15}$/.test(value)) return null
  return Number(value)
}

/** Отчёт для моста: поля из договора, без внутренней отметки Telegram. */
function feedView(report: Report) {
  return {
    reportId: report.reportId,
    ...(report.caseId === undefined ? {} : { caseId: report.caseId }),
    type: report.type,
    short: report.short,
    full: report.full,
    createdAt: report.createdAt,
  }
}

export function createReportsFeedHandler(options: ReportsFeedOptions): IntakeHandler {
  const { reports, access } = options
  if (access.kind === 'token' && access.token === '') throw new Error('[remontnik] ключ доступа к ленте отчётов пуст')
  if (access.kind === 'bridge' && access.secret === '') throw new Error('[remontnik] секрет моста пуст')
  const replayGuard = access.kind === 'bridge' ? (access.replayGuard ?? new ReplayGuard()) : null
  const now = options.now ?? Date.now
  /** Запросы, подписанные до запуска врача, не принимаются: память повторов после перезапуска пуста. */
  const startedAt = now()

  async function getReports(url: URL): Promise<Answer> {
    const after = nonNegativeInteger(url.searchParams.get('after'), 0)
    const asked = nonNegativeInteger(url.searchParams.get('limit'), FEED_DEFAULT_LIMIT)
    if (after === null || asked === null || asked < 1) return { status: 400, body: { error: 'bad_request' }, signed: true }

    const page: ReturnType<typeof feedView>[] = []
    let bytes = 0
    for (const report of await reports.list({ after, limit: Math.min(asked, FEED_MAX_LIMIT) })) {
      const view = feedView(report)
      bytes += Buffer.byteLength(JSON.stringify(view))
      // Один отчёт идёт всегда: иначе большой отчёт застрял бы в ленте навсегда.
      if (page.length > 0 && bytes > FEED_PAGE_BYTES) break
      page.push(view)
    }
    return { status: 200, body: { reports: page, last: page.at(-1)?.reportId ?? after, acked: await reports.paseoAcked() }, signed: true }
  }

  async function postAck(body: string): Promise<Answer> {
    let parsed: unknown
    try {
      parsed = JSON.parse(body)
    } catch {
      return { status: 400, body: { error: 'bad_json' }, signed: true }
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return { status: 400, body: { error: 'bad_request' }, signed: true }
    const { app, upTo } = parsed as { app?: unknown; upTo?: unknown }
    // Мост подтверждает так, как в таблице договора: `{ upTo }`. Секрет и так привязан к приложению, поэтому `app` не обязателен;
    // если указан, должен совпасть. Чужое приложение отвечает так же, как неверная подпись: имена приложений не перебрать.
    if (access.kind === 'bridge' && app !== undefined) {
      if (typeof app !== 'string') return { status: 400, body: { error: 'bad_request' }, signed: true }
      if (app !== access.appName) return unsigned(401, 'bad_signature')
    }
    if (typeof upTo !== 'number') return { status: 400, body: { error: 'bad_request' }, signed: true }
    try {
      return { status: 200, body: { ok: true, acked: await reports.ackPaseo(upTo) }, signed: true }
    } catch (error) {
      if (error instanceof RangeError) return { status: 400, body: { error: 'bad_request' }, signed: true }
      throw error
    }
  }

  function reply(request: IncomingMessage, response: ServerResponse, answer: Answer): void {
    const text = JSON.stringify(answer.body)
    const headers: Record<string, string> = { 'content-type': 'application/json' }
    const nonce = headerValue(request, NONCE_HEADER)
    if (access.kind === 'bridge' && answer.signed && nonce) {
      Object.assign(
        headers,
        signResponse({ request: { method: request.method ?? 'GET', target: request.url ?? '/', nonce }, status: answer.status, body: text, secret: access.secret, now: now() }),
      )
    }
    if (response.headersSent) return
    response.writeHead(answer.status, headers)
    response.end(text)
  }

  return async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://doctor.invalid')
    const route = request.method === 'GET' && url.pathname === '/v1/reports' ? 'pull' : request.method === 'POST' && url.pathname === '/v1/reports/ack' ? 'ack' : null
    if (!route) {
      sendJson(response, 404, { error: 'not_found' })
      return
    }

    if (access.kind === 'token' && !bearerMatches(request, access.token)) {
      refuse(request, response, 401, { error: 'unauthorized' })
      return
    }
    if (access.kind === 'bridge') {
      // Всё, что видно по заголовкам, решается до чтения тела: вид подписи и метки, время, повтор метки.
      const early = precheckSignedRequest({ headers: request.headers, now: now(), notBefore: startedAt })
      if (!early.ok) {
        refuse(request, response, 401, { error: early.reason })
        return
      }
      if (replayGuard!.wasSeen(headerValue(request, NONCE_HEADER)!, now())) {
        refuse(request, response, 401, { error: 'replayed' })
        return
      }
    }

    let body = ''
    if (route === 'ack') {
      const read = await readLimitedBody(request, ACK_BODY_LIMIT_BYTES, options.bodyTimeoutMs ?? ACK_BODY_TIMEOUT_MS)
      if (!read.ok) {
        if (read.reason === 'too_large') refuse(request, response, 413, { error: 'too_large' })
        else if (read.reason === 'timeout') refuse(request, response, 408, { error: 'body_timeout' })
        else request.destroy()
        return
      }
      body = read.body
    }

    if (access.kind === 'bridge') {
      const check = verifySignedRequest({
        method: request.method ?? 'GET',
        target: request.url ?? '/',
        body,
        headers: request.headers,
        secret: access.secret,
        now: now(),
        notBefore: startedAt,
      })
      if (!check.ok) {
        reply(request, response, unsigned(401, check.reason))
        return
      }
      const claimed = claimNonce(replayGuard!, headerValue(request, NONCE_HEADER)!, now())
      if (claimed) {
        reply(request, response, { ...claimed, signed: true })
        return
      }
    }

    reply(request, response, route === 'pull' ? await getReports(url) : await postAck(body))
  }
}
