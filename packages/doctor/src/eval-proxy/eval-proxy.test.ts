import { createServer, request as httpRequest, type IncomingHttpHeaders, type Server } from 'node:http'
import { connect, type AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { createEvalProxy, usageCostUsd, type EvalProxy, type EvalProxyLimits, type EvalProxyProvider, type EvalProxyRunOptions, type EvalSpend } from './index.js'

// Прокси модели для eval: настоящие ключи не попадают в контейнер. Eval получает адрес прокси и одноразовый
// токен прогона; прокси подставляет ключ, бронирует наибольшую цену запроса до отправки, считает факт
// по ответу и не пускает запрос, который не влезает в долю прогона.

const REAL_KEY = ['real', 'eval', 'key', '0000', '1111'].join('-')

interface Seen {
  method: string
  url: string
  headers: IncomingHttpHeaders
  body: string
}

interface Answer {
  status?: number
  body?: string
  contentType?: string
  delayMs?: number
  /** Ответ кусками с паузой: поток событий. */
  chunks?: string[]
  chunkDelayMs?: number
  /** Оборвать соединение после кусков. */
  cut?: boolean
}

interface Upstream {
  url: string
  seen: Seen[]
  reply: (seen: Seen) => Answer
  close(): Promise<void>
}

const closers: (() => Promise<void>)[] = []

afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close()
})

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function startUpstream(reply: Upstream['reply']): Promise<Upstream> {
  const seen: Seen[] = []
  const upstream = { seen, reply } as Upstream
  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', async () => {
      const entry = { method: request.method ?? '', url: request.url ?? '', headers: request.headers, body: Buffer.concat(chunks).toString('utf8') }
      seen.push(entry)
      const answer = upstream.reply(entry)
      await sleep(answer.delayMs ?? 0)
      if (response.destroyed) return
      response.writeHead(answer.status ?? 200, { 'content-type': answer.contentType ?? 'application/json' })
      for (const chunk of answer.chunks ?? []) {
        response.write(chunk)
        await sleep(answer.chunkDelayMs ?? 0)
      }
      if (answer.cut) return response.socket?.destroy()
      response.end(answer.body ?? '')
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  upstream.url = `http://127.0.0.1:${port}/v1`
  upstream.close = () =>
    new Promise<void>((resolve) => {
      server.close(() => resolve())
      server.closeAllConnections()
    })
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
    // Вход бесплатный: бронь зависит только от предела ответа, числа в тестах точные.
    models: { m: { input: 0, output: 1 }, pricey: { input: 0, output: 10 } },
    key: REAL_KEY,
    ...extra,
  }
}

const LIMITS: EvalProxyLimits = { maxRequestBytes: 64 * 1024, maxResponseBytes: 64 * 1024, maxConcurrentRequests: 4, maxOutputTokens: 1000 }

async function startProxy(options: { upstreamTimeoutMs?: number } = {}): Promise<EvalProxy> {
  const proxy = await createEvalProxy({ listen: { host: '127.0.0.1', port: 0 }, ...options })
  closers.push(() => proxy.close())
  return proxy
}

function openRun(proxy: EvalProxy, upstream: Upstream, extra: Partial<EvalProxyRunOptions> = {}) {
  return proxy.openRun({ providers: [provider(upstream)], tokenEnv: 'REMONTNIK_EVAL_TOKEN', budgetUsd: 1, limits: LIMITS, ...extra })
}

function chatReply(usage: Record<string, unknown>) {
  return (): Answer => ({ body: JSON.stringify({ choices: [{ message: { content: 'ok' } }], usage }) })
}

function post(url: string, body: unknown, headers: Record<string, string> = {}) {
  return fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) })
}

/** Запрос с сырым путём: fetch сам схлопнул бы `..`, а прокси должен справиться и без него. */
function rawRequest(base: string, path: string, method = 'POST', body = '{"model":"m"}'): Promise<number> {
  const { hostname, port } = new URL(base)
  return new Promise((resolve, reject) => {
    const sent = httpRequest({ host: hostname, port, path, method }, (response) => {
      response.resume()
      response.on('end', () => resolve(response.statusCode ?? 0))
    })
    sent.on('error', reject)
    sent.end(body)
  })
}

