import type { IncidentEvent } from '@ykurilov/remontnik-core/incident'
import type { RecordStore, RecordTransaction } from '../records/index.js'

// Почасовой учёт ошибок приложения: уровень до выкатки и что появилось после неё (наблюдение, research R9).
// Час — один документ: поминутные счётчики и отпечатки с последним появлением. Нужна только последняя неделя,
// поэтому часы старше 8 дней от самого нового удаляются, когда начинается новый час. Самый новый час — не позже
// часа записи: событие с неверными часами «из будущего» не должно удалить настоящие часы.

export const ERROR_HOUR_COLLECTION = 'error-hour'
export const ERROR_HOUR_INDEX_COLLECTION = 'error-hour-index'
const KEEP_HOURS_DAYS = 8
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

/** Записанные часы приложения: `YYYY-MM-DDTHH`. */
interface ErrorHourIndex {
  hours: string[]
  /** Часы, записанные до появления списка, уже найдены и внесены в него. */
  seeded?: boolean
}

/** Насколько назад искать часы, записанные до появления списка. */
const SEED_SEARCH_DAYS = 60

const emptyHour = (): ErrorHour => ({ minutes: {}, fingerprints: {}, overflow: 0 })
const hourStamp = (hourStart: number) => new Date(hourStart).toISOString().slice(0, 13)
const hourStartOf = (stamp: string) => Date.parse(`${stamp}:00:00Z`)
const hourKey = (appName: string, hourStart: number) => `${appName}/${hourStamp(hourStart)}`
const floorTo = (time: number, step: number) => Math.floor(time / step) * step

/**
 * Внутри транзакции книги случаев: одно новое событие (`occurrences` — с учётом склеенных повторов), `recordedAt` —
 * время записи.
 */
export async function countErrorIn(tx: RecordTransaction, event: IncidentEvent, occurrences: number, recordedAt: Date): Promise<void> {
  const at = Date.parse(event.occurredAt)
  const start = floorTo(at, HOUR_MS)
  const index = await tx.doc<ErrorHourIndex>(ERROR_HOUR_INDEX_COLLECTION, event.appName, { hours: [] })
  if (!index.hours.includes(hourStamp(start))) {
    const newest = Math.min(Math.max(start, ...index.hours.map(hourStartOf)), floorTo(recordedAt.getTime(), HOUR_MS))
    const keepFrom = newest - KEEP_HOURS_DAYS * 24 * HOUR_MS
    // Событие старше срока хранения (запоздало) — уже не нужно ни уровню, ни наблюдению.
    if (start < keepFrom) return
    const old = index.hours.filter((stamp) => hourStartOf(stamp) < keepFrom)
    for (const stamp of old) await tx.retire(ERROR_HOUR_COLLECTION, `${event.appName}/${stamp}`)
    index.hours = [...index.hours.filter((stamp) => !old.includes(stamp)), hourStamp(start)]
  }
  const hour = await tx.doc<ErrorHour>(ERROR_HOUR_COLLECTION, hourKey(event.appName, start), emptyHour())
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

/**
 * Один раз на приложение: часы, записанные до появления списка, внести в него, а старше срока хранения — удалить.
 * Иначе их не удалит никто: удаление идёт только по списку. Искать приходится перебором часов (списка документов
 * у хранилища нет), поэтому проход однократный: после него в списке пометка `seeded`. `at` — время записи.
 */
export async function seedErrorHourIndex(store: RecordStore, appName: string, at: Date): Promise<void> {
  if ((await store.read<ErrorHourIndex>(ERROR_HOUR_INDEX_COLLECTION, appName))?.seeded) return
  const latest = floorTo(at.getTime(), HOUR_MS)
  const found: string[] = []
  for (let start = latest - SEED_SEARCH_DAYS * 24 * HOUR_MS; start <= latest; start += HOUR_MS) {
    if (await store.read(ERROR_HOUR_COLLECTION, hourKey(appName, start))) found.push(hourStamp(start))
  }
  await store.transaction(async (tx) => {
    const index = await tx.doc<ErrorHourIndex>(ERROR_HOUR_INDEX_COLLECTION, appName, { hours: [] })
    if (index.seeded) return
    const hours = [...new Set([...index.hours, ...found])]
    const keepFrom = Math.max(latest, ...hours.map(hourStartOf)) - KEEP_HOURS_DAYS * 24 * HOUR_MS
    const old = hours.filter((stamp) => hourStartOf(stamp) < keepFrom)
    for (const stamp of old) await tx.retire(ERROR_HOUR_COLLECTION, `${appName}/${stamp}`)
    index.hours = hours.filter((stamp) => !old.includes(stamp)).sort()
    index.seeded = true
  })
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

/**
 * Что случилось с начала выкатки `from` до `to`. Время делится не меньше чем на минуту: одна ошибка в первые секунды —
 * не всплеск. Новые отпечатки и повтор сбоя случая — с `caseFrom`, если он позже `from`: до него мог работать прежний
 * код, и его побочный сбой — не сбой новой версии.
 */
export async function readErrorsSince(
  store: RecordStore,
  appName: string,
  window: { from: Date; to: Date; knownFingerprints: readonly string[]; caseFingerprint: string; caseFrom?: Date },
): Promise<ErrorsSince> {
  const from = floorTo(window.from.getTime(), MINUTE_MS)
  const caseFrom = Math.max(window.from.getTime(), window.caseFrom?.getTime() ?? 0)
  const to = window.to.getTime()
  const hours = await readHours(store, appName, from, to)
  const errors = errorsBetween(hours, from)
  const known = new Set(window.knownFingerprints)
  const fresh = new Set<string>()
  let caseFingerprintSeen = false
  for (const { hour } of hours) {
    for (const [fingerprint, seen] of Object.entries(hour.fingerprints)) {
      const lastAt = Date.parse(seen.lastAt)
      if (fingerprint === window.caseFingerprint) caseFingerprintSeen ||= lastAt >= caseFrom
      else if (lastAt >= caseFrom && !known.has(fingerprint)) fresh.add(fingerprint)
    }
  }
  const elapsedHours = Math.max(to - from, MINUTE_MS) / HOUR_MS
  return { errors, errorsPerHour: errors / elapsedHours, newFingerprints: [...fresh], caseFingerprintSeen }
}
