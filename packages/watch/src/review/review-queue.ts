import type { ConversationMessage, ReviewFinding } from './rubric.js'
import { dayKey } from './day.js'
import { createSpendLedger, type SpendLedger } from './spend-ledger.js'

// Очередь чтения законченных разговоров с суточным бюджетом.
// Разговоры читаются по одному. Если оценка стоимости следующего не влезает в остаток бюджета на сутки,
// разговор получает состояние `deferred_budget` и ждёт новых суток; бюджет не превышается никогда.
// Расход и число чтений считает общий учёт приложения (`spend-ledger`): им делятся все процессы приложения.
// Память очереди ограничена и числом разговоров, и суммарным числом символов в них.

export type ReviewJobState = 'queued' | 'reviewing' | 'reviewed' | 'deferred_budget' | 'failed'

export interface ReviewJobInput {
  conversationId: string
  /** Когда разговор закончился, мс. */
  finishedAt: number
  messages: ConversationMessage[]
  meta: Record<string, unknown>
  /** С какого сообщения искать нарушения: раньше уже читали (разговор продолжили после `finish`). */
  reviewFrom?: number
}

export interface ReviewJob extends ReviewJobInput {
  state: ReviewJobState
  /** Сколько попыток чтения уже было неудачными. */
  attempts: number
  /** Не раньше какого времени пробовать снова, мс. */
  notBefore: number
  findings: ReviewFinding[]
  /** Сколько символов занимает разговор в памяти. */
  chars: number
  /** Резерв бюджета под текущую попытку. */
  reservationId: string | null
}

export interface DeferredSummary {
  day: string
  deferred: number
  usdPerDay: number
  spentUsd: number
  /** Что кончилось: деньги суток или число чтений в сутки. */
  reason: 'budget' | 'daily_limit'
  maxReviewsPerDay: number
}

export interface ReviewQueueStats {
  day: string
  usdPerDay: number
  spentUsd: number
  queued: number
  reviewing: number
  /** Сейчас ждут новых суток из-за бюджета или лимита. */
  deferred: number
  /** Прочитано за всё время работы очереди. */
  reviewed: number
  /** Брошено после неудачных попыток. */
  failed: number
  /** Вытеснено потолком очереди. */
  dropped: number
  /** Символов в ожидающих разговорах. */
  bufferedChars: number
  /** Чтений за сегодня во всех процессах приложения. */
  readsToday: number
}

export interface ReviewQueueOptions {
  usdPerDay: number
  /** Сколько чтений в час и в сутки допускается на приложение. */
  maxReviewsPerHour?: number
  maxReviewsPerDay?: number
  /** Пояс (IANA) для границы суток; по умолчанию UTC. Неизвестный пояс — ошибка. */
  timeZone?: string
  now?: () => number
  /** Папка общего учёта расхода приложения. Без неё расход живёт только в памяти. */
  spendDir?: string
  /** Потолок ожидающих разговоров; дальше вытесняется самый старый. */
  maxJobs?: number
  /** Потолок символов во всех ожидающих разговорах; дальше вытесняется самый старый. */
  maxBufferedChars?: number
  onError?: (what: string, error?: unknown) => void
}

export interface ReviewQueue {
  /** Ставит разговор в очередь; ничего не читает и не ждёт. */
  enqueue(input: ReviewJobInput): void
  /**
   * Следующий разговор для чтения или `null`. Бюджет под него уже занят. Разговоры, чья оценка стоимости не влезает
   * в остаток бюджета, откладываются до новых суток; при упоре в часовой лимит чтения ждут своего часа.
   */
  next(estimateUsd: (job: ReviewJob) => number): ReviewJob | null
  finish(job: ReviewJob, result: { spentUsd: number; findings?: ReviewFinding[] }): void
  retryLater(job: ReviewJob, result: { spentUsd: number; at: number }): void
  abandon(job: ReviewJob, result: { spentUsd: number }): void
  /** Ближайшее время, когда в очереди что-то будет готово к чтению; `null` — очередь пуста. */
  nextReadyAt(): number | null
  /** Есть отложенные разговоры, о которых сегодня ещё не сообщали. */
  summaryPending(): boolean
  /** Сводка «отложено N» — один раз за сутки, когда что-то отложено. */
  takeDeferredSummary(): DeferredSummary | null
  stats(): ReviewQueueStats
}

export const DEFAULT_MAX_REVIEW_JOBS = 200
export const DEFAULT_MAX_BUFFERED_CHARS = 4_000_000
export const DEFAULT_MAX_REVIEWS_PER_HOUR = 100
export const DEFAULT_MAX_REVIEWS_PER_DAY = 1000

export { dayKey }

function charsOf(messages: readonly ConversationMessage[]): number {
  let total = 0
  for (const message of messages) total += message.content.length
  return total
}

