import { randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { assertPrivateAddress } from '@ykurilov/remontnik-core/private-address'

// Прокси модели для eval. Настоящие ключи провайдеров живут только у врача: контейнер eval получает
// адрес прокси (`baseUrlEnv`) и одноразовый токен прогона (в `tokenEnv` и вместо ключа в `keyEnv`).
// Расход идёт в учёт отсюда, а не из файла итога eval, который пишет код правки.
//
// Пропускается только `POST` на чат, `responses` и эмбеддинги, и только для моделей из белого списка с ценами.
// Перед отправкой прокси бронирует наибольшую цену запроса: вход по размеру тела плюс предел ответа
// (`max_tokens`; нет — подставляется из настройки) по цене выхода. Бронь записывается в учёт врача
// до отправки, с ожиданием записи: после падения врача она видна. Запрос, который вместе с бронями
// запросов в пути не влезает в долю прогона, получает 402, и прогон прерывается (`overBudget`).
// После ответа бронь меняется на факт по `usage`; обрыв, тайм-аут, слишком большой ответ или успешный
// ответ без `usage` засчитываются всей бронью. Поток идёт в eval по ходу чтения.
// Память врача ограничена пределами тела запроса, ответа и числа одновременных запросов.

export interface EvalModelPrice {
  /** Долларов за миллион токенов. */
  input: number
  output: number
}

export interface EvalProxyProvider {
  /** Часть адреса прокси: `<url>/<токен>/<name>/…`. */
  name: string
  /** Переменная, в которой eval ищет адрес провайдера. */
  baseUrlEnv: string
  /** Переменная ключа: eval получает в ней токен прогона, а не ключ. */
  keyEnv: string
  /** Настоящий адрес провайдера; путь запроса не выходит за него. */
  upstream: string
  authHeader: 'authorization' | 'x-api-key'
  /** Белый список моделей с ценами. */
  models: Readonly<Record<string, EvalModelPrice>>
  /** Настоящий ключ — из окружения врача. */
  key: string
}

export interface EvalProxyLimits {
  maxRequestBytes: number
  maxResponseBytes: number
  maxConcurrentRequests: number
  /** Предел ответа, который прокси вставляет в запрос без своего. */
  maxOutputTokens: number
}

export interface EvalSpend {
  /** Факт по законченным запросам. */
  spentUsd: number
  /** Брони запросов, которые ушли к модели и ещё не вернулись. */
  inFlightUsd: number
}

export interface EvalProxyRunOptions {
  providers: readonly EvalProxyProvider[]
  /** Переменная с токеном прогона. */
  tokenEnv: string
  budgetUsd: number
  limits: EvalProxyLimits
  /** Расход прогона; перед отправкой запроса прокси ждёт, пока запись о брони закончится. */
  onSpend?: (spend: EvalSpend) => Promise<void> | void
}

export interface EvalProxyRun {
  token: string
  /** Переменные для контейнера eval: адреса прокси и токен. Ключей здесь нет. */
  env: Record<string, string>
  /** Прерывается, когда запрос не влез в долю бюджета (402). */
  overBudget: AbortSignal
  spentUsd(): number
  /** Токен больше не действует; ждёт запросы, которые ещё идут. */
  close(): Promise<void>
}

export interface EvalProxy {
  url: string
  openRun(options: EvalProxyRunOptions): EvalProxyRun
  close(): Promise<void>
}

export interface EvalProxyOptions {
  /** Только адрес частной сети. */
  listen: { host: string; port: number }
  /** Адрес прокси, как его видит контейнер eval (тоже частный); по умолчанию — адрес, на котором он слушает. */
  publicUrl?: string
  upstreamTimeoutMs?: number
}

const UPSTREAM_TIMEOUT_MS = 300_000
const TOKENS_PER_MTOK = 1_000_000
// Вход в брони — с запасом: кириллица и служебный JSON дают больше токенов на байт, чем английский текст.
const RESERVE_BYTES_PER_TOKEN = 3
// Заголовки, которые не уходят провайдеру: доступ, куки, сведения о сети и то, что fetch ставит сам.
const DROPPED_HEADERS = new Set([
  'host',
  'connection',
  'keep-alive',
  'upgrade',
  'te',
  'trailer',
  'transfer-encoding',
  'content-length',
  'accept-encoding',
  'authorization',
  'proxy-authorization',
  'x-api-key',
  'api-key',
  'cookie',
  'forwarded',
  'x-real-ip',
])
// Закодированный слэш провайдер может раскодировать уже после проверки пути.
const ENCODED_SEPARATOR = /%2f|%5c|\\/i
// Белый список путей под адресом провайдера; регистр важен.
const ENDPOINTS: Record<string, Endpoint> = {
  'chat/completions': 'chat',
  messages: 'messages',
  responses: 'responses',
  embeddings: 'embeddings',
}
const ENDPOINT_PATH = /^(?:\/v1)?\/(chat\/completions|messages|responses|embeddings)$/
// Поля предела ответа: есть хоть одно — берётся наибольшее; нет — вставляется своё поле точки.
const OUTPUT_LIMIT_FIELDS = ['max_tokens', 'max_completion_tokens', 'max_output_tokens'] as const
const DEFAULT_OUTPUT_LIMIT_FIELD: Record<Endpoint, (typeof OUTPUT_LIMIT_FIELDS)[number] | undefined> = {
  chat: 'max_tokens',
  messages: 'max_tokens',
  responses: 'max_output_tokens',
  embeddings: undefined,
}

type Endpoint = 'chat' | 'messages' | 'responses' | 'embeddings'

class Refusal extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

interface Usage {
  cost?: number
  input: number
  output: number
}

function usageIn(value: unknown, usage: Usage): void {
  if (typeof value !== 'object' || value === null) return
  const record = value as Record<string, unknown>
  const number = (key: string) => (typeof record[key] === 'number' && (record[key] as number) >= 0 ? (record[key] as number) : undefined)
  const cost = number('cost')
  if (cost !== undefined) usage.cost = Math.max(usage.cost ?? 0, cost)
  const input =
    (number('prompt_tokens') ?? number('input_tokens') ?? number('promptTokenCount') ?? 0) +
    (number('cache_creation_input_tokens') ?? 0) +
    (number('cache_read_input_tokens') ?? 0)
  const output = (number('completion_tokens') ?? number('output_tokens') ?? number('candidatesTokenCount') ?? 0) + (number('thoughtsTokenCount') ?? 0)
  usage.input = Math.max(usage.input, input)
  usage.output = Math.max(usage.output, output)
}

/** `usage` ответа: целый JSON или поток событий (`data: {…}`); по каждому полю — наибольшее из событий. */
function usageOf(body: string): Usage | undefined {
  const usage: Usage = { input: 0, output: 0 }
  let found = false
  const events: unknown[] = []
  try {
    events.push(JSON.parse(body))
  } catch {
    for (const line of body.split('\n')) {
      const data = line.match(/^data:\s*(.+)$/)?.[1]
      if (!data || data === '[DONE]') continue
      try {
        events.push(JSON.parse(data))
      } catch {
        // не JSON — не событие с расходом
      }
    }
  }
  for (const event of events) {
    if (typeof event !== 'object' || event === null) continue
    const record = event as Record<string, unknown>
    for (const candidate of [record.usage, (record.message as Record<string, unknown> | undefined)?.usage, (record.response as Record<string, unknown> | undefined)?.usage, record.usageMetadata]) {
      if (typeof candidate !== 'object' || candidate === null) continue
      found = true
      usageIn(candidate, usage)
    }
  }
  return found ? usage : undefined
}

function priceOf(usage: Usage, price: EvalModelPrice): number {
  return usage.cost ?? (usage.input * price.input + usage.output * price.output) / TOKENS_PER_MTOK
}

/** Стоимость ответа по его `usage`: готовая `cost`, иначе токены × цены модели (кэш — по цене входа). Нет `usage` — `undefined`. */
export function usageCostUsd(body: string, price: EvalModelPrice): number | undefined {
  const usage = usageOf(body)
  return usage ? priceOf(usage, price) : undefined
}

/** `usage` по ходу чтения: поток событий разбирается построчно, обычный ответ копится до конца (не больше предела ответа). */
function createUsageMeter(contentType: string) {
  const decoder = new TextDecoder()
  const stream = /text\/event-stream/i.test(contentType)
  let usage: Usage | undefined
  let text = ''
  const takeLines = (lines: string[]) => {
    const found = usageOf(lines.join('\n'))
    if (!found) return
    usage ??= { input: 0, output: 0 }
    if (found.cost !== undefined) usage.cost = Math.max(usage.cost ?? 0, found.cost)
    usage.input = Math.max(usage.input, found.input)
    usage.output = Math.max(usage.output, found.output)
  }
  return {
    push(chunk: Uint8Array): void {
      text += decoder.decode(chunk, { stream: true })
      if (!stream) return
      const lines = text.split('\n')
      text = lines.pop() ?? ''
      takeLines(lines)
    },
    finish(): Usage | undefined {
      text += decoder.decode()
      takeLines([text])
      return usage
    },
  }
}

/** Адрес у провайдера и точка из белого списка. Выход за адрес провайдера — 400, путь не из списка — 403. */
function upstreamTarget(provider: EvalProxyProvider, rest: string, search: string): { url: URL; endpoint: Endpoint } {
  if (ENCODED_SEPARATOR.test(rest)) throw new Refusal(400, 'путь вне адреса провайдера')
  const base = new URL(provider.upstream)
  const basePath = base.pathname.endsWith('/') ? base.pathname : `${base.pathname}/`
  let url: URL
  try {
    url = new URL(`${base.origin}${basePath.slice(0, -1)}${rest}${search}`)
  } catch {
    throw new Refusal(400, 'путь вне адреса провайдера')
  }
  if (url.origin !== base.origin || !`${url.pathname}/`.startsWith(basePath)) throw new Refusal(400, 'путь вне адреса провайдера')
  const match = ENDPOINT_PATH.exec(rest)
  if (!match) throw new Refusal(403, 'этот путь eval не нужен: только чат, responses и эмбеддинги')
  return { url, endpoint: ENDPOINTS[match[1]!]! }
}

async function readBody(request: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    size += (chunk as Buffer).length
    if (size > limit) throw new Refusal(413, 'запрос слишком большой')
    chunks.push(chunk as Buffer)
  }
  return Buffer.concat(chunks)
}

function positiveInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) throw new Refusal(400, `${field}: нужно целое число больше нуля`)
  return value
}

/** Запрос к модели: модель из белого списка, предел ответа на месте. Возвращает тело для отправки и наибольшую цену. */
function preparedRequest(raw: Buffer, provider: EvalProxyProvider, endpoint: Endpoint, limits: EvalProxyLimits): { body: string; price: EvalModelPrice; reserveUsd: number } {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw.toString('utf8'))
  } catch {
    throw new Refusal(400, 'тело запроса — не JSON')
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Refusal(400, 'тело запроса — не объект JSON')
  const request = parsed as Record<string, unknown>
  const model = request.model
  const price = typeof model === 'string' && Object.hasOwn(provider.models, model) ? provider.models[model]! : undefined
  if (!price) throw new Refusal(403, 'модели нет в списке eval.providers[].models')

  let outputTokens = 0
  const defaultField = DEFAULT_OUTPUT_LIMIT_FIELD[endpoint]
  if (defaultField) {
    const present = OUTPUT_LIMIT_FIELDS.filter((field) => request[field] !== undefined)
    for (const field of present) outputTokens = Math.max(outputTokens, positiveInteger(request[field], field))
    if (present.length === 0) {
      request[defaultField] = limits.maxOutputTokens
      outputTokens = limits.maxOutputTokens
    }
    if (endpoint === 'chat') {
      if (request.n !== undefined) outputTokens *= positiveInteger(request.n, 'n')
      // Без этого поток чата приходит без `usage`, и засчиталась бы вся бронь.
      if (request.stream === true) request.stream_options = { ...(request.stream_options as object | undefined), include_usage: true }
    }
  }
  const body = JSON.stringify(request)
  const inputTokens = Buffer.byteLength(body) / RESERVE_BYTES_PER_TOKEN
  return { body, price, reserveUsd: priceOf({ input: inputTokens, output: outputTokens }, price) }
}

