import { createModels, fauxAssistantMessage, fauxProvider, type AssistantMessage, type Context, type SimpleStreamOptions } from '@earendil-works/pi-ai'
import { describe, expect, it } from 'vitest'
import { createDoctorModels, createFallbackProvider, DOCTOR_MODEL_ID, DOCTOR_PROVIDER_ID } from './provider-fallback.js'

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
    expect(built.models.getModel(DOCTOR_PROVIDER_ID, DOCTOR_MODEL_ID)).toBeDefined()
  })

  it('без ключа DeepSeek не собирается', () => {
    expect(() => createDoctorModels({ OPENROUTER_API_KEY: 'test-openrouter' })).toThrow(/DEEPSEEK_API_KEY/)
  })
})
