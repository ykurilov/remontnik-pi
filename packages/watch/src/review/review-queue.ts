import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import type { ConversationMessage, ReviewFinding } from './rubric.js'

// Очередь чтения законченных разговоров с суточным бюджетом.
// Разговоры читаются по одному. Если оценка стоимости следующего не влезает в остаток бюджета на сутки,
// разговор получает состояние `deferred_budget` и ждёт новых суток; бюджет не превышается никогда.
// Сутки считаются по поясу из настройки. Расход за сутки хранится в маленьком файле и переживает перезапуск.

export type ReviewJobState = 'queued' | 'reviewing' | 'reviewed' | 'deferred_budget' | 'failed'

export interface ReviewJobInput {
  conversationId: string
  /** Когда разговор закончился, мс. */
  finishedAt: number
  messages: ConversationMessage[]
  meta: Record<string, unknown>
}

export interface ReviewJob extends ReviewJobInput {
  state: ReviewJobState
  /** Сколько попыток чтения уже было неудачными. */
  attempts: number
  /** Не раньше какого времени пробовать снова, мс. */
  notBefore: number
  findings: ReviewFinding[]
}

export interface DeferredSummary {
  day: string
  deferred: number
  usdPerDay: number
  spentUsd: number
}

export interface ReviewQueueStats {
  day: string
  usdPerDay: number
  spentUsd: number
  queued: number
  reviewing: number
  /** Сейчас ждут новых суток из-за бюджета. */
  deferred: number
  /** Прочитано за всё время работы очереди. */
  reviewed: number
  /** Брошено после неудачных попыток. */
  failed: number
  /** Вытеснено потолком очереди. */
  dropped: number
}

export interface ReviewQueueOptions {
  usdPerDay: number
  /** Пояс (IANA) для границы суток; по умолчанию UTC. Неизвестный пояс — ошибка. */
  timeZone?: string
  now?: () => number
  /** Файл расхода за сутки. Без него расход живёт только в памяти. */
  stateFile?: string
  /** Потолок ожидающих разговоров; дальше вытесняется самый старый. */
  maxJobs?: number
  onError?: (what: string, error?: unknown) => void
}

export interface ReviewQueue {
  /** Ставит разговор в очередь; ничего не читает и не ждёт. */
  enqueue(input: ReviewJobInput): void
  /**
   * Следующий разговор для чтения или `null`. Разговоры, чья оценка стоимости не влезает в остаток бюджета,
   * откладываются до новых суток.
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
const BUDGET_TOLERANCE_USD = 1e-9

const formatters = new Map<string, Intl.DateTimeFormat>()

/** Календарный день `ГГГГ-ММ-ДД` в заданном поясе. */
export function dayKey(ms: number, timeZone: string): string {
  let formatter = formatters.get(timeZone)
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
    formatters.set(timeZone, formatter)
  }
  return formatter.format(new Date(ms))
}

interface SpendRecord {
  day: string
  usd: number
  reviews: number
  deferred: number
}

export function createReviewQueue(options: ReviewQueueOptions): ReviewQueue {
  const now = options.now ?? Date.now
  const timeZone = options.timeZone ?? 'UTC'
  const maxJobs = options.maxJobs ?? DEFAULT_MAX_REVIEW_JOBS
  const onError = options.onError ?? (() => {})
  const today = (): string => dayKey(now(), timeZone)
  today() // неизвестный пояс падает здесь, при создании

  let queued: ReviewJob[] = []
  let deferred: ReviewJob[] = []
  const reviewing = new Set<ReviewJob>()
  let day = today()
  let spentUsd = 0
  let reviewsToday = 0
  let summaryTaken = false
  let reviewedTotal = 0
  let failedTotal = 0
  let droppedTotal = 0

  function persist(): void {
    if (!options.stateFile) return
    const record: SpendRecord = { day, usd: spentUsd, reviews: reviewsToday, deferred: deferred.length }
    try {
      const temporary = `${options.stateFile}.tmp`
      writeFileSync(temporary, JSON.stringify(record))
      renameSync(temporary, options.stateFile)
    } catch (error) {
      onError('расход чтения разговоров не записан', error)
    }
  }

  function restore(): void {
    if (!options.stateFile) return
    let text: string
    try {
      text = readFileSync(options.stateFile, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') onError('расход чтения разговоров не прочитан', error)
      return
    }
    try {
      const record = JSON.parse(text) as Partial<SpendRecord> | null
      if (record === null || typeof record !== 'object' || typeof record.day !== 'string' || typeof record.usd !== 'number' || !(record.usd >= 0)) {
        throw new Error('неверная запись расхода')
      }
      if (record.day === day) {
        spentUsd = record.usd
        reviewsToday = typeof record.reviews === 'number' ? record.reviews : 0
      }
    } catch (error) {
      onError('файл расхода чтения разговоров испорчен, считаю с нуля', error)
    }
  }

  /** Новые сутки: расход с нуля, отложенные возвращаются в начало очереди. */
  function rollOver(): void {
    const current = today()
    if (current === day) return
    day = current
    spentUsd = 0
    reviewsToday = 0
    summaryTaken = false
    for (const job of deferred) job.state = 'queued'
    queued = [...deferred, ...queued]
    deferred = []
    persist()
  }

  restore()

  return {
    enqueue(input) {
      rollOver()
      queued.push({ ...input, state: 'queued', attempts: 0, notBefore: 0, findings: [] })
      while (queued.length + deferred.length > maxJobs) {
        const oldest = deferred.length > 0 ? deferred.shift() : queued.shift()
        if (oldest) droppedTotal += 1
      }
    },
    next(estimateUsd) {
      rollOver()
      const ready = now()
      for (const job of [...queued]) {
        if (job.notBefore > ready) continue
        queued.splice(queued.indexOf(job), 1)
        if (spentUsd + estimateUsd(job) > options.usdPerDay + BUDGET_TOLERANCE_USD) {
          job.state = 'deferred_budget'
          deferred.push(job)
          continue
        }
        job.state = 'reviewing'
        reviewing.add(job)
        return job
      }
      return null
    },
    finish(job, result) {
      reviewing.delete(job)
      spentUsd += result.spentUsd
      reviewsToday += 1
      reviewedTotal += 1
      job.state = 'reviewed'
      job.findings = result.findings ?? []
      persist()
    },
    retryLater(job, result) {
      reviewing.delete(job)
      spentUsd += result.spentUsd
      job.attempts += 1
      job.notBefore = result.at
      job.state = 'queued'
      queued.push(job)
      persist()
    },
    abandon(job, result) {
      reviewing.delete(job)
      spentUsd += result.spentUsd
      failedTotal += 1
      job.state = 'failed'
      persist()
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
      return { day, deferred: deferred.length, usdPerDay: options.usdPerDay, spentUsd }
    },
    stats() {
      rollOver()
      return {
        day,
        usdPerDay: options.usdPerDay,
        spentUsd,
        queued: queued.length,
        reviewing: reviewing.size,
        deferred: deferred.length,
        reviewed: reviewedTotal,
        failed: failedTotal,
        dropped: droppedTotal,
      }
    },
  }
}
