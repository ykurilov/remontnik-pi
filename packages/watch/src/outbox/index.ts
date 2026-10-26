import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { IncidentEvent } from '@ykurilov/remontnik-core/incident'

// Очередь случаев сторожа: файл JSONL с дозаписью, свой на каждый процесс приложения.
// Строки: событие `{ event, state, attempts, nextAttemptAt, notify }`, подтверждение `{ ack }`,
// неудачная попытка `{ retry, attempts, nextAttemptAt }`, отправленная тревога `{ notified }`.
// Запись синхронная: событие на диске раньше, чем процесс успеет упасть.

/** Паузы между попытками доставки врачу; дальше — последняя пауза. */
export const OUTBOX_RETRY_DELAYS_MS = Object.freeze([5_000, 30_000, 120_000, 600_000]) as readonly [number, number, number, number]
export const OUTBOX_BATCH_LIMIT = 50
const DELIVERED_KEPT_MS = 24 * 60 * 60 * 1000

export interface OutboxEntry {
  event: IncidentEvent
  state: 'pending' | 'delivered'
  attempts: number
  nextAttemptAt: number
  /** Тревога в Telegram положена и ещё не ушла. */
  notify: boolean
  deliveredAt?: number
}

export interface OutboxStats {
  pending: number
  delivered: number
  /** Неудачных попыток доставки с открытия очереди. */
  failedAttempts: number
  oldestPendingAt: string | null
  nextAttemptAt: number | null
}

export interface Outbox {
  readonly file: string
  append(event: IncidentEvent, options: { notify: boolean }): void
  ack(eventIds: readonly string[]): void
  recordFailure(eventIds: readonly string[], now: number): void
  markNotified(eventId: string): void
  /** Ожидающие доставки события, чья попытка подошла, по порядку записи. */
  due(now: number, limit?: number): OutboxEntry[]
  /** События с неотправленной тревогой: например, падение, записанное прошлым процессом. */
  awaitingNotification(): OutboxEntry[]
  pending(): OutboxEntry[]
  nextAttemptAt(): number | null
  stats(): OutboxStats
}

export interface OpenOutboxOptions {
  dir: string
  processName: string
  now?: () => number
}

export function retryDelayMs(attempts: number): number {
  return OUTBOX_RETRY_DELAYS_MS[Math.min(attempts, OUTBOX_RETRY_DELAYS_MS.length) - 1] ?? OUTBOX_RETRY_DELAYS_MS[0]
}

function safeFileName(processName: string): string {
  return processName.replace(/[^A-Za-z0-9_-]+/g, '_').slice(0, 64) || 'process'
}

type OutboxLine =
  | ({ event: IncidentEvent } & Partial<OutboxEntry>)
  | { ack: string; at?: number }
  | { retry: string; attempts: number; nextAttemptAt: number }
  | { notified: string }

function parseLine(text: string): OutboxLine | null {
  try {
    const value = JSON.parse(text) as Record<string, unknown> | null
    if (value === null || typeof value !== 'object') return null
    if (value.event && typeof (value.event as IncidentEvent).eventId === 'string') return value as OutboxLine
    if (typeof value.ack === 'string' || typeof value.retry === 'string' || typeof value.notified === 'string') return value as OutboxLine
    return null
  } catch {
    return null
  }
}

