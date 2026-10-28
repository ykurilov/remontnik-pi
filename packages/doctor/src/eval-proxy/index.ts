import { randomBytes } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { isProxyOwnedHeader } from '@ykurilov/remontnik-core/config'
import { assertPrivateAddress } from '@ykurilov/remontnik-core/private-address'
import { createGuardedHttp, type GuardedHttpLimits, type GuardedListener } from '../guarded-http/index.js'

// Прокси модели для eval. Настоящие ключи провайдеров живут только у врача: контейнер eval получает
// адрес прокси (`baseUrlEnv`) и одноразовый токен прогона (в `tokenEnv` и вместо ключа в `keyEnv`).
// Расход идёт в учёт отсюда, а не из файла итога eval, который пишет код правки.
//
// Пропускается только `POST` на чат, `responses` и эмбеддинги, и только для моделей из белого списка с ценами.
// Перед отправкой прокси бронирует наибольшую цену запроса: вход по размеру тела плюс предел ответа
// (`max_tokens`; нет — подставляется из настройки) по цене выхода. Бронь записывается в учёт врача
// до отправки, с ожиданием записи: после падения врача она видна. Запрос, который вместе с бронями
// запросов в пути не влезает в долю прогона, получает 402, и прогон прерывается (`overBudget`).
// После ответа бронь меняется на факт по `usage`: готовая `cost` поставщика, иначе токены × цены модели,
// вход из кэша — по `cachedInput`. Обрыв, тайм-аут, слишком большой ответ или успешный ответ без `usage`
// засчитываются всей бронью, с причиной в журнале врача. Поток идёт в eval по ходу чтения.
// Память врача ограничена пределами тела запроса, ответа и числа одновременных запросов.
// Отказы и сбои идут в журнал врача: метод, путь без пропуска и строки запроса, статус, текст исключения.
// Ключей, значений заголовков и тел в журнале нет.

export interface EvalModelPrice {
  /** Долларов за миллион токенов. */
  input: number
  output: number
  /** Вход из кэша поставщика. Нет — кэш считается по цене `input`, и журнал врача говорит об этом раз за прогон. */
  cachedInput?: number
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
  /**
   * Заголовки к upstream: имя в нижнем регистре и значение из окружения врача. Ставит только прокси;
   * одноимённый заголовок клиента eval не проходит. Заголовки прокси (ключ, `host` и подобные) не ставятся.
   */
  upstreamHeaderValues?: Readonly<Record<string, string>>
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
  /** Сколько запросов с пропуском прогона дошло до прокси, включая отказы. Ноль — eval к прокси не ходил. */
  requests(): number
  /** Токен больше не действует; ждёт запросы, которые ещё идут. */
  close(): Promise<void>
}

export interface EvalProxy {
  url: string
  openRun(options: EvalProxyRunOptions): EvalProxyRun
  /** Слушать ещё и на этом адресе (адрес врача в сети проверок случая), на порту `port`. */
  listen(host: string): Promise<GuardedListener>
  close(): Promise<void>
}

export interface EvalProxyOptions {
  /** Постоянный адрес (только частная сеть). Без него прокси слушает только там, куда его позовут (`listen`). */
  listen?: { host: string; port: number }
  /** Порт для `listen(host)`; по умолчанию 7810. */
  port?: number
  /**
   * Адрес прокси, как его видит контейнер eval: частный адрес или имя без точек (`remontnik-gateway` — врач в сети
   * случая). По умолчанию — постоянный адрес.
   */
  publicUrl?: string
  upstreamTimeoutMs?: number
  /** Пределы соединений: всего, на один контейнер и срок до первого запроса. */
  limits?: Partial<GuardedHttpLimits>
  /** Журнал врача: отказы прокси, ошибки поставщика и сбои соединения. */
  log?: (line: string) => void
}

const UPSTREAM_TIMEOUT_MS = 300_000
const TOKENS_PER_MTOK = 1_000_000
// Вход в брони — с запасом: кириллица и служебный JSON дают больше токенов на байт, чем английский текст.
const RESERVE_BYTES_PER_TOKEN = 3
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
  /** Весь вход, включая кэш. */
  input: number
  /** Часть входа из кэша поставщика. */
  cached: number
  output: number
}

