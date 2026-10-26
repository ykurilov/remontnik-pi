import { appendFileSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import type { IncidentEvent } from '@ykurilov/remontnik-core/incident'

// Очередь случаев сторожа: файл JSONL с дозаписью, свой на каждый процесс приложения.
// Строки: событие `{ event, state, attempts, nextAttemptAt, notify, repeats, lostBefore }`, подтверждение `{ ack }`,
// неудачная попытка `{ retry, attempts, nextAttemptAt }`, отправленная тревога `{ notified }`,
// склеенный повтор `{ repeats, count }`, вытеснение `{ drop }`, счётчик потерь `{ lost }`.
// Запись синхронная: событие на диске раньше, чем процесс успеет упасть.
// Файл держит замок `outbox-<имя>.lock` (`pid:метка`); второй живой экземпляр пишет в свой файл.

/** Паузы между попытками доставки врачу; дальше — последняя пауза. */
export const OUTBOX_RETRY_DELAYS_MS = Object.freeze([5_000, 30_000, 120_000, 600_000]) as readonly [number, number, number, number]
export const OUTBOX_BATCH_LIMIT = 50
/** Потолок записей в очереди: дальше повторы склеиваются, новые вытесняют самые старые. */
export const OUTBOX_MAX_ENTRIES = 1000
const COMPACT_MIN_LINES = 1000

export interface OutboxEntry {
  event: IncidentEvent
  /** `delivered` — врач принял, но тревога в Telegram ещё не ушла. */
  state: 'pending' | 'delivered'
  attempts: number
  nextAttemptAt: number
  /** Тревога в Telegram положена и ещё не ушла. */
  notify: boolean
  /** Сколько таких же сбоев склеено в эту запись, когда очередь была полна. */
  repeats: number
  /** Сколько записей вытеснено, чтобы освободить место этой. */
  lostBefore: number
}

export interface OutboxStats {
  pending: number
  /** Записей в памяти и файле: ждущие доставки и ждущие тревоги. */
  stored: number
  awaitingNotification: number
  /** Неудачных попыток доставки с открытия очереди. */
  failedAttempts: number
  /** Вытеснено записей из-за потолка за всё время файла. */
  lost: number
  oldestPendingAt: string | null
  nextAttemptAt: number | null
}

export interface Outbox {
  readonly file: string
  append(event: IncidentEvent, options: { notify: boolean }): void
  ack(eventIds: readonly string[]): void
  recordFailure(eventIds: readonly string[], now: number): void
  markNotified(eventId: string): void
  /** Ожидающие доставки события, чья попытка подошла, по порядку записи. До ack или recordFailure они «в пути». */
  due(now: number, limit?: number): OutboxEntry[]
  /** События с неотправленной тревогой: например, падение, записанное прошлым процессом. */
  awaitingNotification(): OutboxEntry[]
  pending(): OutboxEntry[]
  nextAttemptAt(): number | null
  stats(): OutboxStats
  /** Отпускает замок файла. Повторный вызов безопасен. */
  close(): void
}

export interface OpenOutboxOptions {
  dir: string
  processName: string
  now?: () => number
  maxEntries?: number
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
  | { repeats: string; count: number }
  | { drop: string }
  | { lost: number }

function parseLine(text: string): OutboxLine | null {
  try {
    const value = JSON.parse(text) as Record<string, unknown> | null
    if (value === null || typeof value !== 'object') return null
    if (value.event && typeof (value.event as IncidentEvent).eventId === 'string') return value as OutboxLine
    for (const key of ['ack', 'retry', 'notified', 'repeats', 'drop']) {
      if (typeof value[key] === 'string') return value as OutboxLine
    }
    if (typeof value.lost === 'number') return value as OutboxLine
    return null
  } catch {
    return null
  }
}

function readText(file: string): string {
  try {
    return readFileSync(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''
    throw error
  }
}

/** Проигрывает строки файла в записи; возвращает счётчик потерь из файла. */
function replay(text: string, entries: Map<string, OutboxEntry>): number {
  let lost = 0
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
        repeats: line.repeats ?? 0,
        lostBefore: line.lostBefore ?? 0,
      })
    } else if ('ack' in line) {
      const entry = entries.get(line.ack)
      if (entry?.notify) entry.state = 'delivered'
      else entries.delete(line.ack)
    } else if ('retry' in line) {
      const entry = entries.get(line.retry)
      if (entry) Object.assign(entry, { attempts: line.attempts, nextAttemptAt: line.nextAttemptAt })
    } else if ('notified' in line) {
      const entry = entries.get(line.notified)
      if (entry?.state === 'delivered') entries.delete(line.notified)
      else if (entry) entry.notify = false
    } else if ('repeats' in line) {
      const entry = entries.get(line.repeats)
      if (entry) entry.repeats = line.count
    } else if ('drop' in line) {
      entries.delete(line.drop)
    } else {
      lost = line.lost
    }
  }
  return lost
}