// Бронь запроса с `max_tokens: 100_000` у модели `m` (выход $1 за миллион): $0.1.
const RESERVE_100K = 0.1

describe('прокси модели для eval', () => {
  it('eval получает адрес прокси и токен, а не ключ; прокси подставляет настоящий ключ и предел ответа', async () => {
    const upstream = await startUpstream(chatReply({ prompt_tokens: 10, completion_tokens: 5 }))
    const proxy = await startProxy()
    const run = openRun(proxy, upstream)

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
    // Без предела ответа наибольшую цену не посчитать: прокси вставляет предел из настройки.
    expect(JSON.parse(upstream.seen[0]!.body)).toEqual({ model: 'm', max_tokens: 1000 })
  })

  it('ключ в заголовке x-api-key для провайдеров вроде Anthropic; свой предел ответа не трогается', async () => {
    const upstream = await startUpstream(chatReply({ input_tokens: 1, output_tokens: 1 }))
    const proxy = await startProxy()
    const run = proxy.openRun({ providers: [provider(upstream, { authHeader: 'x-api-key' })], tokenEnv: 'REMONTNIK_EVAL_TOKEN', budgetUsd: 1, limits: LIMITS })
    expect((await post(`${run.env.CHAT_BASE_URL}/messages`, { model: 'm', max_tokens: 10 }, { 'x-api-key': run.token })).status).toBe(200)
    expect(upstream.seen[0]?.headers['x-api-key']).toBe(REAL_KEY)
    expect(upstream.seen[0]?.headers.authorization).toBeUndefined()
    expect(JSON.parse(upstream.seen[0]!.body)).toEqual({ model: 'm', max_tokens: 10 })
  })

  it('заголовки к upstream: значение ставит прокси; одноимённый заголовок клиента не проходит', async () => {
    const upstream = await startUpstream(chatReply({ input_tokens: 1, output_tokens: 1 }))
    const proxy = await startProxy()
    const run = openRun(proxy, upstream, { providers: [provider(upstream, { upstreamHeaderValues: { 'x-gateway-pass': 'gateway-pass-value' } })] })
    const response = await post(`${run.env.CHAT_BASE_URL}/chat/completions`, { model: 'm' }, { authorization: `Bearer ${run.token}`, 'X-Gateway-Pass': 'from-client' })
    expect(response.status).toBe(200)
    expect(upstream.seen[0]?.headers['x-gateway-pass']).toBe('gateway-pass-value')
    expect(upstream.seen[0]?.headers.authorization).toBe(`Bearer ${REAL_KEY}`)
    expect(JSON.stringify(await response.text())).not.toContain('gateway-pass-value')
  })

  it('заголовок к upstream, которого клиент не слал, всё равно уходит; без поля клиентский заголовок идёт как раньше', async () => {
    const upstream = await startUpstream(chatReply({ input_tokens: 1, output_tokens: 1 }))
    const proxy = await startProxy()
    const withHeader = openRun(proxy, upstream, { providers: [provider(upstream, { upstreamHeaderValues: { 'x-gateway-pass': 'gateway-pass-value' } })] })
    await post(`${withHeader.env.CHAT_BASE_URL}/chat/completions`, { model: 'm' })
    const without = openRun(proxy, upstream)
    await post(`${without.env.CHAT_BASE_URL}/chat/completions`, { model: 'm' }, { 'x-gateway-pass': 'from-client' })
    expect(upstream.seen[0]?.headers['x-gateway-pass']).toBe('gateway-pass-value')
    expect(upstream.seen[1]?.headers['x-gateway-pass']).toBe('from-client')
  })

  it('заголовки, которые ломают смысл прокси, из upstreamHeaderValues не ставятся', async () => {
    const upstream = await startUpstream(chatReply({ input_tokens: 1, output_tokens: 1 }))
    const proxy = await startProxy()
    const values = { authorization: 'Bearer stolen', 'x-api-key': 'stolen', host: 'evil.invalid', 'content-length': '1', 'x-forwarded-for': '10.0.0.1', 'x-gateway-pass': 'gateway-pass-value' }
    const run = openRun(proxy, upstream, { providers: [provider(upstream, { upstreamHeaderValues: values })] })
    expect((await post(`${run.env.CHAT_BASE_URL}/chat/completions`, { model: 'm' })).status).toBe(200)
    const headers = upstream.seen[0]!.headers
    expect(headers.authorization).toBe(`Bearer ${REAL_KEY}`)
    expect(headers['x-api-key']).toBeUndefined()
    expect(headers['x-forwarded-for']).toBeUndefined()
    expect(headers.host).not.toBe('evil.invalid')
    expect(headers['x-gateway-pass']).toBe('gateway-pass-value')
  })

  it('responses — предел max_output_tokens; поток чата — с usage в конце', async () => {
    const upstream = await startUpstream(chatReply({ input_tokens: 1, output_tokens: 1 }))
    const proxy = await startProxy()
    const run = openRun(proxy, upstream)
    await post(`${run.env.CHAT_BASE_URL}/responses`, { model: 'm', input: 'hi' })
    await post(`${run.env.CHAT_BASE_URL}/chat/completions`, { model: 'm', stream: true })
    expect(JSON.parse(upstream.seen[0]!.body)).toEqual({ model: 'm', input: 'hi', max_output_tokens: 1000 })
    expect(JSON.parse(upstream.seen[1]!.body)).toEqual({ model: 'm', stream: true, stream_options: { include_usage: true }, max_tokens: 1000 })
  })

  it('без верного токена или после закрытия прогона — 401, к модели не идёт', async () => {
    const upstream = await startUpstream(chatReply({}))
    const proxy = await startProxy()
    const run = openRun(proxy, upstream)
    expect((await post(`${proxy.url}/wrong-token/chat/chat/completions`, { model: 'm' })).status).toBe(401)
    expect((await post(`${proxy.url}/${run.token}/other/chat/completions`, { model: 'm' })).status).toBe(404)
    await run.close()
    expect((await post(`${run.env.CHAT_BASE_URL}/chat/completions`, { model: 'm' })).status).toBe(401)
    expect(upstream.seen).toHaveLength(0)
  })

  it('путь не выходит за адрес провайдера', async () => {
    const upstream = await startUpstream(chatReply({}))
    const proxy = await startProxy()
    const run = openRun(proxy, upstream)
    for (const path of ['/../../admin', '/%2e%2e/%2e%2e/admin', '/..%2f..%2fadmin', '/chat%2fcompletions', '/chat\\completions']) {
      expect(await rawRequest(proxy.url, `/${run.token}/chat${path}`), path).toBe(400)
    }
    expect(upstream.seen).toHaveLength(0)
  })

  it('только POST на чат, responses и эмбеддинги; остальное — 403', async () => {
    const upstream = await startUpstream(chatReply({ prompt_tokens: 1 }))
    const proxy = await startProxy()
    const run = openRun(proxy, upstream)
    const base = `/${run.token}/chat`
    for (const path of ['/files', '/images/generations', '/fine_tuning/jobs', '/vector_stores', '/models', '/chat/completions/x', '/Chat/Completions', '//evil.invalid/x', '/messages/batches']) {
      expect(await rawRequest(proxy.url, `${base}${path}`), path).toBe(403)
    }
    expect(await rawRequest(proxy.url, `${base}/chat/completions`, 'GET', '')).toBe(403)
    expect(await rawRequest(proxy.url, `${base}/files/file-1`, 'DELETE', '')).toBe(403)
    expect(upstream.seen).toHaveLength(0)
    for (const path of ['/chat/completions', '/responses', '/embeddings', '/messages']) {
      expect(await rawRequest(proxy.url, `${base}${path}`), path).toBe(200)
    }
  })

  it('модель — из белого списка; нет в списке или нет модели — 403, тело не JSON — 400', async () => {
    const upstream = await startUpstream(chatReply({}))
    const proxy = await startProxy()
    const run = openRun(proxy, upstream)
    expect((await post(`${run.env.CHAT_BASE_URL}/chat/completions`, { model: 'gpt-big' })).status).toBe(403)
    expect((await post(`${run.env.CHAT_BASE_URL}/chat/completions`, { messages: [] })).status).toBe(403)
    expect((await post(`${run.env.CHAT_BASE_URL}/chat/completions`, 'не json')).status).toBe(400)
    expect((await post(`${run.env.CHAT_BASE_URL}/chat/completions`, { model: 'm', max_tokens: -5 })).status).toBe(400)
    expect(upstream.seen).toHaveLength(0)
  })

  it('цена — по модели из запроса, а не одна на поставщика', async () => {
    const upstream = await startUpstream(chatReply({ prompt_tokens: 0, completion_tokens: 10_000 }))
    const proxy = await startProxy()
    const run = openRun(proxy, upstream)
    await post(`${run.env.CHAT_BASE_URL}/chat/completions`, { model: 'm' })
    expect(run.spentUsd()).toBeCloseTo(0.01)
    await post(`${run.env.CHAT_BASE_URL}/chat/completions`, { model: 'pricey' })
    expect(run.spentUsd()).toBeCloseTo(0.11)
  })

  it('запрос, чья наибольшая цена не влезает в остаток, — 402 до отправки, прогон прерывается', async () => {
    const upstream = await startUpstream(chatReply({ completion_tokens: 1 }))
    const proxy = await startProxy()
    const run = openRun(proxy, upstream, { budgetUsd: 0.05 })
    // 100 000 токенов ответа по $1 за миллион — $0.1 > $0.05.
    expect((await post(`${run.env.CHAT_BASE_URL}/chat/completions`, { model: 'm', max_tokens: 100_000 })).status).toBe(402)
    expect(run.overBudget.aborted).toBe(true)
    expect(upstream.seen).toHaveLength(0)
  })

  it('несколько вариантов ответа (n) умножают бронь', async () => {
    const upstream = await startUpstream(chatReply({ completion_tokens: 1 }))
    const proxy = await startProxy()
    const run = openRun(proxy, upstream, { budgetUsd: 0.15 })
    expect((await post(`${run.env.CHAT_BASE_URL}/chat/completions`, { model: 'm', max_tokens: 100_000, n: 2 })).status).toBe(402)
  })

  it('вход тоже в брони: огромное тело не влезает', async () => {
    const upstream = await startUpstream(chatReply({ completion_tokens: 1 }))
    const proxy = await startProxy()
    const run = proxy.openRun({ providers: [provider(upstream, { models: { m: { input: 1_000_000, output: 0 } } })], tokenEnv: 'T', budgetUsd: 1, limits: LIMITS })
    expect((await post(`${run.env.CHAT_BASE_URL}/chat/completions`, { model: 'm', text: 'x'.repeat(1000) })).status).toBe(402)
  })

  it('параллельные запросы: в долю идут брони запросов в пути, лишние — 402', async () => {
    const upstream = await startUpstream(() => ({ body: JSON.stringify({ usage: { completion_tokens: 10_000 } }), delayMs: 150 }))
    const proxy = await startProxy()
    const run = openRun(proxy, upstream, { budgetUsd: 0.25 })
    const statuses = await Promise.all(
      Array.from({ length: 5 }, () => post(`${run.env.CHAT_BASE_URL}/chat/completions`, { model: 'm', max_tokens: 100_000 }).then((response) => response.status)),
    )
    expect(statuses.filter((status) => status === 200)).toHaveLength(2)
    expect(statuses.filter((status) => status === 402)).toHaveLength(3)
    expect(upstream.seen).toHaveLength(2)
    expect(run.spentUsd()).toBeCloseTo(0.02)
  })

  it('одновременных запросов не больше предела: лишние — 429', async () => {
    const upstream = await startUpstream(() => ({ body: JSON.stringify({ usage: { completion_tokens: 1 } }), delayMs: 150 }))
    const proxy = await startProxy()
    const run = openRun(proxy, upstream, { budgetUsd: 100, limits: { ...LIMITS, maxConcurrentRequests: 2 } })
    const statuses = await Promise.all(Array.from({ length: 4 }, () => post(`${run.env.CHAT_BASE_URL}/chat/completions`, { model: 'm' }).then((response) => response.status)))
    expect(statuses.sort()).toEqual([200, 200, 429, 429])
  })

  it('бронь запроса записывается до отправки к поставщику; не записалась — 503, к модели не идёт', async () => {
    const events: string[] = []
    const upstream = await startUpstream((seen) => {
      events.push('upstream')
      return chatReply({ completion_tokens: 10_000 })()
    })
    const proxy = await startProxy()
    const spends: EvalSpend[] = []
    const run = openRun(proxy, upstream, {
      onSpend: async (spend) => {
        await sleep(30)
        spends.push(spend)
        events.push(`write ${spend.inFlightUsd > 0 ? 'бронь' : 'факт'}`)
      },
    })
    await post(`${run.env.CHAT_BASE_URL}/chat/completions`, { model: 'm', max_tokens: 100_000 })
    await run.close()
    expect(events).toEqual(['write бронь', 'upstream', 'write факт'])
    expect(spends[0]).toEqual({ spentUsd: 0, inFlightUsd: RESERVE_100K })
    expect(spends.at(-1)!.spentUsd).toBeCloseTo(0.01)
    expect(spends.at(-1)!.inFlightUsd).toBe(0)

    const failing = openRun(proxy, upstream, {
      onSpend: () => {
        throw new Error('база недоступна')
      },
    })
    expect((await post(`${failing.env.CHAT_BASE_URL}/chat/completions`, { model: 'm' })).status).toBe(503)
    expect(upstream.seen).toHaveLength(1)
    expect(failing.spentUsd()).toBe(0)
  })

  it('тело запроса больше предела — 413', async () => {
    const upstream = await startUpstream(chatReply({}))
    const proxy = await startProxy()
    const run = openRun(proxy, upstream, { limits: { ...LIMITS, maxRequestBytes: 100 } })
    expect((await post(`${run.env.CHAT_BASE_URL}/chat/completions`, { model: 'm', text: 'x'.repeat(200) })).status).toBe(413)
    expect(upstream.seen).toHaveLength(0)
  })

  it('поток идёт в eval по ходу чтения; расход — из usage в конце потока', async () => {
    const events = [
      `data: ${JSON.stringify({ choices: [{ delta: { content: 'при' } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: { content: 'вет' } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 5, completion_tokens: 20_000 } })}\n\ndata: [DONE]\n\n`,
    ]
    const upstream = await startUpstream(() => ({ contentType: 'text/event-stream', chunks: events, chunkDelayMs: 150 }))
    const proxy = await startProxy()
    const run = openRun(proxy, upstream)
    const response = await post(`${run.env.CHAT_BASE_URL}/chat/completions`, { model: 'm', stream: true })
    const reader = response.body!.getReader()
    const first = await reader.read()
    // Первый кусок пришёл, пока поставщик ещё держит поток.
    expect(new TextDecoder().decode(first.value)).toContain('при')
    expect(upstream.seen).toHaveLength(1)
    while (!(await reader.read()).done) {
      // дочитываем
    }
    await run.close()
    expect(run.spentUsd()).toBeCloseTo(0.02)
  })

  it('оборванный поток — засчитывается вся бронь запроса', async () => {
    const upstream = await startUpstream(() => ({ contentType: 'text/event-stream', chunks: [`data: ${JSON.stringify({ choices: [{ delta: { content: 'a' } }] })}\n\n`], cut: true }))
    const proxy = await startProxy()
    const run = openRun(proxy, upstream)
    await post(`${run.env.CHAT_BASE_URL}/chat/completions`, { model: 'm', max_tokens: 100_000, stream: true })
      .then((response) => response.text())
      .catch(() => undefined)
    await run.close()
    expect(run.spentUsd()).toBeCloseTo(RESERVE_100K)
  })

  it('тайм-аут поставщика — 502 и вся бронь запроса', async () => {
    const upstream = await startUpstream(() => ({ body: '{}', delayMs: 500 }))
    const proxy = await startProxy({ upstreamTimeoutMs: 100 })
    const run = openRun(proxy, upstream)
    expect((await post(`${run.env.CHAT_BASE_URL}/chat/completions`, { model: 'm', max_tokens: 100_000 })).status).toBe(502)
    await run.close()
    expect(run.spentUsd()).toBeCloseTo(RESERVE_100K)
  })

  it('ответ больше предела — обрыв и вся бронь запроса', async () => {
    const upstream = await startUpstream(() => ({ body: JSON.stringify({ text: 'x'.repeat(2000), usage: { completion_tokens: 1 } }) }))
    const proxy = await startProxy()
    const run = openRun(proxy, upstream, { limits: { ...LIMITS, maxResponseBytes: 1000 } })
    await post(`${run.env.CHAT_BASE_URL}/chat/completions`, { model: 'm', max_tokens: 100_000 })
      .then((response) => response.text())
      .catch(() => undefined)
    await run.close()
    expect(run.spentUsd()).toBeCloseTo(RESERVE_100K)
  })

  it('успешный ответ без usage — вся бронь; ошибка без usage — бесплатно', async () => {
    let status = 200
    const upstream = await startUpstream(() => ({ status, body: '{"ok":true}' }))
    const proxy = await startProxy()
    const run = openRun(proxy, upstream)
    await post(`${run.env.CHAT_BASE_URL}/chat/completions`, { model: 'm', max_tokens: 100_000 })
    expect(run.spentUsd()).toBeCloseTo(RESERVE_100K)
    status = 429
    await post(`${run.env.CHAT_BASE_URL}/chat/completions`, { model: 'm', max_tokens: 100_000 })
    expect(run.spentUsd()).toBeCloseTo(RESERVE_100K)
  })

  it('расход дошёл до доли без отказов — прогон не прерван; следующий запрос — 402 и прерывание', async () => {
    const upstream = await startUpstream(chatReply({ completion_tokens: 100_000 }))
    const proxy = await startProxy()
    const run = openRun(proxy, upstream, { budgetUsd: RESERVE_100K })
    expect((await post(`${run.env.CHAT_BASE_URL}/chat/completions`, { model: 'm', max_tokens: 100_000 })).status).toBe(200)
    expect(run.spentUsd()).toBeCloseTo(RESERVE_100K)
    expect(run.overBudget.aborted).toBe(false)
    expect((await post(`${run.env.CHAT_BASE_URL}/chat/completions`, { model: 'm', max_tokens: 1 })).status).toBe(402)
    expect(run.overBudget.aborted).toBe(true)
  })

  it('закрытие прогона ждёт запросы, которые ещё идут, и учитывает их', async () => {
    const upstream = await startUpstream(() => ({ body: JSON.stringify({ usage: { completion_tokens: 50_000 } }), delayMs: 200 }))
    const proxy = await startProxy()
    const spends: EvalSpend[] = []
    const run = openRun(proxy, upstream, { onSpend: (spend) => void spends.push(spend) })
    const inFlight = post(`${run.env.CHAT_BASE_URL}/chat/completions`, { model: 'm', max_tokens: 100_000 }).catch(() => undefined)
    await sleep(50)
    expect(spends.at(-1)).toEqual({ spentUsd: 0, inFlightUsd: RESERVE_100K })
    await run.close()
    expect(run.spentUsd()).toBeCloseTo(0.05)
    expect(spends.at(-1)!.inFlightUsd).toBe(0)
    await inFlight
  })

  it('слушает и показывается только на адресе частной сети', async () => {
    await expect(createEvalProxy({ listen: { host: '0.0.0.0', port: 0 } })).rejects.toThrow(/частной сети/)
    await expect(createEvalProxy({ listen: { host: '127.0.0.1', port: 0 }, publicUrl: 'http://203.0.113.5:7720' })).rejects.toThrow(/частной сети/)
    await expect(createEvalProxy({ listen: { host: '127.0.0.1', port: 0 }, publicUrl: 'http://proxy.example.test:7720' })).rejects.toThrow(/частной сети/)
    const proxy = await createEvalProxy({ listen: { host: '127.0.0.1', port: 0 }, publicUrl: 'http://172.30.0.2:7720/' })
    expect(proxy.url).toBe('http://172.30.0.2:7720')
    await proxy.close()
  })

  it('в сетях случая: адрес — имя врача remontnik-gateway, слушает на адресе врача в каждой сети проверок', async () => {
    const upstream = await startUpstream(chatReply({ prompt_tokens: 1, completion_tokens: 1 }))
    const proxy = await createEvalProxy({ port: 0, publicUrl: 'http://remontnik-gateway:7810' })
    closers.push(() => proxy.close())
    expect(proxy.url).toBe('http://remontnik-gateway:7810')
    const listener = await proxy.listen('127.0.0.1')
    const run = openRun(proxy, upstream)
    const viaListener = run.env.CHAT_BASE_URL!.replace('http://remontnik-gateway:7810', listener.url)
    expect((await post(`${viaListener}/chat/completions`, { model: 'm', max_tokens: 10 })).status).toBe(200)
    await listener.close()
    await expect(post(`${viaListener}/chat/completions`, { model: 'm', max_tokens: 10 })).rejects.toThrow()
    await run.close()
    await expect(createEvalProxy({ port: 0, publicUrl: 'http://remontnik.gateway.example.com:7810' })).rejects.toThrow(/частной сети/)
    await expect(createEvalProxy({ port: 0 })).rejects.toThrow(/publicUrl/)
  })

  it('один клиент не занимает все соединения, а пустое соединение закрывается по короткому сроку', async () => {
    const proxy = await createEvalProxy({ listen: { host: '127.0.0.1', port: 0 }, limits: { maxConnectionsPerClient: 1, firstRequestTimeoutMs: 300 } })
    closers.push(() => proxy.close())
    const { hostname, port } = new URL(proxy.url)
    const first = connect({ host: hostname, port: Number(port) })
    first.on('error', () => {})
    await new Promise((resolve) => first.once('connect', resolve))
    const openedAt = Date.now()
    const second = connect({ host: hostname, port: Number(port) })
    second.on('error', () => {})
    await new Promise((resolve) => second.once('close', resolve))
    expect(Date.now() - openedAt).toBeLessThan(250)
    await new Promise((resolve) => first.once('close', resolve))
    expect(Date.now() - openedAt).toBeLessThan(2_500)
  })
})