function nonNegative(record: unknown, key: string): number | undefined {
  if (typeof record !== 'object' || record === null) return undefined
  const value = (record as Record<string, unknown>)[key]
  return typeof value === 'number' && value >= 0 ? value : undefined
}

function mergeUsage(into: Usage, from: Usage): void {
  if (from.cost !== undefined) into.cost = Math.max(into.cost ?? 0, from.cost)
  into.input = Math.max(into.input, from.input)
  into.cached = Math.max(into.cached, from.cached)
  into.output = Math.max(into.output, from.output)
}

/**
 * Один `usage` любого формата. Кэш: DeepSeek — `prompt_cache_hit_tokens`, OpenAI-совместимый чат и OpenRouter —
 * `prompt_tokens_details.cached_tokens`, responses — `input_tokens_details.cached_tokens`, Gemini —
 * `cachedContentTokenCount` (все — часть входа); Anthropic — `cache_read_input_tokens` (к входу прибавляется).
 */
function usageIn(value: unknown, usage: Usage): void {
  if (typeof value !== 'object' || value === null) return
  const record = value as Record<string, unknown>
  const number = (key: string) => nonNegative(record, key)
  let cost = number('cost')
  // OpenRouter со своим ключом поставщика: `cost` — только его доля, поставщик берёт `upstream_inference_cost`.
  if (cost !== undefined && record.is_byok === true) cost += nonNegative(record.cost_details, 'upstream_inference_cost') ?? 0
  const anthropicCached = number('cache_read_input_tokens') ?? 0
  const input = (number('prompt_tokens') ?? number('input_tokens') ?? number('promptTokenCount') ?? 0) + (number('cache_creation_input_tokens') ?? 0) + anthropicCached
  const cached =
    anthropicCached ||
    (number('prompt_cache_hit_tokens') ??
      nonNegative(record.prompt_tokens_details, 'cached_tokens') ??
      nonNegative(record.input_tokens_details, 'cached_tokens') ??
      number('cachedContentTokenCount') ??
      0)
  const output = (number('completion_tokens') ?? number('output_tokens') ?? number('candidatesTokenCount') ?? 0) + (number('thoughtsTokenCount') ?? 0)
  mergeUsage(usage, { ...(cost !== undefined ? { cost } : {}), input, cached: Math.min(cached, input), output })
}

/** `usage` ответа: целый JSON или поток событий (`data: {…}`); по каждому полю — наибольшее из событий. */
function usageOf(body: string): Usage | undefined {
  const usage: Usage = { input: 0, cached: 0, output: 0 }
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
  if (usage.cost !== undefined) return usage.cost
  const cachedPrice = price.cachedInput ?? price.input
  return ((usage.input - usage.cached) * price.input + usage.cached * cachedPrice + usage.output * price.output) / TOKENS_PER_MTOK
}

/** Стоимость ответа по его `usage`: готовая `cost`, иначе токены × цены модели (кэш — по `cachedInput`, нет её — по `input`). Нет `usage` — `undefined`. */
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
    usage ??= { input: 0, cached: 0, output: 0 }
    mergeUsage(usage, found)
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
function preparedRequest(raw: Buffer, provider: EvalProxyProvider, endpoint: Endpoint, limits: EvalProxyLimits): { body: string; model: string; price: EvalModelPrice; reserveUsd: number } {
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
  const modelName = model as string

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
  return { body, model: modelName, price, reserveUsd: priceOf({ input: inputTokens, cached: 0, output: outputTokens }, price) }
}

