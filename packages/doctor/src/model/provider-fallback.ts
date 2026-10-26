import {
  createAssistantMessageEventStream,
  createModels,
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Model,
  type MutableModels,
  type Provider,
  type SimpleStreamOptions,
  type TranscriptContext,
} from '@earendil-works/pi-ai'
import { deepseekProvider } from '@earendil-works/pi-ai/providers/deepseek'
import { openrouterProvider } from '@earendil-works/pi-ai/providers/openrouter'
import { DEFAULT_RETRY_PRIMARY_AFTER_MS, FALLBACK_MODEL, PRIMARY_MODEL } from '@ykurilov/remontnik-core/model-route'
import { mayHaveBeenPaid, maxRequestUsd, statusFromMessage, unknownPriceOf } from './request-price.js'

// Модель врача для pi-durable: один поставщик pi-ai поверх двух путей (R2).
// Основной — DeepSeek напрямую, запасной — OpenRouter. 429, 5xx, сбой сети или тайм-аут до начала ответа
// уводят на запасной путь на 10 минут; прочие 4xx — ошибка без перехода (запасной ответит так же).
// Для pi-durable это одна модель с постоянным именем: переключение не меняет ни промпт, ни набор инструментов.
//
// Деньги (FR-030): один запрос может уйти на оба пути, поэтому цена модели врача для брони — сумма самых дорогих
// ставок обоих путей. Основной путь оборвался без кода ответа (мог быть оплачен) — к счёту запасного прибавляется
// его наибольшая цена. Предел ответа — `DOCTOR_MAX_OUTPUT_TOKENS`, а не полный предел модели: из него бронь.

export const DOCTOR_PROVIDER_ID = 'remontnik'
export const DOCTOR_MODEL_ID = 'doctor'
/** Модель основного пути: то же имя, что у сторожа, и то же, что в каталоге pi-ai 1.4.0. */
export const DEEPSEEK_CATALOG_MODEL = PRIMARY_MODEL

/**
 * Предел длины ответа модели врача. Столько же pi-durable оставляет в окне разговора под ответ (`reserveTokens`),
 * ход этапа лечения — рассуждение и вызов инструмента с правкой файла — в него укладывается. Полный предел
 * DeepSeek (384 тыс. токенов) держал бы на каждый запрос бронь около $0.46 и съедал бы дневной потолок.
 */
export const DOCTOR_MAX_OUTPUT_TOKENS = 16_384

export type RouteName = 'primary' | 'fallback'

export interface ModelRouteTarget {
  provider: Provider
  modelId: string
  apiKey?: string
  baseUrl?: string
  headers?: Record<string, string>
}

export interface FallbackProviderOptions {
  primary: ModelRouteTarget
  fallback: ModelRouteTarget
  retryPrimaryAfterMs?: number
  now?: () => number
  onSwitch?: (event: { to: RouteName; reason: string }) => void
}

export interface FallbackProvider extends Provider {
  route(): { current: RouteName; onFallbackSince: number | null }
}

export type FailureKind = 'fallback' | 'fatal' | 'aborted'

/** Что делать с ответом-ошибкой основного пути. `status` — код HTTP, если его удалось подсмотреть. */
export function failureKind(message: AssistantMessage, status?: number): FailureKind {
  if (message.stopReason === 'aborted') return 'aborted'
  const code = status ?? statusFromMessage(message.errorMessage)
  if (code !== undefined && code >= 400 && code < 500 && code !== 429) return 'fatal'
  // 429, 5xx, сбой сети, тайм-аут и прочие ответы без кода — поставщик не справился, пробуем запасной путь.
  return 'fallback'
}

type StreamEvent = Parameters<AssistantMessageEventStream['push']>[0]

/** Событие, после которого ответ уже начался и переключать путь нельзя. */
function isContent(event: StreamEvent): boolean {
  if (event.type === 'done' || event.type === 'error') return true
  if (event.type.startsWith('toolcall_')) return true
  return event.type.endsWith('_delta') && 'delta' in event && event.delta !== ''
}

function findModel(target: ModelRouteTarget): Model<Api> {
  const model = target.provider.getModels().find((candidate) => candidate.id === target.modelId)
  if (!model) throw new Error(`модели ${target.modelId} нет у поставщика ${target.provider.id}`)
  const maxTokens = Math.min(model.maxTokens || DOCTOR_MAX_OUTPUT_TOKENS, DOCTOR_MAX_OUTPUT_TOKENS)
  return { ...model, maxTokens, ...(target.baseUrl ? { baseUrl: target.baseUrl } : {}) }
}

