import { redactSecrets } from '../redact/index.js'

// Путь к модели для сторожа: DeepSeek напрямую, при перегрузке или недоступности — OpenRouter.
// Только `fetch` и OpenAI-совместимый протокол, ответ — объект JSON (R2).

/** Модель основного пути (DeepSeek API): у DeepSeek она называется `deepseek-flash`, проверено живым запросом. */
export const PRIMARY_MODEL = 'deepseek-flash'
/** Модель запасного пути (OpenRouter). */
export const FALLBACK_MODEL = 'deepseek/deepseek-v4.1-flash-1017'

export const DEFAULT_PRIMARY_BASE_URL = 'https://api.deepseek.com'
export const DEFAULT_FALLBACK_BASE_URL = 'https://openrouter.ai/api/v1'
export const DEFAULT_RETRY_PRIMARY_AFTER_MS = 600_000
export const DEFAULT_MODEL_TIMEOUT_MS = 60_000

export interface ModelEndpoint {
  baseUrl?: string
  apiKey: string
  model: string
  /** Ключ прокси, уходит заголовком `X-Proxy-Token`. */
  proxyToken?: string
}

export interface ModelRouteOptions {
  primary: ModelEndpoint
  fallback: ModelEndpoint
  /** Через сколько после перехода на запасной снова пробовать основной; по умолчанию 10 минут. */
  retryPrimaryAfterMs?: number
  /** Тайм-аут одного обращения; по умолчанию 60 с. */
  timeoutMs?: number
  fetch?: typeof fetch
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface JsonCompletionRequest {
  /** Неизменная часть — первыми сообщениями: так её подхватывает кэш модели (R3). */
  messages: ChatMessage[]
  maxTokens?: number
  temperature?: number
  /** Номер переписки для кэша OpenRouter (`x-session-id`). */
  sessionId?: string
  /** Уровень рассуждения модели; без него поставщик решает сам. */
  reasoningEffort?: ReasoningEffort
}

export type ReasoningEffort = 'low' | 'high' | 'max'

export interface ModelUsage {
  promptTokens: number
  completionTokens: number
  cachedPromptTokens: number
  /** Стоимость, если её сообщил поставщик. */
  costUsd: number | null
}

export type ModelRouteName = 'primary' | 'fallback'

export interface JsonCompletionResult<T = unknown> {
  json: T
  text: string
  route: ModelRouteName
  model: string
  usage: ModelUsage
  /** Сколько прежних попыток этого вызова могли быть оплачены, но расход по ним неизвестен (тайм-аут). */
  unknownCostAttempts: number
}

export interface ModelRoute {
  completeJson<T = unknown>(request: JsonCompletionRequest, options?: { signal?: AbortSignal }): Promise<JsonCompletionResult<T>>
  /** С какого момента идём запасным путём; `null` — основным. */
  state(): { onFallbackSince: number | null }
}

export type ModelRouteFailure = 'client_error' | 'unavailable' | 'bad_response'

/** Ошибка пути к модели. Ключи и токены прокси из текста вырезаны. */
export class ModelRouteError extends Error {
  readonly reason: ModelRouteFailure
  readonly route: ModelRouteName
  readonly status: number | null
  /** Расход оплаченного ответа, который всё же не удалось принять; `null` — расход не известен или ответа не было. */
  usage: ModelUsage | null
  /** Сколько попыток этого вызова могли быть оплачены, но расход по ним неизвестен (тайм-аут, ответ без `usage`). */
  unknownCostAttempts: number

  constructor(
    message: string,
    reason: ModelRouteFailure,
    route: ModelRouteName,
    status: number | null = null,
    cost: { usage?: ModelUsage | null; unknownCostAttempts?: number } = {},
  ) {
    super(message)
    this.name = 'ModelRouteError'
    this.reason = reason
    this.route = route
    this.status = status
    this.usage = cost.usage ?? null
    this.unknownCostAttempts = cost.unknownCostAttempts ?? 0
  }
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500
}

interface OpenAiCompletion {
  choices?: { message?: { content?: string | null } }[]
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    prompt_cache_hit_tokens?: number
    prompt_tokens_details?: { cached_tokens?: number }
    cost?: number
  }
}

