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
import { DEFAULT_RETRY_PRIMARY_AFTER_MS, FALLBACK_MODEL } from '@ykurilov/remontnik-core/model-route'

// Модель врача для pi-durable: один поставщик pi-ai поверх двух путей (R2).
// Основной — DeepSeek напрямую, запасной — OpenRouter. 429, 5xx, сбой сети или тайм-аут до начала ответа
// уводят на запасной путь на 10 минут; прочие 4xx — ошибка без перехода (запасной ответит так же).
// Для pi-durable это одна модель с постоянным именем: переключение не меняет ни промпт, ни набор инструментов.

export const DOCTOR_PROVIDER_ID = 'remontnik'
export const DOCTOR_MODEL_ID = 'doctor'
/** Модель DeepSeek V4.1 Flash в каталоге pi-ai 1.4.0. В core путь сторожа зовёт её `deepseek-4.1-flash`. */
export const DEEPSEEK_CATALOG_MODEL = 'deepseek-flash'

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

function statusFromMessage(text: string | undefined): number | undefined {
  const match = text?.match(/^\s*(\d{3})\b/) ?? text?.match(/\bstatus(?: code)?:? (\d{3})\b/i)
  return match ? Number(match[1]) : undefined
}

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
  return target.baseUrl ? { ...model, baseUrl: target.baseUrl } : model
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
          out.push(event)
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
