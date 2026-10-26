import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { startFakeModel, type FakeModelServer } from '../testing/index.js'
import {
  FALLBACK_MODEL,
  ModelRouteError,
  PRIMARY_MODEL,
  createModelRoute,
  type ModelRouteOptions,
} from './index.js'

const primaryKey = 'primary-test-key'
const fallbackKey = 'fallback-test-key'

function okResponse(json: unknown, usage: Record<string, unknown> = {}): Response {
  return Response.json({
    choices: [{ message: { role: 'assistant', content: JSON.stringify(json) } }],
    usage: { prompt_tokens: 100, completion_tokens: 20, ...usage },
  })
}

type FetchStep = Response | Error | 'hang'

function scriptedFetch(steps: Record<'primary' | 'fallback', FetchStep[]>) {
  const calls: { route: 'primary' | 'fallback'; url: string; init: RequestInit }[] = []
  const fetchImpl = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input)
    const route = url.startsWith('https://primary.invalid') ? 'primary' : 'fallback'
    calls.push({ route, url, init })
    const step = steps[route].shift() ?? new Error(`нет ответа для ${route}`)
    if (step === 'hang') {
      return new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(init.signal?.reason))
      })
    }
    if (step instanceof Error) throw step
    return step
  })
  return { fetchImpl: fetchImpl as unknown as typeof fetch, calls }
}

function options(fetchImpl: typeof fetch, extra: Partial<ModelRouteOptions> = {}): ModelRouteOptions {
  return {
    primary: { baseUrl: 'https://primary.invalid/v1', apiKey: primaryKey, model: PRIMARY_MODEL, proxyToken: 'proxy-a' },
    fallback: { baseUrl: 'https://fallback.invalid/api/v1', apiKey: fallbackKey, model: FALLBACK_MODEL },
    fetch: fetchImpl,
    ...extra,
  }
}

const request = { messages: [{ role: 'user' as const, content: 'оцени разговор' }] }