/**
 * Ставки обоих путей сложены: вход — самые дорогие ставки входа путей, выход — самые дорогие ставки выхода.
 * Цена хоть одного пути неизвестна — у модели врача нули, и бронь запрос не пропустит.
 */
function bothPathsCost(models: Model<Api>[]): Model<Api>['cost'] {
  if (models.some((model) => unknownPriceOf(model))) return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  const top = (model: Model<Api>, pick: (rate: Model<Api>['cost']) => number) => Math.max(...[model.cost, ...(model.cost.tiers ?? [])].map(pick))
  const sum = (pick: (rate: Model<Api>['cost']) => number) => models.reduce((total, model) => total + top(model, pick), 0)
  return {
    input: sum((rate) => Math.max(rate.input, rate.cacheRead, rate.cacheWrite)),
    output: sum((rate) => rate.output),
    cacheRead: sum((rate) => rate.cacheRead),
    cacheWrite: sum((rate) => rate.cacheWrite),
  }
}

/** К счёту ответа прибавлена цена прошлого пути. */
function withExtraCost(event: StreamEvent, extraUsd: number): StreamEvent {
  const add = (message: AssistantMessage): AssistantMessage => ({ ...message, usage: { ...message.usage, cost: { ...message.usage.cost, total: message.usage.cost.total + extraUsd } } })
  if (event.type === 'done') return { ...event, message: add(event.message) }
  if (event.type === 'error') return { ...event, error: add(event.error) }
  return event
}

export function createFallbackProvider(options: FallbackProviderOptions): FallbackProvider {
  const now = options.now ?? Date.now
  const retryPrimaryAfterMs = options.retryPrimaryAfterMs ?? DEFAULT_RETRY_PRIMARY_AFTER_MS
  const routes = {
    primary: { target: options.primary, model: findModel(options.primary) },
    fallback: { target: options.fallback, model: findModel(options.fallback) },
  }
  const publicModel: Model<Api> = {
    ...routes.primary.model,
    cost: bothPathsCost([routes.primary.model, routes.fallback.model]),
    id: DOCTOR_MODEL_ID,
    name: 'Ремонтник: модель врача',
    provider: DOCTOR_PROVIDER_ID,
  }
  let onFallbackSince: number | null = null

  const current = (): RouteName =>
    onFallbackSince !== null && now() - onFallbackSince < retryPrimaryAfterMs ? 'fallback' : 'primary'

  function requestOptions(route: RouteName, base: SimpleStreamOptions | undefined, seen: { status?: number }): SimpleStreamOptions {
    const { target } = routes[route]
    const fetchImpl = base?.fetch ?? globalThis.fetch
    return {
      ...base,
      // Предел ответа уходит в запрос всегда и совпадает с бронью: пустой или 0 у вызывающего — предел модели врача
      // (`DOCTOR_MAX_OUTPUT_TOKENS`), тот же, по которому бронирует учёт.
      maxTokens: base?.maxTokens || publicModel.maxTokens,
      ...(target.apiKey === undefined ? {} : { apiKey: target.apiKey }),
      headers: { ...base?.headers, ...target.headers },
      fetch: async (input, init) => {
        const response = await fetchImpl(input, init)
        seen.status = response.status
        return response
      },
    }
  }

  function streamSimple(_model: Model<Api>, context: TranscriptContext, base?: SimpleStreamOptions): AssistantMessageEventStream {
    const out = createAssistantMessageEventStream()
    const order: RouteName[] = current() === 'fallback' ? ['fallback'] : ['primary', 'fallback']
    void (async () => {
      let paidBeforeUsd = 0
      for (const [index, route] of order.entries()) {
        const seen: { status?: number } = {}
        const inner = routes[route].target.provider.streamSimple(routes[route].model, context, requestOptions(route, base, seen))
        // До первого настоящего содержимого события держим: пустые `start`/`text_start` ещё не ответ,
        // и после них можно молча уйти на запасной путь.
        const held: StreamEvent[] = []
        let started = false
        let retry = false
        for await (const event of inner) {
          if (!started && event.type === 'error' && index < order.length - 1 && failureKind(event.error, seen.status) === 'fallback') {
            const reported = event.error.usage.cost.total
            // Путь без цены здесь не бывает под бронью: у модели врача тогда нулевая цена, и бронь отказывает.
            const routeMaxUsd = unknownPriceOf(routes[route].model) ? 0 : maxRequestUsd(routes[route].model, context, base?.maxTokens || publicModel.maxTokens)
            paidBeforeUsd += mayHaveBeenPaid(event.error, seen.status) ? Math.max(reported, routeMaxUsd) : reported
            onFallbackSince = now()
            options.onSwitch?.({ to: 'fallback', reason: event.error.errorMessage ?? 'ошибка без текста' })
            retry = true
            break
          }
          if (!started && !isContent(event)) {
            held.push(event)
            continue
          }
          if (!started) {
            for (const early of held.splice(0)) out.push(early)
            started = true
          }
          out.push(paidBeforeUsd > 0 ? withExtraCost(event, paidBeforeUsd) : event)
          if (event.type === 'done' && route === 'primary' && onFallbackSince !== null) {
            onFallbackSince = null
            options.onSwitch?.({ to: 'primary', reason: 'основной путь снова отвечает' })
          }
        }
        if (!retry) break
      }
      out.end()
    })().catch((error: unknown) => {
      out.end({
        role: 'assistant',
        content: [],
        api: publicModel.api,
        provider: DOCTOR_PROVIDER_ID,
        model: DOCTOR_MODEL_ID,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: 'error',
        errorMessage: error instanceof Error ? error.message : String(error),
        timestamp: now(),
      } as AssistantMessage)
    })
    return out
  }

  return {
    id: DOCTOR_PROVIDER_ID,
    name: 'Ремонтник: DeepSeek с запасным OpenRouter',
    auth: { apiKey: { name: 'Ключи путей задаёт врач', resolve: async () => ({ auth: {} }) } },
    getModels: () => [publicModel],
    stream: (model, context, streamOptions) => streamSimple(model, context, streamOptions as SimpleStreamOptions),
    streamSimple,
    route: () => ({ current: current(), onFallbackSince }),
  }
}

