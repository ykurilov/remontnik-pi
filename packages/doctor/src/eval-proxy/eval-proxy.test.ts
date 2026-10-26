import { createServer, request as httpRequest, type IncomingHttpHeaders, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { createEvalProxy, evalCostUsd, type EvalProxy, type EvalProxyProvider } from './index.js'

// Прокси модели для eval: настоящие ключи не попадают в контейнер. Eval получает адрес прокси и одноразовый
// токен прогона; прокси подставляет ключ, сам считает расход и режет прогон, когда доля бюджета кончилась.

const REAL_KEY = ['real', 'eval', 'key', '0000', '1111'].join('-')

interface Seen {
  method: string
  url: string
  headers: IncomingHttpHeaders
  body: string
}

interface Upstream {
  url: string
  seen: Seen[]
  /** Что ответить на следующий запрос. */
  reply: (seen: Seen) => { status?: number; body: string; contentType?: string; delayMs?: number }
  close(): Promise<void>
}

const closers: (() => Promise<void>)[] = []

afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close()
})

async function startUpstream(reply: Upstream['reply']): Promise<Upstream> {
  const seen: Seen[] = []
  const upstream = { seen, reply } as Upstream
  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => {
      const entry = { method: request.method ?? '', url: request.url ?? '', headers: request.headers, body: Buffer.concat(chunks).toString('utf8') }
      seen.push(entry)
      const answer = upstream.reply(entry)
      setTimeout(() => {
        response.writeHead(answer.status ?? 200, { 'content-type': answer.contentType ?? 'application/json' })
        response.end(answer.body)
      }, answer.delayMs ?? 0)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  upstream.url = `http://127.0.0.1:${port}/v1`
  upstream.close = () => new Promise<void>((resolve) => server.close(() => resolve()))
  closers.push(upstream.close)
  return upstream
}

function provider(upstream: Upstream, extra: Partial<EvalProxyProvider> = {}): EvalProxyProvider {
  return {
    name: 'chat',
    baseUrlEnv: 'CHAT_BASE_URL',
    keyEnv: 'CHAT_API_KEY',
    upstream: upstream.url,
    authHeader: 'authorization',
    priceUsdPerMTok: { input: 1, output: 2 },
    key: REAL_KEY,
    ...extra,
  }
}

async function startProxy(): Promise<EvalProxy> {
  const proxy = await createEvalProxy({ listen: { host: '127.0.0.1', port: 0 } })
  closers.push(() => proxy.close())
  return proxy
}

function chatReply(usage: Record<string, unknown>) {
  return () => ({ body: JSON.stringify({ choices: [{ message: { content: 'ok' } }], usage }) })
}

function post(url: string, body: unknown, headers: Record<string, string> = {}) {
  return fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) })
}

/** Запрос с сырым путём: fetch сам схлопнул бы `..`, а прокси должен справиться и без него. */
function rawPost(base: string, path: string): Promise<number> {
  const { hostname, port } = new URL(base)
  return new Promise((resolve, reject) => {
    const sent = httpRequest({ host: hostname, port, path, method: 'POST' }, (response) => {
      response.resume()
      response.on('end', () => resolve(response.statusCode ?? 0))
    })
    sent.on('error', reject)
    sent.end('{}')
  })
}

