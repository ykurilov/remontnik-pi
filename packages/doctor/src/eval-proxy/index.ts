import { randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

// Прокси модели для eval. Настоящие ключи провайдеров живут только у врача: контейнер eval получает
// адрес прокси (`baseUrlEnv`) и одноразовый токен прогона (в `tokenEnv` и вместо ключа в `keyEnv`).
// Прокси подставляет ключ, сам считает расход по `usage` ответов и режет прогон, когда его доля
// бюджета кончилась: дальше 402, а `overBudget` прерывает команду eval. Расход идёт в учёт отсюда,
// а не из файла итога eval, который пишет код правки.
//
// Ответ провайдера читается целиком до того, как уйти в eval: сначала расход, потом ответ.
// Закрытие прогона ждёт запросы, которые ещё идут, — их расход тоже учтён.

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
  priceUsdPerMTok: { input: number; output: number }
  /** Настоящий ключ — из окружения врача. */
  key: string
}

export interface EvalSpend {
  spentUsd: number
  /** Запросы, которые ушли к модели и ещё не вернулись: их расход пока не известен. */
  pending: number
}

export interface EvalProxyRunOptions {
  providers: readonly EvalProxyProvider[]
  /** Переменная с токеном прогона. */
  tokenEnv: string
  budgetUsd: number
  onSpend?: (spend: EvalSpend) => void
}

export interface EvalProxyRun {
  token: string
  /** Переменные для контейнера eval: адреса прокси и токен. Ключей здесь нет. */
  env: Record<string, string>
  /** Прерывается, когда доля бюджета потрачена. */
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
  listen: { host: string; port: number }
  /** Адрес прокси, как его видит контейнер eval; по умолчанию — адрес, на котором он слушает. */
  publicUrl?: string
  upstreamTimeoutMs?: number
  maxRequestBytes?: number
}

const UPSTREAM_TIMEOUT_MS = 300_000
const MAX_REQUEST_BYTES = 16 * 1024 * 1024
const TOKENS_PER_MTOK = 1_000_000
const BYTES_PER_TOKEN = 4
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

/**
 * Стоимость одного ответа: готовая `usage.cost`, иначе токены × цены провайдера (кэш — по цене входа).
 * Успешный ответ без `usage` оценивается по размеру запроса и ответа (4 байта — токен); ошибка без него — бесплатно.
 */
export function evalCostUsd(input: { status: number; body: string; requestBytes: number; price: { input: number; output: number } }): number {
  const usage = usageOf(input.body)
  if (usage?.cost !== undefined) return usage.cost
  const ok = input.status >= 200 && input.status < 300
  const tokens = usage ?? (ok ? { input: input.requestBytes / BYTES_PER_TOKEN, output: Buffer.byteLength(input.body) / BYTES_PER_TOKEN } : { input: 0, output: 0 })
  return (tokens.input * input.price.input + tokens.output * input.price.output) / TOKENS_PER_MTOK
}

function upstreamTarget(provider: EvalProxyProvider, rest: string, search: string): URL | undefined {
  if (ENCODED_SEPARATOR.test(rest)) return undefined
  const base = new URL(provider.upstream)
  const basePath = base.pathname.endsWith('/') ? base.pathname : `${base.pathname}/`
  let target: URL
  try {
    target = new URL(`${base.origin}${basePath.slice(0, -1)}${rest}${search}`)
  } catch {
    return undefined
  }
  if (target.origin !== base.origin || !`${target.pathname}/`.startsWith(basePath)) return undefined
  return target
}

async function readBody(request: IncomingMessage, limit: number): Promise<Buffer | undefined> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    size += (chunk as Buffer).length
    if (size > limit) return undefined
    chunks.push(chunk as Buffer)
  }
  return Buffer.concat(chunks)
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
  spentUsd: number
  pending: Set<Promise<void>>
  closed: boolean
  overBudget: AbortController
  onSpend?: (spend: EvalSpend) => void
}

export async function createEvalProxy(options: EvalProxyOptions): Promise<EvalProxy> {
  const runs = new Map<string, OpenRun>()
  const upstreamTimeoutMs = options.upstreamTimeoutMs ?? UPSTREAM_TIMEOUT_MS
  const maxRequestBytes = options.maxRequestBytes ?? MAX_REQUEST_BYTES

  function report(run: OpenRun): void {
    run.onSpend?.({ spentUsd: run.spentUsd, pending: run.pending.size })
  }

  function reply(response: ServerResponse, status: number, text: string): void {
    response.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' })
    response.end(text)
  }

  async function forward(request: IncomingMessage, response: ServerResponse, run: OpenRun, provider: EvalProxyProvider, target: URL): Promise<void> {
    const body = await readBody(request, maxRequestBytes)
    if (!body) return reply(response, 413, 'запрос слишком большой')
    let status = 502
    let text = ''
    let contentType = 'text/plain; charset=utf-8'
    try {
      const upstream = await fetch(target, {
        method: request.method ?? 'POST',
        headers: forwardedHeaders(request, provider),
        ...(body.length > 0 && request.method !== 'GET' && request.method !== 'HEAD' ? { body } : {}),
        redirect: 'manual',
        signal: AbortSignal.timeout(upstreamTimeoutMs),
      })
      status = upstream.status
      text = await upstream.text()
      contentType = upstream.headers.get('content-type') ?? contentType
      run.spentUsd += evalCostUsd({ status, body: text, requestBytes: body.length, price: provider.priceUsdPerMTok })
    } catch {
      // Провайдер мог успеть обработать запрос: вход считаем потраченным.
      run.spentUsd += evalCostUsd({ status: 200, body: '', requestBytes: body.length, price: provider.priceUsdPerMTok })
      text = 'провайдер модели не ответил'
    }
    if (run.spentUsd >= run.budgetUsd) run.overBudget.abort()
    response.writeHead(status, { 'content-type': contentType })
    response.end(text)
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
    const target = upstreamTarget(provider, `/${restParts.join('/')}`, search)
    if (!target) return reply(response, 400, 'путь вне адреса провайдера')
    if (run.spentUsd >= run.budgetUsd) {
      run.overBudget.abort()
      return reply(response, 402, 'бюджет eval потрачен')
    }
    const done = forward(request, response, run, provider, target)
    const tracked = done.finally(() => {
      run.pending.delete(tracked)
      report(run)
    })
    run.pending.add(tracked)
    report(run)
    await tracked
  }

  const server: Server = createServer((request, response) => {
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
  const url = (options.publicUrl ?? `http://${options.listen.host}:${port}`).replace(/\/$/, '')

  return {
    url,
    openRun(runOptions) {
      const token = randomBytes(24).toString('base64url')
      const run: OpenRun = {
        providers: new Map(runOptions.providers.map((provider) => [provider.name, provider])),
        budgetUsd: runOptions.budgetUsd,
        spentUsd: 0,
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
          report(run)
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