/** Переменные окружения врача, из которых собирается модель (contracts/deploy-commands.md). */
export interface DoctorModelEnv {
  DEEPSEEK_API_KEY?: string
  DEEPSEEK_BASE_URL?: string
  OPENROUTER_API_KEY?: string
  OPENROUTER_BASE_URL?: string
  PROXY_TOKEN?: string
}

function proxyHeaders(baseUrl: string | undefined, proxyToken: string | undefined): Record<string, string> | undefined {
  // Ключ прокси нужен только своему прокси: на адрес поставщика по умолчанию он не уходит.
  return baseUrl && proxyToken ? { 'X-Proxy-Token': proxyToken } : undefined
}

export function createDoctorModels(
  env: DoctorModelEnv,
  options: Pick<FallbackProviderOptions, 'now' | 'onSwitch' | 'retryPrimaryAfterMs'> = {},
): { models: MutableModels; model: { provider: string; modelId: string }; provider: FallbackProvider } {
  if (!env.DEEPSEEK_API_KEY) throw new Error('врачу нужен ключ DEEPSEEK_API_KEY')
  if (!env.OPENROUTER_API_KEY) throw new Error('врачу нужен ключ OPENROUTER_API_KEY')
  const primaryHeaders = proxyHeaders(env.DEEPSEEK_BASE_URL, env.PROXY_TOKEN)
  const fallbackHeaders = proxyHeaders(env.OPENROUTER_BASE_URL, env.PROXY_TOKEN)
  const provider = createFallbackProvider({
    primary: {
      provider: deepseekProvider(),
      modelId: DEEPSEEK_CATALOG_MODEL,
      apiKey: env.DEEPSEEK_API_KEY,
      ...(env.DEEPSEEK_BASE_URL ? { baseUrl: env.DEEPSEEK_BASE_URL } : {}),
      ...(primaryHeaders ? { headers: primaryHeaders } : {}),
    },
    fallback: {
      provider: openrouterProvider(),
      modelId: FALLBACK_MODEL,
      apiKey: env.OPENROUTER_API_KEY,
      ...(env.OPENROUTER_BASE_URL ? { baseUrl: env.OPENROUTER_BASE_URL } : {}),
      ...(fallbackHeaders ? { headers: fallbackHeaders } : {}),
    },
    ...options,
  })
  const models = createModels()
  models.setProvider(provider)
  return { models, model: { provider: DOCTOR_PROVIDER_ID, modelId: DOCTOR_MODEL_ID }, provider }
}