describe('createModelRoute', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-26T10:00:00Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('идентификаторы моделей — по одной константе на путь', () => {
    expect(PRIMARY_MODEL).toBe('deepseek-flash')
    expect(FALLBACK_MODEL).toBe('deepseek/deepseek-v4.1-flash-1017')
  })

  it('основной путь: OpenAI-совместимый запрос, ответ JSON, ключ и прокси в заголовках', async () => {
    const { fetchImpl, calls } = scriptedFetch({ primary: [okResponse({ verdict: 'ok' }, { prompt_cache_hit_tokens: 80 })], fallback: [] })

    const result = await createModelRoute(options(fetchImpl)).completeJson(request)

    expect(result).toMatchObject({ json: { verdict: 'ok' }, route: 'primary', model: PRIMARY_MODEL })
    expect(result.usage).toMatchObject({ promptTokens: 100, completionTokens: 20, cachedPromptTokens: 80 })
    expect(calls[0]?.url).toBe('https://primary.invalid/v1/chat/completions')
    const headers = new Headers(calls[0]?.init.headers)
    expect(headers.get('authorization')).toBe(`Bearer ${primaryKey}`)
    expect(headers.get('x-proxy-token')).toBe('proxy-a')
    const body = JSON.parse(String(calls[0]?.init.body))
    expect(body).toMatchObject({ model: PRIMARY_MODEL, response_format: { type: 'json_object' }, messages: request.messages })
  })

  it.each([
    ['429', () => new Response('slow down', { status: 429 })],
    ['503', () => new Response('down', { status: 503 })],
    ['сетевая ошибка', () => new TypeError('fetch failed')],
  ])('при %s переходит на запасной', async (_label, failure) => {
    const { fetchImpl, calls } = scriptedFetch({ primary: [failure()], fallback: [okResponse({ a: 1 })] })

    const result = await createModelRoute(options(fetchImpl)).completeJson(request)

    expect(result.route).toBe('fallback')
    expect(result.model).toBe(FALLBACK_MODEL)
    expect(calls.map((call) => call.route)).toEqual(['primary', 'fallback'])
    expect(new Headers(calls[1]?.init.headers).get('authorization')).toBe(`Bearer ${fallbackKey}`)
  })

  it('при тайм-ауте переходит на запасной', async () => {
    const { fetchImpl } = scriptedFetch({ primary: ['hang'], fallback: [okResponse({ a: 1 })] })

    const pending = createModelRoute(options(fetchImpl, { timeoutMs: 5_000 })).completeJson(request)
    await vi.advanceTimersByTimeAsync(5_001)

    await expect(pending).resolves.toMatchObject({ route: 'fallback' })
  })

  it('при прочих 4xx — сразу ошибка без запасного пути', async () => {
    const { fetchImpl, calls } = scriptedFetch({
      primary: [new Response(`{"error":"invalid key ${primaryKey}"}`, { status: 401 })],
      fallback: [okResponse({ a: 1 })],
    })

    const error = await createModelRoute(options(fetchImpl)).completeJson(request).catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(ModelRouteError)
    expect(error).toMatchObject({ status: 401, route: 'primary', reason: 'client_error' })
    expect(String((error as Error).message)).not.toContain(primaryKey)
    expect(calls).toHaveLength(1)
  })

  it('оба пути недоступны — ошибка unavailable', async () => {
    const { fetchImpl } = scriptedFetch({
      primary: [new Response('', { status: 500 })],
      fallback: [new Response('', { status: 502 })],
    })

    await expect(createModelRoute(options(fetchImpl)).completeJson(request)).rejects.toMatchObject({
      reason: 'unavailable',
      route: 'fallback',
    })
  })

  it('ответ не JSON — ошибка bad_response', async () => {
    const { fetchImpl } = scriptedFetch({
      primary: [Response.json({ choices: [{ message: { content: 'не json' } }] })],
      fallback: [],
    })

    await expect(createModelRoute(options(fetchImpl)).completeJson(request)).rejects.toMatchObject({
      reason: 'bad_response',
    })
  })

  it('после перехода держится запасного и возвращается на основной через retryPrimaryAfterMs', async () => {
    const { fetchImpl, calls } = scriptedFetch({
      primary: [new Response('', { status: 503 }), okResponse({ back: true })],
      fallback: [okResponse({ n: 1 }), okResponse({ n: 2 })],
    })
    const route = createModelRoute(options(fetchImpl, { retryPrimaryAfterMs: 60_000 }))

    await route.completeJson(request)
    expect(route.state().onFallbackSince).toBe(Date.parse('2026-10-26T10:00:00Z'))

    vi.advanceTimersByTime(59_000)
    expect((await route.completeJson(request)).route).toBe('fallback')

    vi.advanceTimersByTime(1_000)
    expect((await route.completeJson(request)).route).toBe('primary')
    expect(route.state().onFallbackSince).toBeNull()
    expect(calls.map((call) => call.route)).toEqual(['primary', 'fallback', 'fallback', 'primary'])
  })

  it('пауза по умолчанию до возврата — 10 минут', async () => {
    const { fetchImpl } = scriptedFetch({
      primary: [new Response('', { status: 503 }), okResponse({})],
      fallback: [okResponse({}), okResponse({})],
    })
    const route = createModelRoute(options(fetchImpl))

    await route.completeJson(request)
    vi.advanceTimersByTime(599_999)
    expect((await route.completeJson(request)).route).toBe('fallback')
    vi.advanceTimersByTime(1)
    expect((await route.completeJson(request)).route).toBe('primary')
  })
})

describe('createModelRoute с подставным сервером модели', () => {
  let primary: FakeModelServer
  let fallback: FakeModelServer

  beforeEach(async () => {
    primary = await startFakeModel()
    fallback = await startFakeModel()
  })

  afterEach(async () => {
    await primary.close()
    await fallback.close()
  })

  it('ходит по настоящему HTTP и переходит на запасной сервер', async () => {
    primary.failNext(503)
    fallback.replyNext({ verdict: 'bad' }, { cachedPromptTokens: 7 })

    const route = createModelRoute({
      primary: { baseUrl: primary.baseUrl, apiKey: primaryKey, model: PRIMARY_MODEL },
      fallback: { baseUrl: fallback.baseUrl, apiKey: fallbackKey, model: FALLBACK_MODEL },
    })
    const result = await route.completeJson({ ...request, sessionId: 'case-7' })

    expect(result).toMatchObject({ json: { verdict: 'bad' }, route: 'fallback' })
    expect(result.usage.cachedPromptTokens).toBe(7)
    expect(primary.requests).toHaveLength(1)
    expect(fallback.requests[0]?.body).toMatchObject({ model: FALLBACK_MODEL })
    expect(fallback.requests[0]?.headers['x-session-id']).toBe('case-7')
  })
})
