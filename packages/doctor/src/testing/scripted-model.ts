import {
  createAssistantMessageEventStream,
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Model,
  type MutableModels,
  type Provider,
  type SimpleStreamOptions,
  type TranscriptContext,
} from '@earendil-works/pi-ai'

// Модель врача по сценарию: очередь заранее записанных ответов поверх `fauxProvider` из pi-ai
// (в `pi-durable/testing` подставной модели нет — только проверки хранилища и окружения).
// Ничего не зовёт по сети. Каждый ответ может «стоить» заданную сумму: так проверяется потолок расходов.

export const SCRIPTED_PROVIDER = 'remontnik-scripted'
export const SCRIPTED_MODEL = 'doctor-scripted'

export type ScriptStep = AssistantMessage | ((context: TranscriptContext, signal: AbortSignal | undefined) => AssistantMessage | Promise<AssistantMessage>)

export interface ScriptedModelOptions {
  /** Сколько долларов записывать на каждый ответ. По умолчанию 0. */
  costPerResponseUsd?: number
  /**
   * Наибольшая цена ответа по цене модели — столько врач бронирует перед запросом. По умолчанию `costPerResponseUsd`,
   * а при бесплатных ответах — доля цента: модель без цены врач не зовёт. Вход бесплатный, поэтому бронь от длины
   * разговора не зависит.
   */
  maxResponseUsd?: number
}

/** Предел длины ответа модели по сценарию: из него и цены выхода складывается наибольшая цена ответа. */
const SCRIPTED_MAX_TOKENS = 1_000
/** Наибольшая цена ответа, когда ответы бесплатны. */
const SCRIPTED_FREE_MAX_RESPONSE_USD = 0.000_1

export interface ScriptedModel {
  models: MutableModels
  model: { provider: string; modelId: string }
  /** Добавить ответы в конец очереди. Кончилась очередь — модель отвечает ошибкой. */
  script(...steps: ScriptStep[]): void
  pending(): number
  /** Что модель получала: системный промпт и сообщения каждого запроса, по порядку. */
  readonly requests: TranscriptContext[]
}

/** Ответ текстом, без инструментов. */
export function say(text: string): AssistantMessage {
  return fauxAssistantMessage(text)
}

/** Ответ одним вызовом инструмента. */
export function callTool(name: string, args: Record<string, unknown>): AssistantMessage {
  return fauxAssistantMessage(fauxToolCall(name, args as Parameters<typeof fauxToolCall>[1]), { stopReason: 'toolUse' })
}

/** Ответ несколькими вызовами инструментов в одном ходе модели. */
export function callTools(...calls: [name: string, args: Record<string, unknown>][]): AssistantMessage {
  return fauxAssistantMessage(
    calls.map(([name, args]) => fauxToolCall(name, args as Parameters<typeof fauxToolCall>[1])),
    { stopReason: 'toolUse' },
  )
}

/** Ответ, который не приходит, пока запрос не отменят: для проверок перезапуска посреди работы. */
export const hang: ScriptStep = (_context, signal) =>
  new Promise<AssistantMessage>((_resolve, reject) => {
    if (signal?.aborted) reject(new Error('запрос отменён'))
    signal?.addEventListener('abort', () => reject(new Error('запрос отменён')), { once: true })
  })

export function createScriptedModel(options: ScriptedModelOptions = {}): ScriptedModel {
  const cost = options.costPerResponseUsd ?? 0
  const maxResponseUsd = options.maxResponseUsd ?? (cost || SCRIPTED_FREE_MAX_RESPONSE_USD)
  const outputUsdPerMtok = (maxResponseUsd * 1_000_000) / SCRIPTED_MAX_TOKENS
  const faux = fauxProvider({
    provider: SCRIPTED_PROVIDER,
    models: [{ id: SCRIPTED_MODEL, contextWindow: 200_000, maxTokens: SCRIPTED_MAX_TOKENS, cost: { input: 0, output: outputUsdPerMtok, cacheRead: 0, cacheWrite: 0 } }],
  })
  const requests: TranscriptContext[] = []

  const withCost = (message: AssistantMessage) => {
    message.usage = { ...message.usage, cost: { ...message.usage.cost, total: cost, output: cost } }
  }

  // faux пересчитывает расход сам по цене модели, поэтому цена ответа дописывается в уже готовый поток.
  const priced = (inner: AssistantMessageEventStream): AssistantMessageEventStream => {
    const out = createAssistantMessageEventStream()
    void (async () => {
      for await (const event of inner) {
        if (event.type === 'done') withCost(event.message)
        if (event.type === 'error') withCost(event.error)
        out.push(event)
      }
      out.end()
    })()
    return out
  }

  const streamSimple = (model: Model<Api>, context: TranscriptContext, streamOptions?: SimpleStreamOptions) =>
    priced(faux.provider.streamSimple(model, context, streamOptions))

  const provider: Provider = {
    id: SCRIPTED_PROVIDER,
    name: 'Ремонтник: модель по сценарию',
    auth: { apiKey: { name: 'Без ключа', resolve: async () => ({ auth: {} }) } },
    getModels: () => faux.models,
    stream: (model, context, streamOptions) => streamSimple(model, context, streamOptions as SimpleStreamOptions),
    streamSimple,
  }
  const models = createModels()
  models.setProvider(provider)

  return {
    models,
    model: { provider: SCRIPTED_PROVIDER, modelId: SCRIPTED_MODEL },
    requests,
    script(...steps) {
      faux.appendResponses(
        steps.map((step) => (context: TranscriptContext, streamOptions: SimpleStreamOptions | undefined) => {
          requests.push(structuredClone(context))
          return typeof step === 'function' ? step(context, streamOptions?.signal) : step
        }),
      )
    },
    pending: () => faux.getPendingResponseCount(),
  }
}