/** Жив ли процесс с этим номером. EPERM — жив, но чужой. */
function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** Держит ли замок живой хозяин. Нет замка или хозяин мёртв — свободно. */
function lockHeld(lockFile: string): boolean {
  const content = readText(lockFile)
  if (content === '') return false
  return processAlive(Number(content.split(':')[0]))
}

/** Берёт замок; `false` — его держит живой экземпляр. */
function acquireLock(lockFile: string, content: string): boolean {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      writeFileSync(lockFile, content, { flag: 'wx' })
      return true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      if (lockHeld(lockFile)) return false
      try {
        unlinkSync(lockFile)
      } catch {
        // Другой процесс успел первым.
      }
    }
  }
  return false
}

function removeQuietly(file: string): void {
  try {
    unlinkSync(file)
  } catch {
    // Уже нет.
  }
}

/** Открывает очередь процесса: берёт замок, читает файл, подбирает сирот и сжимает файл. */
export function openOutbox(options: OpenOutboxOptions): Outbox {
  const now = options.now ?? Date.now
  const maxEntries = Math.max(1, options.maxEntries ?? OUTBOX_MAX_ENTRIES)
  const base = `outbox-${safeFileName(options.processName)}`
  const token = randomBytes(6).toString('hex')

  mkdirSync(options.dir, { recursive: true })
  let lockFile = join(options.dir, `${base}.lock`)
  let file = join(options.dir, `${base}.jsonl`)
  const owner = acquireLock(lockFile, `${process.pid}:${token}`)
  if (!owner) {
    const own = `${base}.${process.pid}-${token}`
    lockFile = join(options.dir, `${own}.lock`)
    file = join(options.dir, `${own}.jsonl`)
    writeFileSync(lockFile, `${process.pid}:${token}`)
    console.error(
      `[remontnik] очередь «${options.processName}» уже открыта другим живым экземпляром; пишу в ${own}.jsonl. ` +
        'Дайте экземплярам разные processName.',
    )
  }

  const entries = new Map<string, OutboxEntry>()
  /** Отпечаток → последняя ждущая доставки запись: в неё склеиваются повторы при полной очереди. */
  const latestByFingerprint = new Map<string, string>()
  /** Записи, отданные на доставку и ещё не подтверждённые: их не склеиваем и не вытесняем. */
  const inFlight = new Set<string>()
  let failedAttempts = 0
  let linesWritten = 0
  let closed = false

  let lost = replay(readText(file), entries)

  // Хозяин основного файла подбирает файлы умерших экземпляров.
  if (owner) {
    for (const name of readdirSync(options.dir)) {
      if (!name.startsWith(`${base}.`) || !name.endsWith('.jsonl')) continue
      const orphanFile = join(options.dir, name)
      const orphanLock = orphanFile.replace(/\.jsonl$/, '.lock')
      if (lockHeld(orphanLock)) continue
      const adopted = new Map<string, OutboxEntry>()
      lost += replay(readText(orphanFile), adopted)
      for (const [eventId, entry] of adopted) if (!entries.has(eventId)) entries.set(eventId, entry)
      removeQuietly(orphanFile)
      removeQuietly(orphanLock)
    }
  }

  const forget = (eventId: string) => {
    const entry = entries.get(eventId)
    entries.delete(eventId)
    inFlight.delete(eventId)
    if (entry && latestByFingerprint.get(entry.event.fingerprint) === eventId) latestByFingerprint.delete(entry.event.fingerprint)
  }

  const writeText = (text: string, lines: number) => {
    try {
      appendFileSync(file, text)
    } catch (error) {
      // Папку удалили на ходу: создаём заново и пробуем ещё раз.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      mkdirSync(options.dir, { recursive: true })
      appendFileSync(file, text)
    }
    linesWritten += lines
    if (linesWritten > Math.max(COMPACT_MIN_LINES, entries.size * 2)) compact()
  }
  const write = (line: OutboxLine) => writeText(`${JSON.stringify(line)}\n`, 1)

  function compact() {
    const parts: string[] = []
    for (const entry of entries.values()) parts.push(`${JSON.stringify(entry)}\n`)
    if (lost > 0) parts.push(`${JSON.stringify({ lost })}\n`)
    const temporary = `${file}.${token}.tmp`
    writeFileSync(temporary, parts.join(''))
    renameSync(temporary, file)
    linesWritten = parts.length
  }

  compact()
  for (const [eventId, entry] of entries) if (entry.state === 'pending') latestByFingerprint.set(entry.event.fingerprint, eventId)

  const pendingEntries = () => {
    const pending: OutboxEntry[] = []
    for (const entry of entries.values()) if (entry.state === 'pending') pending.push(entry)
    return pending
  }

  const earliestAttempt = (): number | null => {
    let earliest: number | null = null
    for (const entry of entries.values()) {
      if (entry.state === 'pending' && (earliest === null || entry.nextAttemptAt < earliest)) earliest = entry.nextAttemptAt
    }
    return earliest
  }

  /** Полная очередь: склеить с таким же сбоем, иначе освободить место за счёт самых старых. */
  function makeRoom(event: IncidentEvent): { collapsedInto: OutboxEntry } | { evicted: string[] } {
    const sameId = latestByFingerprint.get(event.fingerprint)
    const same = sameId === undefined ? undefined : entries.get(sameId)
    if (same && same.state === 'pending' && !inFlight.has(sameId!)) return { collapsedInto: same }
    const dropped: string[] = []
    for (const eventId of entries.keys()) {
      if (entries.size - dropped.length < maxEntries) break
      if (!inFlight.has(eventId)) dropped.push(eventId)
    }
    for (const eventId of dropped) forget(eventId)
    return { evicted: dropped }
  }

  return {
    file,
    append(event, { notify }) {
      let lostBefore = 0
      if (entries.size >= maxEntries) {
        const room = makeRoom(event)
        if ('collapsedInto' in room) {
          const target = room.collapsedInto
          target.repeats += 1
          // Тревога о склеенном повторе не нужна: о первом владелец узнал или узнает.
          write({ repeats: target.event.eventId, count: target.repeats })
          return
        }
        lostBefore = room.evicted.length
        if (lostBefore > 0) {
          lost += lostBefore
          const lines = room.evicted.map((eventId) => `${JSON.stringify({ drop: eventId })}\n`)
          writeText(`${lines.join('')}${JSON.stringify({ lost })}\n`, lines.length + 1)
        }
      }
      const entry: OutboxEntry = { event, state: 'pending', attempts: 0, nextAttemptAt: 0, notify, repeats: 0, lostBefore }
      entries.set(event.eventId, entry)
      latestByFingerprint.set(event.fingerprint, event.eventId)
      write(entry)
    },
    ack(eventIds) {
      const lines: string[] = []
      for (const eventId of eventIds) {
        inFlight.delete(eventId)
        const entry = entries.get(eventId)
        if (entry?.state !== 'pending') continue
        lines.push(`${JSON.stringify({ ack: eventId, at: now() })}\n`)
        if (entry.notify) {
          entry.state = 'delivered'
          if (latestByFingerprint.get(entry.event.fingerprint) === eventId) latestByFingerprint.delete(entry.event.fingerprint)
        } else {
          forget(eventId)
        }
      }
      if (lines.length > 0) writeText(lines.join(''), lines.length)
    },
    recordFailure(eventIds, at) {
      const lines: string[] = []
      for (const eventId of eventIds) {
        inFlight.delete(eventId)
        const entry = entries.get(eventId)
        if (!entry || entry.state !== 'pending') continue
        entry.attempts += 1
        entry.nextAttemptAt = at + retryDelayMs(entry.attempts)
        lines.push(`${JSON.stringify({ retry: eventId, attempts: entry.attempts, nextAttemptAt: entry.nextAttemptAt })}\n`)
      }
      if (lines.length === 0) return
      failedAttempts += 1
      writeText(lines.join(''), lines.length)
    },
    markNotified(eventId) {
      const entry = entries.get(eventId)
      if (!entry?.notify) return
      entry.notify = false
      if (entry.state === 'delivered') forget(eventId)
      write({ notified: eventId })
    },
    due(at, limit = OUTBOX_BATCH_LIMIT) {
      const due: OutboxEntry[] = []
      for (const [eventId, entry] of entries) {
        if (due.length >= limit) break
        if (entry.state !== 'pending' || entry.nextAttemptAt > at) continue
        inFlight.add(eventId)
        due.push(entry)
      }
      return due
    },
    awaitingNotification() {
      const awaiting: OutboxEntry[] = []
      for (const entry of entries.values()) if (entry.notify) awaiting.push(entry)
      return awaiting
    },
    pending: pendingEntries,
    nextAttemptAt: earliestAttempt,
    stats() {
      let pending = 0
      let awaitingNotification = 0
      let oldestPendingAt: string | null = null
      for (const entry of entries.values()) {
        if (entry.notify) awaitingNotification += 1
        if (entry.state !== 'pending') continue
        pending += 1
        oldestPendingAt ??= entry.event.occurredAt
      }
      return {
        pending,
        stored: entries.size,
        awaitingNotification,
        failedAttempts,
        lost,
        oldestPendingAt,
        nextAttemptAt: earliestAttempt(),
      }
    },
    close() {
      if (closed) return
      closed = true
      if (readText(lockFile) === `${process.pid}:${token}`) removeQuietly(lockFile)
    },
  }
}