/** Открывает очередь процесса: читает файл, сжимает его и держит состояние в памяти. */
export function openOutbox(options: OpenOutboxOptions): Outbox {
  const now = options.now ?? Date.now
  const file = join(options.dir, `outbox-${safeFileName(options.processName)}.jsonl`)
  const entries = new Map<string, OutboxEntry>()
  let failedAttempts = 0

  mkdirSync(options.dir, { recursive: true })
  let text = ''
  try {
    text = readFileSync(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  for (const raw of text.split('\n')) {
    if (raw.trim() === '') continue
    const line = parseLine(raw)
    if (!line) continue
    if ('event' in line) {
      entries.set(line.event.eventId, {
        event: line.event,
        state: line.state === 'delivered' ? 'delivered' : 'pending',
        attempts: line.attempts ?? 0,
        nextAttemptAt: line.nextAttemptAt ?? 0,
        notify: line.notify === true,
        ...(line.deliveredAt === undefined ? {} : { deliveredAt: line.deliveredAt }),
      })
    } else if ('ack' in line) {
      const entry = entries.get(line.ack)
      if (entry) Object.assign(entry, { state: 'delivered', deliveredAt: line.at ?? now() })
    } else if ('retry' in line) {
      const entry = entries.get(line.retry)
      if (entry) Object.assign(entry, { attempts: line.attempts, nextAttemptAt: line.nextAttemptAt })
    } else {
      const entry = entries.get(line.notified)
      if (entry) entry.notify = false
    }
  }

  // Сжатие при старте: подтверждённые старше суток выбрасываются, остальное — по строке на событие.
  const keepAfter = now() - DELIVERED_KEPT_MS
  for (const [eventId, entry] of entries) {
    if (entry.state === 'delivered' && (entry.deliveredAt ?? 0) < keepAfter) entries.delete(eventId)
  }
  const compacted = [...entries.values()].map((entry) => `${JSON.stringify(entry)}\n`).join('')
  const temporary = `${file}.${process.pid}.tmp`
  writeFileSync(temporary, compacted)
  renameSync(temporary, file)

  const write = (line: OutboxLine) => appendFileSync(file, `${JSON.stringify(line)}\n`)
  const pendingEntries = () => [...entries.values()].filter((entry) => entry.state === 'pending')

  return {
    file,
    append(event, { notify }) {
      const entry: OutboxEntry = { event, state: 'pending', attempts: 0, nextAttemptAt: 0, notify }
      write(entry)
      entries.set(event.eventId, entry)
    },
    ack(eventIds) {
      const at = now()
      const lines = eventIds
        .filter((eventId) => entries.get(eventId)?.state === 'pending')
        .map((eventId) => `${JSON.stringify({ ack: eventId, at })}\n`)
      if (lines.length === 0) return
      appendFileSync(file, lines.join(''))
      for (const eventId of eventIds) {
        const entry = entries.get(eventId)
        if (entry) Object.assign(entry, { state: 'delivered', deliveredAt: at })
      }
    },
    recordFailure(eventIds, at) {
      const lines: string[] = []
      for (const eventId of eventIds) {
        const entry = entries.get(eventId)
        if (!entry || entry.state !== 'pending') continue
        entry.attempts += 1
        entry.nextAttemptAt = at + retryDelayMs(entry.attempts)
        lines.push(`${JSON.stringify({ retry: eventId, attempts: entry.attempts, nextAttemptAt: entry.nextAttemptAt })}\n`)
      }
      if (lines.length === 0) return
      failedAttempts += 1
      appendFileSync(file, lines.join(''))
    },
    markNotified(eventId) {
      const entry = entries.get(eventId)
      if (!entry?.notify) return
      write({ notified: eventId })
      entry.notify = false
    },
    due(at, limit = OUTBOX_BATCH_LIMIT) {
      return pendingEntries()
        .filter((entry) => entry.nextAttemptAt <= at)
        .slice(0, limit)
    },
    awaitingNotification() {
      return [...entries.values()].filter((entry) => entry.notify)
    },
    pending: pendingEntries,
    nextAttemptAt() {
      const pending = pendingEntries()
      return pending.length === 0 ? null : Math.min(...pending.map((entry) => entry.nextAttemptAt))
    },
    stats() {
      const pending = pendingEntries()
      return {
        pending: pending.length,
        delivered: entries.size - pending.length,
        failedAttempts,
        oldestPendingAt: pending[0]?.event.occurredAt ?? null,
        nextAttemptAt: pending.length === 0 ? null : Math.min(...pending.map((entry) => entry.nextAttemptAt)),
      }
    },
  }
}
