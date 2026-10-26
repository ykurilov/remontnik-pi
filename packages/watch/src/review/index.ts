import { ModelRouteError, type ModelRoute, type ModelUsage } from '@ykurilov/remontnik-core/model-route'
import { createReviewQueue, type DeferredSummary, type ReviewJob, type ReviewQueueStats } from './review-queue.js'
import {
  REVIEW_MAX_OUTPUT_TOKENS,
  ReviewResponseError,
  buildReviewRequest,
  parseReviewResponse,
  type ConversationMessage,
  type ReviewFinding,
} from './rubric.js'

// Чтение законченных разговоров (R11). Горячий путь приложения — только `conversationFinished`:
// копия сообщений в память и таймер. Модель вызывается в фоне, по одному разговору, в пределах суточного бюджета.
// Ни один путь здесь не выпускает исключение наружу.

export { BAD_ANSWER_CATEGORIES, BAD_ANSWER_LABELS, type BadAnswerCategory, type ConversationMessage, type ReviewFinding } from './rubric.js'
export { dayKey, type DeferredSummary, type ReviewQueueStats } from './review-queue.js'

/** Оценка цены DeepSeek 4.1 Flash за токен, с запасом: нужна только для бюджета, счётом не является. */
export const INPUT_USD_PER_TOKEN = 0.3e-6
export const OUTPUT_USD_PER_TOKEN = 1.2e-6
/** Токен кэша стоит в десять раз дешевле обычного входного. */
const CACHED_INPUT_DISCOUNT = 0.1
/** Для русского текста берём худший случай: два символа на токен. */
const CHARS_PER_TOKEN = 2
export const REVIEW_RETRY_DELAYS_MS = Object.freeze([60_000, 600_000]) as readonly number[]
/** Пока что-то отложено из-за бюджета, раз в это время смотрим, не наступили ли новые сутки. */
const DEFERRED_RECHECK_MS = 10 * 60_000
const DEFAULT_SUMMARY_DELAY_MS = 5 * 60_000
const MAX_CONVERSATION_MESSAGES = 1000
const MAX_STORED_MESSAGE_CHARS = 20_000
const SESSION_ID = 'remontnik-review'
const ROLES: readonly string[] = ['user', 'assistant', 'system', 'tool']

export interface FinishedConversation {
  id: string
  messages: readonly { role: string; content: string }[]
  /** Сведения приложения о разговоре; в событие попадает только строковый `chatId`. */
  meta?: Record<string, unknown>
}

export interface ReviewedFinding {
  conversationId: string
  meta: Record<string, unknown>
  finding: ReviewFinding
}

export interface ConversationReviewerOptions {
  botDescription: string
  usdPerDay: number
  /** Порог уверенности отметки; по умолчанию 0.7. */
  minConfidence?: number
  /** Пояс для границы суток; по умолчанию UTC. */
  timeZone?: string
  model: ModelRoute
  /** Вычистка приложения поверх встроенной. */
  redact?: (text: string) => string
  /** Файл расхода за сутки. */
  stateFile?: string
  /** Паузы перед повторами после сбоя; число попыток — на одну больше. */
  retryDelaysMs?: readonly number[]
  maxJobs?: number
  /**
   * Через сколько после первого отложенного разговора отправить сводку «отложено N»: за это время успевают
   * набраться остальные. По умолчанию 5 минут.
   */
  summaryDelayMs?: number
  now?: () => number
  onFinding(found: ReviewedFinding): void
  onDeferredSummary?(summary: DeferredSummary): void
  onError?(what: string, error?: unknown): void
}

export interface ConversationReviewer {
  /** Ставит законченный разговор в очередь. Не ждёт сети и не бросает. */
  conversationFinished(conversation: FinishedConversation): void
  /** Ждёт, пока очередь не опустеет (с учётом повторов). Для тестов и остановки. */
  idle(): Promise<void>
  stats(): ReviewQueueStats
  close(): void
}

function snapshotMessages(raw: unknown): ConversationMessage[] | null {
  if (!Array.isArray(raw)) return null
  const messages: ConversationMessage[] = []
  for (const item of raw.slice(-MAX_CONVERSATION_MESSAGES)) {
    if (item === null || typeof item !== 'object') return null
    const { role, content } = item as { role?: unknown; content?: unknown }
    if (typeof role !== 'string' || !ROLES.includes(role) || typeof content !== 'string') return null
    messages.push({ role: role as ConversationMessage['role'], content: content.slice(0, MAX_STORED_MESSAGE_CHARS) })
  }
  return messages
}

function costOf(usage: ModelUsage): number {
  if (usage.costUsd !== null) return usage.costUsd
  const cached = Math.min(usage.cachedPromptTokens, usage.promptTokens)
  return (
    (usage.promptTokens - cached) * INPUT_USD_PER_TOKEN +
    cached * INPUT_USD_PER_TOKEN * CACHED_INPUT_DISCOUNT +
    usage.completionTokens * OUTPUT_USD_PER_TOKEN
  )
}