describe('прокси модели для eval', () => {
  it('eval получает адрес прокси и токен, а не ключ; прокси подставляет настоящий ключ', async () => {
    const upstream = await startUpstream(chatReply({ prompt_tokens: 10, completion_tokens: 5 }))
    const proxy = await startProxy()
    const run = proxy.openRun({ providers: [provider(upstream)], tokenEnv: 'REMONTNIK_EVAL_TOKEN', budgetUsd: 1 })

    expect(Object.values(run.env).join(' ')).not.toContain(REAL_KEY)
    expect(run.env.CHAT_BASE_URL).toBe(`${proxy.url}/${run.token}/chat`)
    expect(run.env.REMONTNIK_EVAL_TOKEN).toBe(run.token)
    // Библиотеки модели требуют ключ: вместо него — тот же токен прогона.
    expect(run.env.CHAT_API_KEY).toBe(run.token)

    const response = await post(`${run.env.CHAT_BASE_URL}/chat/completions?x=1`, { model: 'm' }, { authorization: `Bearer ${run.token}`, cookie: 'a=b', 'x-forwarded-for': '10.0.0.1' })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ choices: [{ message: { content: 'ok' } }] })
    expect(upstream.seen[0]?.url).toBe('/v1/chat/completions?x=1')
    expect(upstream.seen[0]?.headers.authorization).toBe(`Bearer ${REAL_KEY}`)
    expect(upstream.seen[0]?.headers.cookie).toBeUndefined()
    expect(upstream.seen[0]?.headers['x-forwarded-for']).toBeUndefined()
    expect(upstream.seen[0]?.body).toBe(JSON.stringify({ model: 'm' }))
  })

  it('ключ в заголовке x-api-key для провайдеров вроде Anthropic', async () => {
    const upstream = await startUpstream(chatReply({ input_tokens: 1, output_tokens: 1 }))
    const proxy = await startProxy()
    const run = proxy.openRun({ providers: [provider(upstream, { authHeader: 'x-api-key' })], tokenEnv: 'REMONTNIK_EVAL_TOKEN', budgetUsd: 1 })
    await post(`${run.env.CHAT_BASE_URL}/messages`, {}, { 'x-api-key': run.token })
    expect(upstream.seen[0]?.headers['x-api-key']).toBe(REAL_KEY)
    expect(upstream.seen[0]?.headers.authorization).toBeUndefined()
  })

  it('без верного токена или после закрытия прогона — 401, к модели не идёт', async () => {
    const upstream = await startUpstream(chatReply({}))
    const proxy = await startProxy()
    const run = proxy.openRun({ providers: [provider(upstream)], tokenEnv: 'REMONTNIK_EVAL_TOKEN', budgetUsd: 1 })
    expect((await post(`${proxy.url}/wrong-token/chat/chat/completions`, {})).status).toBe(401)
    expect((await post(`${proxy.url}/${run.token}/other/chat/completions`, {})).status).toBe(404)
    await run.close()
    expect((await post(`${run.env.CHAT_BASE_URL}/chat/completions`, {})).status).toBe(401)
    expect(upstream.seen).toHaveLength(0)
  })

  it('путь не выходит за адрес провайдера', async () => {
    const upstream = await startUpstream(chatReply({}))
    const proxy = await startProxy()
    const run = proxy.openRun({ providers: [provider(upstream)], tokenEnv: 'REMONTNIK_EVAL_TOKEN', budgetUsd: 1 })
    for (const path of ['/../../admin', '/%2e%2e/%2e%2e/admin', '/..%2f..%2fadmin']) {
      const status = await rawPost(proxy.url, `/${run.token}/chat${path}`)
      expect(status).toBe(400)
    }
    expect(await rawPost(proxy.url, `/${run.token}/chat//evil.invalid/x`)).toBe(200)
    expect(upstream.seen.map((seen) => seen.url)).toEqual(['/v1//evil.invalid/x'])
  })

  it('расход — по usage ответа и ценам провайдера; onSpend сообщает итог', async () => {
    const upstream = await startUpstream(chatReply({ prompt_tokens: 1_000_000, completion_tokens: 500_000 }))
    const proxy = await startProxy()
    const spends: { spentUsd: number; pending: number }[] = []
    const run = proxy.openRun({ providers: [provider(upstream)], tokenEnv: 'REMONTNIK_EVAL_TOKEN', budgetUsd: 10, onSpend: (spend) => spends.push(spend) })
    await post(`${run.env.CHAT_BASE_URL}/chat/completions`, {})
    await post(`${run.env.CHAT_BASE_URL}/chat/completions`, {})
    expect(run.spentUsd()).toBeCloseTo(4)
    expect(spends.at(-1)).toEqual({ spentUsd: run.spentUsd(), pending: 0 })
  })

  it('бюджет кончился → прогон прерывается, дальше 402 и к модели не идёт', async () => {
    const upstream = await startUpstream(chatReply({ prompt_tokens: 600_000, completion_tokens: 0 }))
    const proxy = await startProxy()
    const run = proxy.openRun({ providers: [provider(upstream)], tokenEnv: 'REMONTNIK_EVAL_TOKEN', budgetUsd: 1 })
    expect((await post(`${run.env.CHAT_BASE_URL}/chat/completions`, {})).status).toBe(200)
    expect(run.overBudget.aborted).toBe(false)
    expect((await post(`${run.env.CHAT_BASE_URL}/chat/completions`, {})).status).toBe(200)
    expect(run.overBudget.aborted).toBe(true)
    expect((await post(`${run.env.CHAT_BASE_URL}/chat/completions`, {})).status).toBe(402)
    expect(upstream.seen).toHaveLength(2)
    expect(run.spentUsd()).toBeCloseTo(1.2)
  })

  it('закрытие прогона ждёт запросы, которые ещё идут, и учитывает их', async () => {
    const upstream = await startUpstream(() => ({ body: JSON.stringify({ usage: { prompt_tokens: 1_000_000 } }), delayMs: 200 }))
    const proxy = await startProxy()
    const spends: { spentUsd: number; pending: number }[] = []
    const run = proxy.openRun({ providers: [provider(upstream)], tokenEnv: 'REMONTNIK_EVAL_TOKEN', budgetUsd: 10, onSpend: (spend) => spends.push(spend) })
    const inFlight = post(`${run.env.CHAT_BASE_URL}/chat/completions`, {}).catch(() => undefined)
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(spends.at(-1)).toEqual({ spentUsd: 0, pending: 1 })
    await run.close()
    expect(run.spentUsd()).toBeCloseTo(1)
    expect(spends.at(-1)).toEqual({ spentUsd: 1, pending: 0 })
    await inFlight
  })
})