function forwardedHeaders(request: IncomingMessage, provider: EvalProxyProvider): Headers {
  const headers = new Headers()
  for (const [name, value] of Object.entries(request.headers)) {
    // Провайдеру не уходят доступ, куки, сведения о сети и то, что fetch ставит сам; свои заголовки ставит только прокси.
    if (value === undefined || isProxyOwnedHeader(name) || Object.hasOwn(provider.upstreamHeaderValues ?? {}, name)) continue
    headers.set(name, Array.isArray(value) ? value.join(', ') : value)
  }
  for (const [name, value] of Object.entries(provider.upstreamHeaderValues ?? {})) {
    if (!isProxyOwnedHeader(name)) headers.set(name, value)
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
  requests: number
  active: number
  pending: Set<Promise<void>>
  closed: boolean
  overBudget: AbortController
  /** Модели, про которые журнал уже сказал: кэш без цены `cachedInput`. */
  cachePriceMissingLogged: Set<string>
  onSpend?: (spend: EvalSpend) => Promise<void> | void
}

/** Текст исключения с причиной (`fetch failed` сам по себе ничего не говорит). */
function describeError(error: unknown): string {
  if (!(error instanceof Error)) return String(error)
  const cause = error.cause instanceof Error ? `: ${(error.cause as Error & { code?: string }).code ?? ''} ${error.cause.message}`.replace(/: {2}/, ': ') : ''
  return `${error.message}${cause}`
}

/** Секреты, которые не должны попасть в журнал, даже если их повторит текст исключения. */
function withoutSecrets(text: string, secrets: readonly string[]): string {
  let clean = text
  for (const secret of secrets) if (secret.length > 0) clean = clean.replaceAll(secret, '***')
  return clean
}

/** Брони запросов бывают в доли цента. */
function formatUsd(value: number): string {
  return String(Number(value.toFixed(6)))
}

function urlHost(url: string): string {
  return new URL(url).hostname.replace(/^\[|\]$/g, '')
}

const DEFAULT_PORT = 7810

export async function createEvalProxy(options: EvalProxyOptions): Promise<EvalProxy> {
  if (options.listen) assertPrivateAddress(options.listen.host, 'адрес прокси eval')
  if (!options.listen && !options.publicUrl) throw new Error('прокси eval без постоянного адреса: нужен publicUrl')
  if (options.publicUrl) {
    const host = urlHost(options.publicUrl)
    // Имя без точек — имя в /etc/hosts контейнера, в интернет оно не ведёт.
    if (!/^[a-z][a-z0-9-]*$/i.test(host)) assertPrivateAddress(host, 'внешний адрес прокси eval (publicUrl)')
  }
  const runs = new Map<string, OpenRun>()
  const upstreamTimeoutMs = options.upstreamTimeoutMs ?? UPSTREAM_TIMEOUT_MS

  /** Строка журнала про запрос; `where` — метод и путь без пропуска. */
  function log(where: string, text: string, secrets: readonly string[] = []): void {
    options.log?.(`[прокси eval] ${where}: ${withoutSecrets(text, secrets)}`)
  }

  function providerSecrets(provider: EvalProxyProvider, token: string): string[] {
    return [token, provider.key, ...Object.values(provider.upstreamHeaderValues ?? {})]
  }

  async function report(run: OpenRun): Promise<void> {
    await run.onSpend?.({ spentUsd: run.spentUsd, inFlightUsd: run.inFlightUsd })
  }

  function reply(response: ServerResponse, status: number, text: string): void {
    response.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' })
    response.end(text)
  }

  /** Факт по `usage`. Кэш без цены `cachedInput` считается по `input` — расход завышен, журнал говорит об этом раз за прогон. */
  function chargeOf(usage: Usage, run: OpenRun, provider: EvalProxyProvider, model: string, price: EvalModelPrice, where: string): number {
    const missingKey = `${provider.name}/${model}`
    if (usage.cost === undefined && usage.cached > 0 && price.cachedInput === undefined && !run.cachePriceMissingLogged.has(missingKey)) {
      run.cachePriceMissingLogged.add(missingKey)
      log(where, `у модели ${model} нет цены cachedInput: вход из кэша посчитан по цене input, расход завышен — впишите cachedInput в eval.providers[].models`)
    }
    return priceOf(usage, price)
  }

  /** Отправка и ответ по ходу чтения. Возвращает, сколько засчитать: факт или вся бронь. */
  async function relay(request: IncomingMessage, response: ServerResponse, run: OpenRun, provider: EvalProxyProvider, url: URL, body: string, reserveUsd: number, model: string, price: EvalModelPrice, where: string, secrets: readonly string[]): Promise<number> {
    try {
      const upstream = await fetch(url, { method: 'POST', headers: forwardedHeaders(request, provider), body, redirect: 'manual', signal: AbortSignal.timeout(upstreamTimeoutMs) })
      if (!upstream.ok) log(where, `поставщик ответил ${upstream.status}`)
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
      if (usage) return chargeOf(usage, run, provider, model, price, where)
      if (!upstream.ok) return 0
      log(where, `в ответе поставщика нет usage — засчитана бронь $${formatUsd(reserveUsd)}`)
      return reserveUsd
    } catch (error) {
      // Обрыв, тайм-аут, слишком большой ответ: провайдер мог успеть сделать всю работу.
      log(where, `${response.headersSent ? 'ответ поставщика оборвался' : 'поставщик не ответил'}: ${describeError(error)} — засчитана бронь $${formatUsd(reserveUsd)}`, secrets)
      if (!response.headersSent) reply(response, 502, 'провайдер модели не ответил')
      else response.destroy()
      return reserveUsd
    }
  }

  async function forward(request: IncomingMessage, response: ServerResponse, run: OpenRun, provider: EvalProxyProvider, url: URL, endpoint: Endpoint, where: string, secrets: readonly string[]): Promise<void> {
    const { body, model, price, reserveUsd } = preparedRequest(await readBody(request, run.limits.maxRequestBytes), provider, endpoint, run.limits)
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
      chargeUsd = await relay(request, response, run, provider, url, body, reserveUsd, model, price, where, secrets)
    } finally {
      run.inFlightUsd -= reserveUsd
      run.spentUsd += chargeUsd
      await report(run).catch(() => {})
    }
  }

  function requestPath(request: IncomingMessage) {
    const raw = request.url ?? '/'
    const queryAt = raw.indexOf('?')
    const path = queryAt === -1 ? raw : raw.slice(0, queryAt)
    const search = queryAt === -1 ? '' : raw.slice(queryAt)
    const [, token = '', name = '', ...restParts] = path.split('/')
    // Пропуск прогона — первая часть пути, строка запроса может нести ключ: в журнал ни то, ни другое.
    const where = `${request.method ?? '?'} /${[name, ...restParts].join('/')}`
    return { search, token, name, restParts, where }
  }

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const { search, token, name, restParts, where } = requestPath(request)
    const refuse = (status: number, text: string, secrets: readonly string[] = []) => {
      log(where, `${status} ${text}`, [token, ...secrets])
      reply(response, status, text)
    }
    const run = runs.get(token)
    if (!run || run.closed) return refuse(401, 'неизвестный прогон eval')
    run.requests += 1
    const provider = run.providers.get(name)
    if (!provider) return refuse(404, 'неизвестный провайдер')
    const secrets = providerSecrets(provider, token)
    let target: { url: URL; endpoint: Endpoint }
    try {
      target = upstreamTarget(provider, `/${restParts.join('/')}`, search)
      if (request.method !== 'POST') throw new Refusal(403, 'только POST')
    } catch (error) {
      if (error instanceof Refusal) return refuse(error.status, error.message, secrets)
      throw error
    }
    if (run.active >= run.limits.maxConcurrentRequests) return refuse(429, 'слишком много одновременных запросов eval')
    run.active += 1
    const done = forward(request, response, run, provider, target.url, target.endpoint, where, secrets).catch((error: unknown) => {
      if (!(error instanceof Refusal)) throw error
      refuse(error.status, error.message, secrets)
    })
    const tracked = done.finally(() => {
      run.active -= 1
      run.pending.delete(tracked)
    })
    run.pending.add(tracked)
    await tracked
  }

  const http = createGuardedHttp((request, response) => {
    // Eval мог уйти, не дочитав ответ: запись в закрытое соединение — не сбой прокси.
    response.on('error', () => {})
    handle(request, response).catch((error: unknown) => {
      const { token, name, where } = requestPath(request)
      const provider = runs.get(token)?.providers.get(name)
      log(where, `сбой прокси: ${describeError(error)}`, provider ? providerSecrets(provider, token) : [token])
      if (!response.headersSent) reply(response, 500, 'сбой прокси')
      else response.destroy()
    })
  }, options.limits)
  const fixed = options.listen ? await http.listen(options.listen.host, options.listen.port) : undefined
  const url = (options.publicUrl ?? fixed!.url).replace(/\/$/, '')
  const port = options.port ?? DEFAULT_PORT

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
        requests: 0,
        active: 0,
        pending: new Set(),
        closed: false,
        overBudget: new AbortController(),
        cachePriceMissingLogged: new Set(),
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
        requests: () => run.requests,
        async close() {
          run.closed = true
          while (run.pending.size > 0) await Promise.allSettled([...run.pending])
          runs.delete(token)
        },
      }
    },
    listen: (host) => http.listen(host, port),
    close: () => http.close(),
  }
}
