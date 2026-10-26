import { createModels, fauxAssistantMessage, fauxProvider, type AssistantMessage, type Context, type SimpleStreamOptions } from '@earendil-works/pi-ai'
import { describe, expect, it } from 'vitest'
import { maxRequestUsd, unknownPriceOf } from './request-price.js'
import { createDoctorModels, createFallbackProvider, DOCTOR_MAX_OUTPUT_TOKENS, DOCTOR_MODEL_ID, DOCTOR_PROVIDER_ID } from './provider-fallback.js'

const TEN_MINUTES = 600_000

function setup(options: { retryPrimaryAfterMs?: number } = {}) {
  const primary = fauxProvider({ provider: 'primary-test', models: [{ id: 'flash', contextWindow: 64_000 }] })
  const fallback = fauxProvider({ provider: 'fallback-test', models: [{ id: 'flash-routed' }] })
  let clock = 1_000_000
  const seen: { route: string; options: SimpleStreamOptions | undefined }[] = []
  const record = (route: string, answer: string) => (_context: unknown, streamOptions: SimpleStreamOptions | undefined) => {
    seen.push({ route, options: streamOptions })
    return fauxAssistantMessage(answer)
  }
  const provider = createFallbackProvider({
    primary: { provider: primary.provider, modelId: 'flash', apiKey: 'test-primary-key' },
    fallback: { provider: fallback.provider, modelId: 'flash-routed', apiKey: 'test-fallback-key', headers: { 'X-Proxy-Token': 'test-proxy' } },
    now: () => clock,
    ...(options.retryPrimaryAfterMs === undefined ? {} : { retryPrimaryAfterMs: options.retryPrimaryAfterMs }),
  })
  const models = createModels()
  models.setProvider(provider)
  const model = models.getModel(DOCTOR_PROVIDER_ID, DOCTOR_MODEL_ID)
  if (!model) throw new Error('модель врача не найдена')
  const ask = (): Promise<AssistantMessage> => models.completeSimple(model, context())
  return {
    primary,
    fallback,
    provider,
    ask,
    seen,
    record,
    advance: (ms: number) => {
      clock += ms
    },
  }
}

function context(): Context {
  return { systemPrompt: 'Ты врач.', messages: [{ role: 'user', content: 'Привет', timestamp: 0 }] }
}

function textOf(message: AssistantMessage): string {
  return message.content.map((block) => (block.type === 'text' ? block.text : '')).join('')
}

function failure(errorMessage: string, partial = ''): AssistantMessage {
  return fauxAssistantMessage(partial, { stopReason: 'error', errorMessage })
}