describe('стоимость ответа модели', () => {
  const price = { input: 1, output: 2 }

  it('готовая цена usage.cost важнее токенов', () => {
    expect(evalCostUsd({ status: 200, body: JSON.stringify({ usage: { cost: 0.42, prompt_tokens: 1_000_000 } }), requestBytes: 10, price })).toBeCloseTo(0.42)
  })

  it('токены OpenAI и Anthropic, включая кэш', () => {
    expect(evalCostUsd({ status: 200, body: JSON.stringify({ usage: { prompt_tokens: 1_000_000, completion_tokens: 1_000_000 } }), requestBytes: 10, price })).toBeCloseTo(3)
    const anthropic = { usage: { input_tokens: 500_000, cache_creation_input_tokens: 250_000, cache_read_input_tokens: 250_000, output_tokens: 1_000_000 } }
    expect(evalCostUsd({ status: 200, body: JSON.stringify(anthropic), requestBytes: 10, price })).toBeCloseTo(3)
  })

  it('поток событий: usage из последних событий, по каждому полю наибольшее', () => {
    const stream = [
      `data: ${JSON.stringify({ type: 'message_start', message: { usage: { input_tokens: 1_000_000, output_tokens: 1 } } })}`,
      `data: ${JSON.stringify({ type: 'content_block_delta', delta: { text: 'hi' } })}`,
      `data: ${JSON.stringify({ type: 'message_delta', usage: { output_tokens: 1_000_000 } })}`,
      'data: [DONE]',
    ].join('\n\n')
    expect(evalCostUsd({ status: 200, body: stream, requestBytes: 10, price })).toBeCloseTo(3)
  })

  it('успешный ответ без usage — оценка по размеру запроса и ответа', () => {
    expect(evalCostUsd({ status: 200, body: 'x'.repeat(4_000_000), requestBytes: 4_000_000, price })).toBeCloseTo(3)
  })

  it('ошибка без usage — бесплатно', () => {
    expect(evalCostUsd({ status: 429, body: '{"error":"rate"}', requestBytes: 4_000_000, price })).toBe(0)
  })
})