export function createReviewQueue(options: ReviewQueueOptions): ReviewQueue {
  const now = options.now ?? Date.now
  const timeZone = options.timeZone ?? 'UTC'
  const maxJobs = options.maxJobs ?? DEFAULT_MAX_REVIEW_JOBS
  const maxBufferedChars = options.maxBufferedChars ?? DEFAULT_MAX_BUFFERED_CHARS
  const maxReviewsPerDay = options.maxReviewsPerDay ?? DEFAULT_MAX_REVIEWS_PER_DAY
  const onError = options.onError ?? (() => {})
  const today = (): string => dayKey(now(), timeZone)
  today() // неизвестный пояс падает здесь, при создании

  const ledger: SpendLedger = createSpendLedger({
    usdPerDay: options.usdPerDay,
    maxReviewsPerHour: options.maxReviewsPerHour ?? DEFAULT_MAX_REVIEWS_PER_HOUR,
    maxReviewsPerDay,
    timeZone,
    now,
    onError,
    ...(options.spendDir === undefined ? {} : { dir: options.spendDir }),
  })

  let queued: ReviewJob[] = []
  let deferred: ReviewJob[] = []
  const reviewing = new Set<ReviewJob>()
  let day = today()
  let summaryTaken = false
  let deferredReason: DeferredSummary['reason'] = 'budget'
  let reviewedTotal = 0
  let failedTotal = 0
  let droppedTotal = 0

  /** Новые сутки: отложенные возвращаются в начало очереди. */
  function rollOver(): void {
    const current = today()
    if (current === day) return
    day = current
    summaryTaken = false
    for (const job of deferred) job.state = 'queued'
    queued = [...deferred, ...queued]
    deferred = []
  }

  function bufferedChars(): number {
    let total = 0
    for (const job of queued) total += job.chars
    for (const job of deferred) total += job.chars
    return total
  }

  function release(job: ReviewJob, spentUsd: number): void {
    reviewing.delete(job)
    if (job.reservationId !== null) ledger.settle(job.reservationId, spentUsd)
    job.reservationId = null
  }

  return {
    enqueue(input) {
      rollOver()
      queued.push({
        ...input,
        state: 'queued',
        attempts: 0,
        notBefore: 0,
        findings: [],
        chars: charsOf(input.messages),
        reservationId: null,
      })
      let total = bufferedChars()
      while (queued.length + deferred.length > 1 && (queued.length + deferred.length > maxJobs || total > maxBufferedChars)) {
        const oldest = deferred.length > 0 ? deferred.shift() : queued.shift()
        if (!oldest) break
        droppedTotal += 1
        total -= oldest.chars
      }
    },
    next(estimateUsd) {
      rollOver()
      const ready = now()
      for (const job of [...queued]) {
        if (job.notBefore > ready) continue
        const reserved = ledger.reserve(estimateUsd(job))
        if (reserved.ok) {
          queued.splice(queued.indexOf(job), 1)
          job.state = 'reviewing'
          job.reservationId = reserved.id
          reviewing.add(job)
          return job
        }
        if (reserved.reason === 'hourly_limit') {
          // Упёрлись в часовой лимит чтений: все остальные упрутся так же, ждём, пока освободится место.
          for (const waiting of queued) waiting.notBefore = Math.max(waiting.notBefore, reserved.retryAt)
          return null
        }
        queued.splice(queued.indexOf(job), 1)
        if (deferred.length === 0) deferredReason = reserved.reason
        job.state = 'deferred_budget'
        deferred.push(job)
      }
      return null
    },
    finish(job, result) {
      release(job, result.spentUsd)
      reviewedTotal += 1
      job.state = 'reviewed'
      job.findings = result.findings ?? []
    },
    retryLater(job, result) {
      release(job, result.spentUsd)
      job.attempts += 1
      job.notBefore = result.at
      job.state = 'queued'
      queued.push(job)
    },
    abandon(job, result) {
      release(job, result.spentUsd)
      failedTotal += 1
      job.state = 'failed'
    },
    nextReadyAt() {
      rollOver()
      let earliest: number | null = null
      for (const job of queued) earliest = earliest === null ? job.notBefore : Math.min(earliest, job.notBefore)
      return earliest
    },
    summaryPending() {
      rollOver()
      return !summaryTaken && deferred.length > 0
    },
    takeDeferredSummary() {
      rollOver()
      if (summaryTaken || deferred.length === 0) return null
      summaryTaken = true
      return {
        day,
        deferred: deferred.length,
        usdPerDay: options.usdPerDay,
        spentUsd: ledger.spentToday(),
        reason: deferredReason,
        maxReviewsPerDay,
      }
    },
    stats() {
      rollOver()
      return {
        day,
        usdPerDay: options.usdPerDay,
        spentUsd: ledger.spentToday(),
        queued: queued.length,
        reviewing: reviewing.size,
        deferred: deferred.length,
        reviewed: reviewedTotal,
        failed: failedTotal,
        dropped: droppedTotal,
        bufferedChars: bufferedChars(),
        readsToday: ledger.readsToday(),
      }
    },
  }
}
