import { createServer, type IncomingHttpHeaders, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

// Подставные серверы для тестов всех пакетов: Telegram Bot API и OpenAI-совместимая модель.
// Слушают только 127.0.0.1 на свободном порту, в сеть не ходят.

interface RunningServer {
  baseUrl: string
  close(): Promise<void>
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}

function parseJson(text: string): unknown {
  try {
    return text === '' ? null : JSON.parse(text)
  } catch {
    return text
  }
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' })
  response.end(JSON.stringify(body))
}

async function listen(
  handler: (request: IncomingMessage, response: ServerResponse) => Promise<void>,
): Promise<RunningServer & { server: Server }> {
  const server = createServer((request, response) => {
    handler(request, response).catch((error: unknown) => {
      sendJson(response, 500, { error: String(error) })
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    server,
    baseUrl: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
}

// --- Telegram ---------------------------------------------------------------

export interface FakeTelegramMessage {
  botToken: string
  chatId: string
  text: string
  replyMarkup?: unknown
  messageId: number
  headers: IncomingHttpHeaders
}

export interface FakeTelegramServer extends RunningServer {
  /** Принятые сообщения `sendMessage` по порядку. */
  readonly messages: FakeTelegramMessage[]
  /** Следующий запрос получит ошибку Bot API с этим кодом. */
  failNext(status: number, body?: { description?: string; parameters?: { retry_after?: number } }): void
}

export async function startFakeTelegram(): Promise<FakeTelegramServer> {
  const messages: FakeTelegramMessage[] = []
  const failures: { status: number; body: Record<string, unknown> }[] = []
  let nextMessageId = 1

  const running = await listen(async (request, response) => {
    const body = parseJson(await readBody(request)) as Record<string, unknown> | null
    const match = /^\/bot([^/]+)\/(\w+)$/.exec(request.url ?? '')
    if (!match) return sendJson(response, 404, { ok: false, error_code: 404, description: 'Not Found' })
    const failure = failures.shift()
    if (failure) return sendJson(response, failure.status, { ok: false, error_code: failure.status, ...failure.body })
    const [, botToken = '', method] = match
    if (method !== 'sendMessage') return sendJson(response, 200, { ok: true, result: true })

    const message: FakeTelegramMessage = {
      botToken: decodeURIComponent(botToken),
      chatId: String(body?.chat_id ?? ''),
      text: String(body?.text ?? ''),
      messageId: nextMessageId++,
      headers: request.headers,
    }
    if (body?.reply_markup !== undefined) message.replyMarkup = body.reply_markup
    messages.push(message)
    sendJson(response, 200, { ok: true, result: { message_id: message.messageId, chat: { id: message.chatId } } })
  })

  return {
    baseUrl: running.baseUrl,
    close: running.close,
    messages,
    failNext(status, body = {}) {
      failures.push({ status, body: { description: `fake failure ${status}`, ...body } })
    },
  }
}

// --- OpenAI-совместимая модель ----------------------------------------------

export interface FakeModelRequest {
  path: string
  headers: IncomingHttpHeaders
  body: Record<string, unknown>
}

export interface FakeModelUsage {
  promptTokens?: number
  completionTokens?: number
  cachedPromptTokens?: number
  costUsd?: number
}

type FakeModelStep =
  | { kind: 'reply'; content: string; usage: FakeModelUsage }
  | { kind: 'fail'; status: number; body: string }
  | { kind: 'hang' }

export interface FakeModelServer extends RunningServer {
  /** Принятые запросы `/chat/completions` по порядку. */
  readonly requests: FakeModelRequest[]
  /** Следующий ответ модели — этот объект JSON. Без заданных ответов модель отвечает `{}`. */
  replyNext(json: unknown, usage?: FakeModelUsage): void
  /** Следующий ответ модели — сырой текст (например, не JSON). */
  replyTextNext(content: string, usage?: FakeModelUsage): void
  /** Следующий запрос получит HTTP-ошибку. */
  failNext(status: number, body?: string): void
  /** Следующий запрос останется без ответа до закрытия сервера. */
  hangNext(): void
}

export async function startFakeModel(): Promise<FakeModelServer> {
  const requests: FakeModelRequest[] = []
  const steps: FakeModelStep[] = []

  const running = await listen(async (request, response) => {
    const path = request.url ?? ''
    if (request.method !== 'POST' || !path.endsWith('/chat/completions')) {
      return sendJson(response, 404, { error: { message: 'not found' } })
    }
    const body = (parseJson(await readBody(request)) ?? {}) as Record<string, unknown>
    requests.push({ path, headers: request.headers, body })

    const step = steps.shift() ?? { kind: 'reply', content: '{}', usage: {} }
    if (step.kind === 'hang') return
    if (step.kind === 'fail') {
      response.writeHead(step.status, { 'content-type': 'application/json' })
      return void response.end(step.body)
    }
    const { usage } = step
    sendJson(response, 200, {
      id: `fake-${requests.length}`,
      object: 'chat.completion',
      model: body.model,
      choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: step.content } }],
      usage: {
        prompt_tokens: usage.promptTokens ?? 10,
        completion_tokens: usage.completionTokens ?? 5,
        prompt_cache_hit_tokens: usage.cachedPromptTokens ?? 0,
        prompt_tokens_details: { cached_tokens: usage.cachedPromptTokens ?? 0 },
        ...(usage.costUsd === undefined ? {} : { cost: usage.costUsd }),
      },
    })
  })

  return {
    baseUrl: running.baseUrl,
    close: running.close,
    requests,
    replyNext(json, usage = {}) {
      steps.push({ kind: 'reply', content: JSON.stringify(json), usage })
    },
    replyTextNext(content, usage = {}) {
      steps.push({ kind: 'reply', content, usage })
    },
    failNext(status, body = JSON.stringify({ error: { message: `fake failure ${status}` } })) {
      steps.push({ kind: 'fail', status, body })
    },
    hangNext() {
      steps.push({ kind: 'hang' })
    },
  }
}
