import type { IncidentEvent } from '@ykurilov/remontnik-core/incident'
import type { RecordStore, RecordTransaction } from '../records/index.js'

// Почасовой учёт ошибок приложения: уровень до выкатки и что появилось после неё (наблюдение, research R9).
// Час — один документ: поминутные счётчики и отпечатки с последним появлением.

export const ERROR_HOUR_COLLECTION = 'error-hour'
/** Больше отпечатков за час не помним: остальные идут в общий счёт. Столько новых и так даёт откат. */
const FINGERPRINTS_PER_HOUR_LIMIT = 200
const HOUR_MS = 3_600_000
const MINUTE_MS = 60_000
const KNOWN_FINGERPRINTS_DAYS = 7

interface ErrorHour {
  /** Минута часа (0–59) → появлений. */
  minutes: Record<string, number>
  fingerprints: Record<string, { count: number; lastAt: string }>
  /** Появления отпечатков сверх предела. */
  overflow: number
}

export interface ErrorBaseline {
  errorsPerHour: number
  knownFingerprints7d: string[]
}

export interface ErrorsSince {
  errors: number
  errorsPerHour: number
  /** Отпечатки, которых не было за неделю до выкатки, кроме отпечатка самого случая. */
  newFingerprints: string[]
  /** Сбой случая повторился после выкатки. */
  caseFingerprintSeen: boolean
}

const emptyHour = (): ErrorHour => ({ minutes: {}, fingerprints: {}, overflow: 0 })
const hourKey = (appName: string, hourStart: number) => `${appName}/${new Date(hourStart).toISOString().slice(0, 13)}`
const floorTo = (time: number, step: number) => Math.floor(time / step) * step

/** Внутри транзакции книги случаев: одно новое событие (`occurrences` — с учётом склеенных повторов). */
export async function countErrorIn(tx: RecordTransaction, event: IncidentEvent, occurrences: number): Promise<void> {
  const at = Date.parse(event.occurredAt)
  const hour = await tx.doc<ErrorHour>(ERROR_HOUR_COLLECTION, hourKey(event.appName, floorTo(at, HOUR_MS)), emptyHour())
  const minute = String(new Date(at).getUTCMinutes())
  hour.minutes[minute] = (hour.minutes[minute] ?? 0) + occurrences
  const seen = hour.fingerprints[event.fingerprint]
  if (seen) {
    seen.count += occurrences
    if (at > Date.parse(seen.lastAt)) seen.lastAt = event.occurredAt
  } else if (Object.keys(hour.fingerprints).length < FINGERPRINTS_PER_HOUR_LIMIT) {
    hour.fingerprints[event.fingerprint] = { count: occurrences, lastAt: event.occurredAt }
  } else {
    hour.overflow += occurrences
  }
}

async function readHours(store: RecordStore, appName: string, from: number, to: number): Promise<Array<{ start: number; hour: ErrorHour }>> {
  const hours: Array<{ start: number; hour: ErrorHour }> = []
  for (let start = floorTo(from, HOUR_MS); start <= to; start += HOUR_MS) {
    const hour = await store.read<ErrorHour>(ERROR_HOUR_COLLECTION, hourKey(appName, start))
    if (hour) hours.push({ start, hour })
  }
  return hours
}

function errorsBetween(hours: Array<{ start: number; hour: ErrorHour }>, from: number, to = Infinity): number {
  let errors = 0
  for (const { start, hour } of hours) {
    for (const [minute, count] of Object.entries(hour.minutes)) {
      const at = start + Number(minute) * MINUTE_MS
      if (at >= from && at < to) errors += count
    }
  }
  return errors
}

/** Уровень ошибок перед выкаткой: больший из прошлого часа и среднего за сутки; отпечатки за неделю. */
export async function readErrorBaseline(store: RecordStore, appName: string, at: Date): Promise<ErrorBaseline> {
  const now = floorTo(at.getTime(), MINUTE_MS)
  const week = await readHours(store, appName, now - KNOWN_FINGERPRINTS_DAYS * 24 * HOUR_MS, now)
  const lastHour = errorsBetween(week, now - HOUR_MS, now)
  const lastDay = errorsBetween(week, now - 24 * HOUR_MS, now)
  const known = new Set<string>()
  for (const { hour } of week) for (const fingerprint of Object.keys(hour.fingerprints)) known.add(fingerprint)
  return { errorsPerHour: Math.max(lastHour, lastDay / 24), knownFingerprints7d: [...known] }
}

/** Что случилось с начала выкатки `from` до `to`. Время делится не меньше чем на минуту: одна ошибка в первые секунды — не всплеск. */
export async function readErrorsSince(
  store: RecordStore,
  appName: string,
  window: { from: Date; to: Date; knownFingerprints: readonly string[]; caseFingerprint: string },
): Promise<ErrorsSince> {
  const from = floorTo(window.from.getTime(), MINUTE_MS)
  const to = window.to.getTime()
  const hours = await readHours(store, appName, from, to)
  const errors = errorsBetween(hours, from)
  const known = new Set(window.knownFingerprints)
  const fresh = new Set<string>()
  let caseFingerprintSeen = false
  for (const { hour } of hours) {
    for (const [fingerprint, seen] of Object.entries(hour.fingerprints)) {
      if (Date.parse(seen.lastAt) < window.from.getTime()) continue
      if (fingerprint === window.caseFingerprint) caseFingerprintSeen = true
      else if (!known.has(fingerprint)) fresh.add(fingerprint)
    }
  }
  const elapsedHours = Math.max(to - from, MINUTE_MS) / HOUR_MS
  return { errors, errorsPerHour: errors / elapsedHours, newFingerprints: [...fresh], caseFingerprintSeen }
}