describe('стоимость ответа модели', () => {
  const price = { input: 1, output: 2 }

  it('готовая цена usage.cost важнее токенов', () => {
    expect(usageCostUsd(JSON.stringify({ usage: { cost: 0.42, prompt_tokens: 1_000_000 } }), price)).toBeCloseTo(0.42)
  })

  it('токены OpenAI и Anthropic, включая кэш', () => {
    expect(usageCostUsd(JSON.stringify({ usage: { prompt_tokens: 1_000_000, completion_tokens: 1_000_000 } }), price)).toBeCloseTo(3)
    const anthropic = { usage: { input_tokens: 500_000, cache_creation_input_tokens: 250_000, cache_read_input_tokens: 250_000, output_tokens: 1_000_000 } }
    expect(usageCostUsd(JSON.stringify(anthropic), price)).toBeCloseTo(3)
  })

  it('поток событий: usage из последних событий, по каждому полю наибольшее', () => {
    const stream = [
      `data: ${JSON.stringify({ type: 'message_start', message: { usage: { input_tokens: 1_000_000, output_tokens: 1 } } })}`,
      `data: ${JSON.stringify({ type: 'content_block_delta', delta: { text: 'hi' } })}`,
      `data: ${JSON.stringify({ type: 'message_delta', usage: { output_tokens: 1_000_000 } })}`,
      'data: [DONE]',
    ].join('\n\n')
    expect(usageCostUsd(stream, price)).toBeCloseTo(3)
  })

  it('ответ без usage — цены нет', () => {
    expect(usageCostUsd('{"error":"rate"}', price)).toBeUndefined()
  })
})