describe('обёртка-поставщик DeepSeek → OpenRouter', () => {
  it('отвечает основным путём, пока он работает', async () => {
    const t = setup()
    t.primary.setResponses([fauxAssistantMessage('основной')])
    const answer = await t.ask()
    expect(textOf(answer)).toBe('основной')
    expect(t.fallback.state.callCount).toBe(0)
    expect(t.provider.route().current).toBe('primary')
  })

  it('при 429 переходит на запасной путь и держится его 10 минут, потом пробует основной', async () => {
    const t = setup()
    t.primary.setResponses([failure('429 Too Many Requests'), fauxAssistantMessage('основной снова')])
    t.fallback.setResponses([fauxAssistantMessage('запасной'), fauxAssistantMessage('запасной ещё')])

    expect(textOf(await t.ask())).toBe('запасной')
    expect(t.provider.route().current).toBe('fallback')

    t.advance(TEN_MINUTES - 1)
    expect(textOf(await t.ask())).toBe('запасной ещё')
    expect(t.primary.state.callCount).toBe(1)

    t.advance(1)
    expect(textOf(await t.ask())).toBe('основной снова')
    expect(t.provider.route().current).toBe('primary')
  })

  it.each([
    ['500 Internal Server Error'],
    ['503 Service Unavailable'],
    ['Connection error.'],
    ['Request timed out.'],
    ['fetch failed'],
  ])('ошибка «%s» уводит на запасной путь', async (errorMessage) => {
    const t = setup()
    t.primary.setResponses([failure(errorMessage)])
    t.fallback.setResponses([fauxAssistantMessage('запасной')])
    expect(textOf(await t.ask())).toBe('запасной')
  })

  it('прочие 4xx — ошибка без запасного пути', async () => {
    const t = setup()
    t.primary.setResponses([failure('400 Bad Request: invalid tool schema')])
    t.fallback.setResponses([fauxAssistantMessage('запасной')])
    const answer = await t.ask()
    expect(answer.stopReason).toBe('error')
    expect(answer.errorMessage).toContain('400')
    expect(t.fallback.state.callCount).toBe(0)
    expect(t.provider.route().current).toBe('primary')
  })

  it('ошибка после начала ответа не переключает путь: ответ уже ушёл', async () => {
    const t = setup()
    t.primary.setResponses([failure('500 upstream reset', 'половина ответа')])
    t.fallback.setResponses([fauxAssistantMessage('запасной')])
    const answer = await t.ask()
    expect(answer.stopReason).toBe('error')
    expect(t.fallback.state.callCount).toBe(0)
  })

  it('прерванный запрос не уходит на запасной путь', async () => {
    const t = setup()
    t.primary.setResponses([fauxAssistantMessage('', { stopReason: 'aborted', errorMessage: 'aborted' })])
    t.fallback.setResponses([fauxAssistantMessage('запасной')])
    const answer = await t.ask()
    expect(answer.stopReason).toBe('aborted')
    expect(t.fallback.state.callCount).toBe(0)
  })

  it('если упал и запасной путь, возвращает его ошибку', async () => {
    const t = setup()
    t.primary.setResponses([failure('429 Too Many Requests')])
    t.fallback.setResponses([failure('502 Bad Gateway')])
    const answer = await t.ask()
    expect(answer.stopReason).toBe('error')
    expect(answer.errorMessage).toContain('502')
  })

  it('ключ и заголовки уходят только своему пути', async () => {
    const t = setup()
    t.primary.setResponses([
      (ctx, options) => {
        t.seen.push({ route: 'primary', options })
        return failure('429 Too Many Requests')
      },
    ])
    t.fallback.setResponses([t.record('fallback', 'запасной')])
    await t.ask()
    const [primary, fallback] = t.seen
    expect(primary?.options?.apiKey).toBe('test-primary-key')
    expect(primary?.options?.headers?.['X-Proxy-Token']).toBeUndefined()
    expect(fallback?.options?.apiKey).toBe('test-fallback-key')
    expect(fallback?.options?.headers?.['X-Proxy-Token']).toBe('test-proxy')
  })

  it('модель врача описана как модель основного пути', () => {
    const t = setup()
    const [model] = t.provider.getModels()
    expect(model?.id).toBe(DOCTOR_MODEL_ID)
    expect(model?.provider).toBe(DOCTOR_PROVIDER_ID)
    expect(model?.contextWindow).toBe(64_000)
  })
})

describe('цена модели врача для брони: запрос может уйти на оба пути', () => {
  function priced(routes: { primary: { input: number; output: number; maxTokens: number }; fallback: { input: number; output: number; maxTokens: number } }) {
    const cost = (rate: { input: number; output: number }) => ({ input: rate.input, output: rate.output, cacheRead: 0, cacheWrite: 0 })
    const primary = fauxProvider({ provider: 'primary-test', models: [{ id: 'flash', contextWindow: 64_000, maxTokens: routes.primary.maxTokens, cost: cost(routes.primary) }] })
    const fallback = fauxProvider({ provider: 'fallback-test', models: [{ id: 'flash-routed', maxTokens: routes.fallback.maxTokens, cost: cost(routes.fallback) }] })
    const provider = createFallbackProvider({
      primary: { provider: primary.provider, modelId: 'flash' },
      fallback: { provider: fallback.provider, modelId: 'flash-routed' },
      now: () => 1_000_000,
    })
    const models = createModels()
    models.setProvider(provider)
    const model = models.getModel(DOCTOR_PROVIDER_ID, DOCTOR_MODEL_ID)!
    return { primary, fallback, provider, model, ask: () => models.completeSimple(model, context()) }
  }

  it('предел ответа — DOCTOR_MAX_OUTPUT_TOKENS, а не полный предел модели; цена — сумма путей', () => {
    const t = priced({ primary: { input: 1, output: 2, maxTokens: 384_000 }, fallback: { input: 0.5, output: 4, maxTokens: 100_000 } })
    expect(t.model.maxTokens).toBe(DOCTOR_MAX_OUTPUT_TOKENS)
    expect(t.model.cost).toMatchObject({ input: 1.5, output: 6 })
    const primaryOnly = { ...t.model, cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } }
    const fallbackOnly = { ...t.model, cost: { input: 0.5, output: 4, cacheRead: 0, cacheWrite: 0 } }
    expect(maxRequestUsd(t.model, context(), undefined)).toBeCloseTo(maxRequestUsd(primaryOnly, context(), undefined) + maxRequestUsd(fallbackOnly, context(), undefined))
  })

  it('предел ответа 0 у вызывающего → в запрос уходит DOCTOR_MAX_OUTPUT_TOKENS', async () => {
    const t = setup()
    t.primary.setResponses([t.record('primary', 'основной')])
    const model = t.provider.getModels()[0]!
    const models = createModels()
    models.setProvider(t.provider)
    await models.completeSimple(model, context(), { maxTokens: 0 })
    expect(t.seen[0]?.options?.maxTokens).toBe(DOCTOR_MAX_OUTPUT_TOKENS)
  })

  it('цена одного из путей неизвестна → цена модели врача нулевая: бронь такой запрос не пропустит', () => {
    const t = priced({ primary: { input: 1, output: 2, maxTokens: 1_000 }, fallback: { input: 0, output: 0, maxTokens: 1_000 } })
    expect(unknownPriceOf(t.model)).toBeDefined()
  })

  it('основной путь оборвался без кода ответа (мог быть оплачен) → к счёту запасного прибавлена его наибольшая цена', async () => {
    const t = priced({ primary: { input: 0, output: 2, maxTokens: 1_000 }, fallback: { input: 0, output: 0, maxTokens: 1_000 } })
    t.primary.setResponses([failure('соединение оборвалось')])
    t.fallback.setResponses([fauxAssistantMessage('запасной')])
    const answer = await t.ask()
    expect(textOf(answer)).toBe('запасной')
    expect(answer.usage.cost.total).toBeCloseTo((1_000 * 2) / 1_000_000)
  })

  it('основной путь ответил 429 (запрос отклонён, не оплачен) → счёт только запасного', async () => {
    const t = priced({ primary: { input: 0, output: 2, maxTokens: 1_000 }, fallback: { input: 0, output: 0, maxTokens: 1_000 } })
    t.primary.setResponses([failure('429 Too Many Requests')])
    t.fallback.setResponses([fauxAssistantMessage('запасной')])
    expect((await t.ask()).usage.cost.total).toBe(0)
  })
})