export function createConversationReviewer(options: ConversationReviewerOptions): ConversationReviewer {
  const now = options.now ?? Date.now
  const minConfidence = options.minConfidence ?? 0.7
  const retryDelays = options.retryDelaysMs ?? REVIEW_RETRY_DELAYS_MS
  const maxAttempts = retryDelays.length + 1
  const onError = options.onError ?? (() => {})
  const queue = createReviewQueue({
    usdPerDay: options.usdPerDay,
    now,
    onError,
    ...(options.timeZone === undefined ? {} : { timeZone: options.timeZone }),
    ...(options.stateFile === undefined ? {} : { stateFile: options.stateFile }),
    ...(options.maxJobs === undefined ? {} : { maxJobs: options.maxJobs }),
  })
  const knownIds = new Set<string>()
  const abort = new AbortController()
  const fixedChars = options.botDescription.length + 4000
  let closed = false
  let timer: ReturnType<typeof setTimeout> | null = null
  let running: Promise<void> | null = null
  let summaryTimer: ReturnType<typeof setTimeout> | null = null
  const summaryDelayMs = options.summaryDelayMs ?? DEFAULT_SUMMARY_DELAY_MS

  /** Дорогая оценка с запасом: весь текст по два символа на токен и полный потолок ответа. */
  function estimateUsd(job: ReviewJob): number {
    const chars = fixedChars + job.messages.reduce((sum, message) => sum + message.content.length + 16, 0)
    return Math.ceil(chars / CHARS_PER_TOKEN) * INPUT_USD_PER_TOKEN + REVIEW_MAX_OUTPUT_TOKENS * OUTPUT_USD_PER_TOKEN
  }

  function fail(job: ReviewJob, error: unknown, spentUsd: number): void {
    const giveUp =
      job.attempts + 1 >= maxAttempts || (error instanceof ModelRouteError && error.reason === 'client_error')
    if (giveUp) {
      queue.abandon(job, { spentUsd })
      onError(`разговор ${job.conversationId} не прочитан`, error)
      return
    }
    queue.retryLater(job, { spentUsd, at: now() + (retryDelays[job.attempts] ?? 0) })
  }

  async function review(job: ReviewJob): Promise<void> {
    const request = buildReviewRequest({
      botDescription: options.botDescription,
      messages: job.messages,
      ...(options.redact ? { redact: options.redact } : {}),
    })
    let result: Awaited<ReturnType<ModelRoute['completeJson']>>
    try {
      result = await options.model.completeJson(
        { messages: request.messages, maxTokens: REVIEW_MAX_OUTPUT_TOKENS, temperature: 0, sessionId: SESSION_ID },
        { signal: abort.signal },
      )
    } catch (error) {
      if (closed) {
        queue.retryLater(job, { spentUsd: 0, at: Number.POSITIVE_INFINITY })
        return
      }
      fail(job, error, 0)
      return
    }
    const spentUsd = costOf(result.usage)
    let findings: ReviewFinding[]
    try {
      findings = parseReviewResponse(result.json, { messages: job.messages, minConfidence })
    } catch (error) {
      fail(job, error instanceof ReviewResponseError ? error : new ReviewResponseError(String(error)), spentUsd)
      return
    }
    queue.finish(job, { spentUsd, findings })
    for (const finding of findings) {
      try {
        options.onFinding({ conversationId: job.conversationId, meta: job.meta, finding })
      } catch (error) {
        onError('находка не передана сторожу', error)
      }
    }
  }

  async function drain(): Promise<void> {
    try {
      for (let job = queue.next(estimateUsd); job && !closed; job = queue.next(estimateUsd)) {
        try {
          await review(job)
        } catch (error) {
          queue.abandon(job, { spentUsd: 0 })
          onError(`чтение разговора ${job.conversationId} сорвалось`, error)
        }
      }
      scheduleSummary()
    } catch (error) {
      onError('очередь чтения сорвалась', error)
    }
    if (closed) return
    const readyAt = queue.nextReadyAt()
    if (readyAt !== null) wake(Math.max(0, readyAt - now()))
    else if (queue.stats().deferred > 0) wake(DEFERRED_RECHECK_MS)
  }

  function scheduleSummary(): void {
    if (closed || summaryTimer || !queue.summaryPending()) return
    summaryTimer = setTimeout(() => {
      summaryTimer = null
      try {
        const summary = queue.takeDeferredSummary()
        if (summary) options.onDeferredSummary?.(summary)
      } catch (error) {
        onError('сводка об отложенных разговорах не отправлена', error)
      }
    }, summaryDelayMs)
    summaryTimer.unref?.()
  }

  function wake(delayMs: number): void {
    if (closed) return
    if (timer) clearTimeout(timer)
    timer = setTimeout(
      () => {
        timer = null
        if (running) return
        running = drain().finally(() => {
          running = null
        })
      },
      Math.min(delayMs, 2 ** 31 - 1),
    )
    timer.unref?.()
  }

  return {
    conversationFinished(conversation) {
      try {
        if (closed || conversation === null || typeof conversation !== 'object') return
        const { id, meta } = conversation
        const messages = snapshotMessages(conversation.messages)
        if (typeof id !== 'string' || id === '' || !messages || !messages.some((message) => message.role === 'assistant')) return
        if (knownIds.has(id)) return
        knownIds.add(id)
        if (knownIds.size > 10_000) knownIds.delete(knownIds.values().next().value as string)
        queue.enqueue({
          conversationId: id,
          finishedAt: now(),
          messages,
          meta: meta !== null && typeof meta === 'object' ? { ...meta } : {},
        })
        wake(0)
      } catch (error) {
        onError('разговор не поставлен в очередь чтения', error)
      }
    },
    async idle() {
      const giveUpAt = Date.now() + 120_000
      for (;;) {
        if (running) {
          await running
          continue
        }
        if (closed || (queue.nextReadyAt() === null && !summaryTimer) || Date.now() > giveUpAt) return
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
    },
    stats: () => queue.stats(),
    close() {
      closed = true
      if (timer) clearTimeout(timer)
      if (summaryTimer) clearTimeout(summaryTimer)
      timer = null
      summaryTimer = null
      abort.abort()
    },
  }
}
