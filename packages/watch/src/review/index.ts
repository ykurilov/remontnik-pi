import { createHash } from 'node:crypto'
import {
  ModelRouteError,
  type ModelRoute,
  type ModelUsage,
  type ReasoningEffort,
} from '@ykurilov/remontnik-core/model-route'
import { createReviewQueue, type DeferredSummary, type ReviewJob, type ReviewQueueStats } from './review-queue.js'
import {
  REVIEW_MAX_OUTPUT_TOKENS,
  ReviewResponseError,
  buildReviewRequest,
  cleanConversation,
  compactConversation,
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
const MAX_REMEMBERED_CONVERSATIONS = 10_000
/** Уровень рассуждения при чтении: см. specs/001-self-healing-kit/research.md, раздел «Уровень рассуждения при чтении». */
export const DEFAULT_REVIEW_REASONING_EFFORT: ReasoningEffort = 'low'
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
  /** Набор мест нарушений (правила и темы из описания бота): место попадает в отпечаток случая только из него. */
  places?: readonly string[]
  /** Точные секреты сторожа (ключи, токены): вырезаются из разговора до модели. */
  knownSecrets?: readonly string[]
  /** Уровень рассуждения модели при чтении; по умолчанию см. `DEFAULT_REVIEW_REASONING_EFFORT`. */
  reasoningEffort?: ReasoningEffort
  /** Папка общего учёта расхода приложения: её делят все процессы приложения. Без неё учёт в памяти процесса. */
  spendDir?: string
  /** Сколько чтений в час и в сутки допускается на приложение (по умолчанию 100 и 1000). */
  maxReviewsPerHour?: number
  maxReviewsPerDay?: number
  /** Потолок символов во всех ожидающих разговорах. */
  maxBufferedChars?: number
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

interface Snapshot {
  /** Сообщения после обрезки: ещё не сжатые, чтобы по ним сравнивать разговоры. */
  messages: ConversationMessage[]
  hashOfFirst(count: number): string
}

/** Копия сообщений в пределах, которые нужны чтению; `null` — это не разговор. */
function snapshotMessages(raw: unknown): Snapshot | null {
  if (!Array.isArray(raw)) return null
  const messages: ConversationMessage[] = []
  for (const item of raw.slice(-MAX_CONVERSATION_MESSAGES)) {
    if (item === null || typeof item !== 'object') return null
    const { role, content } = item as { role?: unknown; content?: unknown }
    if (typeof role !== 'string' || !ROLES.includes(role) || typeof content !== 'string') return null
    messages.push({ role: role as ConversationMessage['role'], content })
  }
  return {
    messages,
    hashOfFirst(count) {
      const hash = createHash('sha256')
      for (const message of messages.slice(0, count)) hash.update(`${message.role}\0${message.content.length}\0${message.content}\0`)
      return hash.digest('hex')
    },
  }
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
  const places = options.places ?? []
  const reasoningEffort = options.reasoningEffort ?? DEFAULT_REVIEW_REASONING_EFFORT
  const onError = options.onError ?? (() => {})
  const queue = createReviewQueue({
    usdPerDay: options.usdPerDay,
    now,
    onError,
    ...(options.timeZone === undefined ? {} : { timeZone: options.timeZone }),
    ...(options.spendDir === undefined ? {} : { spendDir: options.spendDir }),
    ...(options.maxJobs === undefined ? {} : { maxJobs: options.maxJobs }),
    ...(options.maxBufferedChars === undefined ? {} : { maxBufferedChars: options.maxBufferedChars }),
    ...(options.maxReviewsPerHour === undefined ? {} : { maxReviewsPerHour: options.maxReviewsPerHour }),
    ...(options.maxReviewsPerDay === undefined ? {} : { maxReviewsPerDay: options.maxReviewsPerDay }),
  })
  /** Что уже читали по номеру разговора: число сообщений и отпечаток их текста. */
  const known = new Map<string, { count: number; hash: string }>()
  /** Запрос и очищенный разговор считаются один раз на задание: по ним и оценка, и отправка, и сверка цитат. */
  const prepared = new WeakMap<ReviewJob, { request: ReturnType<typeof buildReviewRequest>; cleaned: ConversationMessage[] }>()
  const abort = new AbortController()
  let closed = false
  let timer: ReturnType<typeof setTimeout> | null = null
  let running: Promise<void> | null = null
  let summaryTimer: ReturnType<typeof setTimeout> | null = null
  const summaryDelayMs = options.summaryDelayMs ?? DEFAULT_SUMMARY_DELAY_MS

  function prepare(job: ReviewJob): { request: ReturnType<typeof buildReviewRequest>; cleaned: ConversationMessage[] } {
    let ready = prepared.get(job)
    if (!ready) {
      const cleaned = cleanConversation(job.messages, {
        ...(options.redact ? { redact: options.redact } : {}),
        ...(options.knownSecrets ? { knownSecrets: options.knownSecrets } : {}),
      })
      const request = buildReviewRequest({ botDescription: options.botDescription, places, messages: cleaned })
      ready = { request, cleaned }
      prepared.set(job, ready)
    }
    return ready
  }

  /** Дорогая оценка с запасом: ровно то, что уйдёт модели, по два символа на токен, и полный потолок ответа. */
  function estimateUsd(job: ReviewJob): number {
    const chars = prepare(job).request.messages.reduce((sum, message) => sum + message.content.length + 16, 0)
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

  /** Расход ошибки модели: оплаченный ответ, который не приняли, и попытки с неизвестной ценой — по оценке. */
  function failureCost(error: unknown, job: ReviewJob): number {
    if (!(error instanceof ModelRouteError)) return 0
    return (error.usage ? costOf(error.usage) : 0) + error.unknownCostAttempts * estimateUsd(job)
  }

  async function review(job: ReviewJob): Promise<void> {
    const { request, cleaned } = prepare(job)
    let result: Awaited<ReturnType<ModelRoute['completeJson']>>
    try {
      result = await options.model.completeJson(
        {
          messages: request.messages,
          maxTokens: REVIEW_MAX_OUTPUT_TOKENS,
          temperature: 0,
          sessionId: SESSION_ID,
          reasoningEffort,
        },
        { signal: abort.signal },
      )
    } catch (error) {
      if (closed) {
        // Остановка посреди запроса: он мог уйти и быть оплачен, поэтому бюджет списывается по оценке.
        queue.retryLater(job, { spentUsd: estimateUsd(job), at: Number.POSITIVE_INFINITY })
        return
      }
      fail(job, error, failureCost(error, job))
      return
    }
    const spentUsd = costOf(result.usage) + result.unknownCostAttempts * estimateUsd(job)
    let findings: ReviewFinding[]
    try {
      findings = parseReviewResponse(result.json, {
        messages: cleaned,
        minConfidence,
        places,
        fromIndex: job.reviewFrom ?? 0,
      })
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
        } finally {
          prepared.delete(job)
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
        const snapshot = snapshotMessages(conversation.messages)
        if (typeof id !== 'string' || id === '' || !snapshot) return
        const { messages } = snapshot
        // Без реплики пользователя или без ответа бота читать нечего.
        if (!messages.some((message) => message.role === 'user') || !messages.some((message) => message.role === 'assistant')) return

        // Тот же номер: тот же разговор — пропуск; разговор продолжили — читаем снова, но ищем только в новых сообщениях.
        const before = known.get(id)
        let reviewFrom = 0
        const hash = snapshot.hashOfFirst(messages.length)
        if (before) {
          if (before.count === messages.length && before.hash === hash) return
          if (messages.length > before.count && snapshot.hashOfFirst(before.count) === before.hash) reviewFrom = before.count
        }
        known.delete(id)
        known.set(id, { count: messages.length, hash })
        if (known.size > MAX_REMEMBERED_CONVERSATIONS) known.delete(known.keys().next().value as string)

        queue.enqueue({
          conversationId: id,
          finishedAt: now(),
          // В памяти остаётся только то, что уйдёт модели: длинные сообщения обрезаны, середина длинного разговора пропущена.
          messages: compactConversation(messages),
          meta: meta !== null && typeof meta === 'object' ? { ...meta } : {},
          ...(reviewFrom > 0 ? { reviewFrom } : {}),
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
