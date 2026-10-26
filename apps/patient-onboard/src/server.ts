import { randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { SESSION_COOKIE, createSessionStore } from './auth/sessions.ts'
import { createBot } from './bot/bot.ts'
import { createConversationLog, type FinishedConversation } from './bot/conversations.ts'
import { ModelProviderError } from './bot/fake-model.ts'
import type { ToolError } from './bot/tools.ts'
import type { PatientBug } from './bugs.ts'
import { chargeForPlan } from './payments/charge.ts'
import { cabinetPage, captchaFramePage, captchaPage, chatPage, confirmCodePage, framesPage, frameTextPage, homePage, loginPage, loginRerenderPage, settingsPage } from './pages.ts'

/** Сбой, который «Пациент» отдаёт наружу. Сюда подключается сторож Ремонтника. */
export type PatientErrorReport =
  | { kind: 'crash'; error: Error; where: string }
  | { kind: 'model_error'; error: Error; model: string; provider: string }
  | { kind: 'tool_error'; error: Error; tool: string }

export interface PatientServerOptions {
  bug?: PatientBug | null
  version?: string
  reportError?: (report: PatientErrorReport) => void
  /** Падение процесса при PATIENT_BUG=crash; в тестах подменяется. */
  crashProcess?: (error: Error) => void
  /** Разговор закончился: пользователь ушёл (`POST /api/chat/finish`) или долго молчит. Сюда подключается сторож. */
  conversationFinished?: (conversation: FinishedConversation) => void
  /** Через сколько молчания разговор считается законченным; по умолчанию 30 минут. */
  conversationIdleMs?: number
  /** Обновление от бота тревог (webhook `POST /telegram/alerts`). Сюда подключается стоп-кран Ремонтника. */
  alertBotUpdate?: (update: Record<string, unknown>) => Promise<Record<string, unknown> | null>
  /** Секрет webhook бота тревог: Telegram присылает его в заголовке `x-telegram-bot-api-secret-token`. */
  alertBotSecret?: string
}

const MAX_BODY_BYTES = 64 * 1024

class HttpError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    size += (chunk as Buffer).length
    if (size > MAX_BODY_BYTES) throw new HttpError(413, 'слишком большой запрос')
    chunks.push(chunk as Buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  try {
    const value: unknown = JSON.parse(await readBody(request))
    if (value !== null && typeof value === 'object') return value as Record<string, unknown>
  } catch (error) {
    if (error instanceof HttpError) throw error
  }
  throw new HttpError(400, 'ожидается JSON-объект')
}

function send(response: ServerResponse, status: number, body: string, contentType: string, headers: Record<string, string> = {}): void {
  response.writeHead(status, { 'content-type': contentType, ...headers })
  response.end(body)
}

const sendHtml = (response: ServerResponse, html: string, status = 200) => send(response, status, html, 'text/html; charset=utf-8')
const sendJson = (response: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) =>
  send(response, status, JSON.stringify(body), 'application/json; charset=utf-8', headers)

// Посетитель чата без входа: сервер выдаёт ему случайную метку в куке и по ней находит его разговор.
const VISITOR_COOKIE = 'patient_chat'
const VISITOR_ID = /^[0-9a-f]{32}$/

function parseVisitor(cookieHeader: string | undefined): string | null {
  const value = (cookieHeader ?? '')
    .split(';')
    .map((part) => part.trim().split('='))
    .find(([name]) => name === VISITOR_COOKIE)?.[1]
  return value !== undefined && VISITOR_ID.test(value) ? value : null
}

function visitorOf(cookieHeader: string | undefined): { id: string; isNew: boolean } {
  const known = parseVisitor(cookieHeader)
  return known ? { id: known, isNew: false } : { id: randomBytes(16).toString('hex'), isNew: true }
}

const visitorCookie = (id: string) => `${VISITOR_COOKIE}=${id}; Path=/; HttpOnly; SameSite=Lax`

function redirect(response: ServerResponse, location: string, headers: Record<string, string> = {}): void {
  response.writeHead(303, { location, ...headers })
  response.end()
}

export function createPatientServer(options: PatientServerOptions = {}): Server {
  const bug = options.bug ?? null
  const version = options.version ?? 'dev'
  const reportError = options.reportError ?? ((report: PatientErrorReport) => console.error(`[patient] ${report.kind}:`, report.error))
  const sessions = createSessionStore()
  const bot = createBot({
    bug,
    onHandledError: (error: ToolError) => reportError({ kind: 'tool_error', error, tool: error.tool }),
    ...(options.crashProcess ? { crashProcess: options.crashProcess } : {}),
  })

  const conversations = createConversationLog({
    onFinished: options.conversationFinished ?? (() => {}),
    ...(options.conversationIdleMs === undefined ? {} : { idleAfterMs: options.conversationIdleMs }),
  })

  async function route(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const path = new URL(request.url ?? '/', 'http://patient.invalid').pathname
    const key = `${request.method} ${path}`

    switch (key) {
      case 'GET /':
        return sendHtml(response, homePage())
      case 'GET /health':
        return send(response, 200, 'ok', 'text/plain; charset=utf-8')
      case 'GET /version':
        return sendJson(response, 200, { version })
      case 'GET /login':
        return sendHtml(response, loginPage())
      case 'POST /login': {
        const form = new URLSearchParams(await readBody(request))
        const sessionId = sessions.logIn(form.get('login') ?? '', form.get('password') ?? '')
        if (!sessionId) return sendHtml(response, loginPage(true), 401)
        return redirect(response, '/cabinet', {
          'set-cookie': `${SESSION_COOKIE}=${sessionId}; Path=/; HttpOnly; SameSite=Lax`,
        })
      }
      case 'GET /cabinet':
        if (!sessions.isLoggedIn(request.headers.cookie)) return redirect(response, '/login')
        return sendHtml(response, cabinetPage())
      case 'POST /api/pay': {
        if (!sessions.isLoggedIn(request.headers.cookie)) return sendJson(response, 401, { error: 'нужен вход' })
        const { plan } = await readJson(request)
        return sendJson(response, 200, chargeForPlan(String(plan ?? ''), bug))
      }
      case 'GET /captcha':
        return sendHtml(response, captchaPage())
      case 'GET /captcha-frame':
        return sendHtml(response, captchaFramePage())
      case 'GET /confirm-code':
        return sendHtml(response, confirmCodePage())
      case 'GET /login-rerender':
        return sendHtml(response, loginRerenderPage())
      case 'GET /settings':
        return sendHtml(response, settingsPage())
      case 'GET /frames':
        return sendHtml(response, framesPage())
      case 'GET /frame-text':
        return sendHtml(response, frameTextPage(new URL(request.url ?? '/', 'http://patient.invalid').searchParams.get('who') ?? 'own'))
      case 'GET /chat':
        return sendHtml(response, chatPage(bug))
      case 'POST /api/chat': {
        const { message } = await readJson(request)
        if (typeof message !== 'string' || message.trim() === '') throw new HttpError(400, 'пустое сообщение')
        try {
          const reply = await bot.reply(message)
          // Посетителя узнаём по куке, которую выдаёт сервер; номер разговора тоже выдаёт сервер.
          const visitor = visitorOf(request.headers.cookie)
          const conversationId = conversations.record(visitor.id, message, reply)
          return sendJson(response, 200, { reply, conversationId }, visitor.isNew ? { 'set-cookie': visitorCookie(visitor.id) } : {})
        } catch (error) {
          if (!(error instanceof ModelProviderError)) throw error
          reportError({ kind: 'model_error', error, model: error.model, provider: error.provider })
          return sendJson(response, 502, { error: 'модель недоступна, попробуйте позже' })
        }
      }
      case 'POST /telegram/alerts': {
        if (!options.alertBotUpdate || !options.alertBotSecret || request.headers['x-telegram-bot-api-secret-token'] !== options.alertBotSecret) {
          return sendJson(response, 404, { error: 'не найдено' })
        }
        return sendJson(response, 200, (await options.alertBotUpdate(await readJson(request))) ?? { ok: true })
      }
      case 'POST /api/chat/finish': {
        // Закрывается только разговор самого посетителя; чужой номер или его отсутствие значения не имеют.
        const visitor = parseVisitor(request.headers.cookie)
        if (!visitor || !conversations.finish(visitor)) return sendJson(response, 404, { error: 'разговор не найден' })
        return sendJson(response, 200, { finished: true })
      }
      default:
        return sendJson(response, 404, { error: 'не найдено' })
    }
  }

  const server = createServer((request, response) => {
    route(request, response).catch((error: unknown) => {
      if (error instanceof HttpError) return sendJson(response, error.status, { error: error.message })
      const failure = error instanceof Error ? error : new Error(String(error))
      reportError({ kind: 'crash', error: failure, where: `${request.method} ${request.url}` })
      if (!response.headersSent) sendJson(response, 500, { error: 'внутренняя ошибка' })
    })
  })
  // Молчащие разговоры закрываются сами; таймер не держит процесс и уходит вместе с сервером.
  const sweeper = setInterval(() => conversations.finishIdle(), 60_000)
  sweeper.unref()
  server.on('close', () => clearInterval(sweeper))
  return server
}