export function createModelRoute(options: ModelRouteOptions): ModelRoute {
  const fetchImpl = options.fetch ?? ((input, init) => fetch(input, init))
  const retryPrimaryAfterMs = options.retryPrimaryAfterMs ?? DEFAULT_RETRY_PRIMARY_AFTER_MS
  const timeoutMs = options.timeoutMs ?? DEFAULT_MODEL_TIMEOUT_MS
  const knownSecrets = [options.primary, options.fallback].flatMap((endpoint) => [
    endpoint.apiKey,
    endpoint.proxyToken ?? '',
  ])
  const clean = (text: string): string => redactSecrets(text, { knownSecrets })
  let onFallbackSince: number | null = null

  async function callEndpoint(
    route: ModelRouteName,
    request: JsonCompletionRequest,
    signal: AbortSignal | undefined,
  ): Promise<JsonCompletionResult> {
    const endpoint = options[route]
    const baseUrl = (endpoint.baseUrl ?? (route === 'primary' ? DEFAULT_PRIMARY_BASE_URL : DEFAULT_FALLBACK_BASE_URL))
      .replace(/\/+$/, '')
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      authorization: `Bearer ${endpoint.apiKey}`,
    }
    if (endpoint.proxyToken) headers['x-proxy-token'] = endpoint.proxyToken
    if (request.sessionId) headers['x-session-id'] = request.sessionId
    const body: Record<string, unknown> = {
      model: endpoint.model,
      messages: request.messages,
      response_format: { type: 'json_object' },
      stream: false,
    }
    if (request.maxTokens !== undefined) body.max_tokens = request.maxTokens
    if (request.temperature !== undefined) body.temperature = request.temperature
    if (request.reasoningEffort !== undefined) {
      if (route === 'primary') body.reasoning_effort = request.reasoningEffort
      else body.reasoning = { effort: request.reasoningEffort }
    }
    if (route === 'fallback') body.usage = { include: true }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new Error(`тайм-аут ${timeoutMs} мс`)), timeoutMs)
    const onOuterAbort = (): void => controller.abort(signal?.reason)
    signal?.addEventListener('abort', onOuterAbort, { once: true })

    let response: Response
    let payload: OpenAiCompletion
    try {
      try {
        response = await fetchImpl(`${baseUrl}/chat/completions`, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          signal: controller.signal,
        })
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        // Тайм-аут: запрос ушёл и мог быть оплачен. Обрыв связи или отмена снаружи — нет.
        const timedOut = controller.signal.aborted && !signal?.aborted
        throw new ModelRouteError(`модель недоступна (${route}): ${clean(detail)}`, 'unavailable', route, null, {
          unknownCostAttempts: timedOut ? 1 : 0,
        })
      }
      if (!response.ok) {
        const detail = clean((await response.text().catch(() => '')).slice(0, 500))
        throw new ModelRouteError(
          `модель ответила ${response.status} (${route}): ${detail}`.trim(),
          isRetryableStatus(response.status) ? 'unavailable' : 'client_error',
          route,
          response.status,
        )
      }
      try {
        payload = (await response.json()) as OpenAiCompletion
      } catch {
        throw new ModelRouteError(`ответ модели не JSON (${route})`, 'bad_response', route, response.status, {
          unknownCostAttempts: 1,
        })
      }
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onOuterAbort)
    }

    const text = payload.choices?.[0]?.message?.content ?? ''
    const usage = payload.usage
    const knownUsage: ModelUsage | null = usage
      ? {
          promptTokens: usage.prompt_tokens ?? 0,
          completionTokens: usage.completion_tokens ?? 0,
          cachedPromptTokens: usage.prompt_cache_hit_tokens ?? usage.prompt_tokens_details?.cached_tokens ?? 0,
          costUsd: typeof usage.cost === 'number' ? usage.cost : null,
        }
      : null
    let json: unknown
    try {
      json = JSON.parse(text)
    } catch {
      // Ответ получен и оплачен: расход несём в ошибке, чтобы вызывающий его не потерял.
      throw new ModelRouteError(`модель вернула не JSON (${route})`, 'bad_response', route, response.status, {
        usage: knownUsage,
        unknownCostAttempts: knownUsage ? 0 : 1,
      })
    }
    return {
      json,
      text,
      route,
      model: endpoint.model,
      usage: knownUsage ?? { promptTokens: 0, completionTokens: 0, cachedPromptTokens: 0, costUsd: null },
      unknownCostAttempts: 0,
    }
  }

  return {
    async completeJson<T>(request: JsonCompletionRequest, callOptions: { signal?: AbortSignal } = {}) {
      if (onFallbackSince !== null && Date.now() - onFallbackSince >= retryPrimaryAfterMs) onFallbackSince = null

      // Попытки основного пути, которые могли быть оплачены, но стоимость по ним неизвестна.
      let earlierUnknownCost = 0
      if (onFallbackSince === null) {
        try {
          const result = await callEndpoint('primary', request, callOptions.signal)
          return result as JsonCompletionResult<T>
        } catch (error) {
          const switchToFallback =
            error instanceof ModelRouteError && error.reason === 'unavailable' && !callOptions.signal?.aborted
          if (!switchToFallback) throw error
          earlierUnknownCost = error.unknownCostAttempts
          onFallbackSince = Date.now()
        }
      }
      try {
        const result = await callEndpoint('fallback', request, callOptions.signal)
        result.unknownCostAttempts += earlierUnknownCost
        return result as JsonCompletionResult<T>
      } catch (error) {
        if (error instanceof ModelRouteError) error.unknownCostAttempts += earlierUnknownCost
        throw error
      }
    },
    state: () => ({ onFallbackSince }),
  }
}