function forwardedHeaders(request: IncomingMessage, provider: EvalProxyProvider): Headers {
  const headers = new Headers()
  for (const [name, value] of Object.entries(request.headers)) {
    if (value === undefined || DROPPED_HEADERS.has(name) || name.startsWith('x-forwarded-') || name.startsWith('proxy-')) continue
    headers.set(name, Array.isArray(value) ? value.join(', ') : value)
  }
  if (provider.authHeader === 'authorization') headers.set('authorization', `Bearer ${provider.key}`)
  else headers.set('x-api-key', provider.key)
  return headers
}

interface OpenRun {
  providers: Map<string, EvalProxyProvider>
  budgetUsd: number
  limits: EvalProxyLimits
  spentUsd: number
  inFlightUsd: number
  active: number
  pending: Set<Promise<void>>
  closed: boolean
  overBudget: AbortController
  onSpend?: (spend: EvalSpend) => Promise<void> | void
}

function urlHost(url: string): string {
  return new URL(url).hostname.replace(/^\[|\]$/g, '')
}

export async function createEvalProxy(options: EvalProxyOptions): Promise<EvalProxy> {
  assertPrivateAddress(options.listen.host, 'адрес прокси eval')
  if (options.publicUrl) assertPrivateAddress(urlHost(options.publicUrl), 'внешний адрес прокси eval (publicUrl)')
  const runs = new Map<string, OpenRun>()
  const upstreamTimeoutMs = options.upstreamTimeoutMs ?? UPSTREAM_TIMEOUT_MS

  async function report(run: OpenRun): Promise<void> {
    await run.onSpend?.({ spentUsd: run.spentUsd, inFlightUsd: run.inFlightUsd })
  }

  function reply(response: ServerResponse, status: number, text: string): void {
    response.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' })
    response.end(text)
  }

  /** Отправка и ответ по ходу чтения. Возвращает, сколько засчитать: факт или вся бронь. */
  async function relay(request: IncomingMessage, response: ServerResponse, run: OpenRun, provider: EvalProxyProvider, url: URL, body: string, reserveUsd: number, price: EvalModelPrice): Promise<number> {
    try {
      const upstream = await fetch(url, { method: 'POST', headers: forwardedHeaders(request, provider), body, redirect: 'manual', signal: AbortSignal.timeout(upstreamTimeoutMs) })
      const contentType = upstream.headers.get('content-type') ?? 'application/octet-stream'
      response.writeHead(upstream.status, { 'content-type': contentType })
      const meter = createUsageMeter(contentType)
      let size = 0
      if (upstream.body) {
        for await (const chunk of upstream.body) {
          size += chunk.length
          if (size > run.limits.maxResponseBytes) throw new Error('ответ провайдера больше предела')
          meter.push(chunk)
          response.write(chunk)
        }
      }
      response.end()
      const usage = meter.finish()
      if (usage) return priceOf(usage, price)
      return upstream.ok ? reserveUsd : 0
    } catch {
      // Обрыв, тайм-аут, слишком большой ответ: провайдер мог успеть сделать всю работу.
      if (!response.headersSent) reply(response, 502, 'провайдер модели не ответил')
      else response.destroy()
      return reserveUsd
    }
  }

  async function forward(request: IncomingMessage, response: ServerResponse, run: OpenRun, provider: EvalProxyProvider, url: URL, endpoint: Endpoint): Promise<void> {
    const { body, price, reserveUsd } = preparedRequest(await readBody(request, run.limits.maxRequestBytes), provider, endpoint, run.limits)
    if (run.spentUsd + run.inFlightUsd + reserveUsd > run.budgetUsd) {
      run.overBudget.abort()
      throw new Refusal(402, 'бюджет eval: запрос не влезает в остаток доли')
    }
    run.inFlightUsd += reserveUsd
    try {
      await report(run)
    } catch {
      run.inFlightUsd -= reserveUsd
      throw new Refusal(503, 'бронь запроса не записалась')
    }
    let chargeUsd = reserveUsd
    try {
      chargeUsd = await relay(request, response, run, provider, url, body, reserveUsd, price)
    } finally {
      run.inFlightUsd -= reserveUsd
      run.spentUsd += chargeUsd
      await report(run).catch(() => {})
    }
  }

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const raw = request.url ?? '/'
    const queryAt = raw.indexOf('?')
    const path = queryAt === -1 ? raw : raw.slice(0, queryAt)
    const search = queryAt === -1 ? '' : raw.slice(queryAt)
    const [, token = '', name = '', ...restParts] = path.split('/')
    const run = runs.get(token)
    if (!run || run.closed) return reply(response, 401, 'неизвестный прогон eval')
    const provider = run.providers.get(name)
    if (!provider) return reply(response, 404, 'неизвестный провайдер')
    let target: { url: URL; endpoint: Endpoint }
    try {
      target = upstreamTarget(provider, `/${restParts.join('/')}`, search)
      if (request.method !== 'POST') throw new Refusal(403, 'только POST')
    } catch (error) {
      if (error instanceof Refusal) return reply(response, error.status, error.message)
      throw error
    }
    if (run.active >= run.limits.maxConcurrentRequests) return reply(response, 429, 'слишком много одновременных запросов eval')
    run.active += 1
    const done = forward(request, response, run, provider, target.url, target.endpoint).catch((error: unknown) => {
      if (!(error instanceof Refusal)) throw error
      reply(response, error.status, error.message)
    })
    const tracked = done.finally(() => {
      run.active -= 1
      run.pending.delete(tracked)
    })
    run.pending.add(tracked)
    await tracked
  }

  const server: Server = createServer((request, response) => {
    // Eval мог уйти, не дочитав ответ: запись в закрытое соединение — не сбой прокси.
    response.on('error', () => {})
    handle(request, response).catch(() => {
      if (!response.headersSent) reply(response, 500, 'сбой прокси')
      else response.destroy()
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.listen.port, options.listen.host, () => {
      server.off('error', reject)
      resolve()
    })
  })
  const { port } = server.address() as AddressInfo
  const url = (options.publicUrl ?? `http://${options.listen.host.includes(':') ? `[${options.listen.host}]` : options.listen.host}:${port}`).replace(/\/$/, '')

  return {
    url,
    openRun(runOptions) {
      const token = randomBytes(24).toString('base64url')
      const run: OpenRun = {
        providers: new Map(runOptions.providers.map((provider) => [provider.name, provider])),
        budgetUsd: runOptions.budgetUsd,
        limits: runOptions.limits,
        spentUsd: 0,
        inFlightUsd: 0,
        active: 0,
        pending: new Set(),
        closed: false,
        overBudget: new AbortController(),
        ...(runOptions.onSpend ? { onSpend: runOptions.onSpend } : {}),
      }
      runs.set(token, run)
      const env: Record<string, string> = { [runOptions.tokenEnv]: token }
      for (const provider of runOptions.providers) {
        env[provider.baseUrlEnv] = `${url}/${token}/${provider.name}`
        env[provider.keyEnv] = token
      }
      return {
        token,
        env,
        overBudget: run.overBudget.signal,
        spentUsd: () => run.spentUsd,
        async close() {
          run.closed = true
          while (run.pending.size > 0) await Promise.allSettled([...run.pending])
          runs.delete(token)
        },
      }
    },
    close() {
      return new Promise<void>((resolve) => {
        server.close(() => resolve())
        server.closeAllConnections()
      })
    },
  }
}