describe('createDoctorModels', () => {
  it('собирает модель врача из переменных окружения DeepSeek и OpenRouter', () => {
    const built = createDoctorModels({
      DEEPSEEK_API_KEY: 'test-deepseek',
      OPENROUTER_API_KEY: 'test-openrouter',
      DEEPSEEK_BASE_URL: 'https://deepseek.example.com',
      OPENROUTER_BASE_URL: 'https://openrouter.example.com/api/v1',
      PROXY_TOKEN: 'test-proxy',
    })
    expect(built.model).toEqual({ provider: DOCTOR_PROVIDER_ID, modelId: DOCTOR_MODEL_ID })
    const model = built.models.getModel(DOCTOR_PROVIDER_ID, DOCTOR_MODEL_ID)
    expect(model?.maxTokens).toBe(DOCTOR_MAX_OUTPUT_TOKENS)
    expect(model?.cost.output).toBeGreaterThan(0)
  })

  it.each([[undefined], [0]])('в тело запроса обоих путей уходит предел ответа 16 384 (предел у вызывающего: %s)', async (maxTokens) => {
    const built = createDoctorModels({
      DEEPSEEK_API_KEY: 'test-deepseek',
      OPENROUTER_API_KEY: 'test-openrouter',
      DEEPSEEK_BASE_URL: 'https://deepseek.example.com',
      OPENROUTER_BASE_URL: 'https://openrouter.example.com/api/v1',
    })
    const bodies: { url: string; body: Record<string, unknown> }[] = []
    const fetch = async (input: string | URL | Request, init?: RequestInit) => {
      bodies.push({ url: String(input instanceof Request ? input.url : input), body: JSON.parse(String(init?.body)) as Record<string, unknown> })
      return new Response(JSON.stringify({ error: { message: 'перегружен' } }), { status: 503, headers: { 'content-type': 'application/json' } })
    }
    const model = built.models.getModel(DOCTOR_PROVIDER_ID, DOCTOR_MODEL_ID)!
    await built.models.completeSimple(model, context(), { fetch, maxRetries: 0, ...(maxTokens === undefined ? {} : { maxTokens }) })
    const [deepseek, openrouter] = bodies
    expect(deepseek?.url).toContain('deepseek.example.com')
    expect(deepseek?.body.max_tokens).toBe(DOCTOR_MAX_OUTPUT_TOKENS)
    expect(openrouter?.url).toContain('openrouter.example.com')
    expect(openrouter?.body.max_completion_tokens).toBe(DOCTOR_MAX_OUTPUT_TOKENS)
  })

  it('без ключа DeepSeek не собирается', () => {
    expect(() => createDoctorModels({ OPENROUTER_API_KEY: 'test-openrouter' })).toThrow(/DEEPSEEK_API_KEY/)
  })
})
