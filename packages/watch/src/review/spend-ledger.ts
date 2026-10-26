import { randomBytes } from 'node:crypto'
import { appendFileSync, mkdirSync, readFileSync, readdirSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { dayKey } from './day.js'

// Общий учёт расхода и числа чтений на приложение. Все процессы приложения (веб, фоновый работник) пишут в одни
// и те же файлы, по файлу на сутки. Файл — журнал дозаписи: каждая строка добавляется одним вызовом `O_APPEND`,
// поэтому процессы не затирают друг друга и не нужен замок. Расход — свёртка журнала.
//
// Запись идёт ДО запроса к модели (резерв по оценке) и заменяется настоящим расходом после ответа. Если процесс
// упал посреди запроса, резерв остаётся в расходе по оценке, и бюджет не теряется.
// Порядок строк в файле задаёт порядок резервов: после дозаписи своего резерва процесс проверяет бюджет по строкам
// до своей включительно; кто оказался сверх бюджета — отменяет резерв. Двое сразу не пройдут оба.

export interface SpendLedgerOptions {
  usdPerDay: number
  maxReviewsPerHour: number
  maxReviewsPerDay: number
  timeZone: string
  now: () => number
  /** Папка общего учёта приложения. Без неё учёт живёт только в памяти процесса. */
  dir?: string
  onError?: (what: string, error?: unknown) => void
}

export type ReserveResult =
  | { ok: true; id: string }
  | { ok: false; reason: 'budget' | 'daily_limit' }
  | { ok: false; reason: 'hourly_limit'; retryAt: number }

export interface SpendLedger {
  /** Занимает бюджет под оценку стоимости одного чтения. Не бросает. */
  reserve(estimateUsd: number): ReserveResult
  /** Заменяет резерв настоящим расходом. */
  settle(id: string, actualUsd: number): void
  spentToday(): number
  readsToday(): number
}

const HOUR_MS = 3_600_000
const BUDGET_TOLERANCE_USD = 1e-9
const FILE_PATTERN = /^review-spend-(\d{4}-\d{2}-\d{2})\.jsonl$/

type Line =
  | { t: 'reserve'; id: string; at: number; usd: number }
  | { t: 'settle'; id: string; usd: number }
  | { t: 'cancel'; id: string }

interface Entry {
  usd: number
  at: number
}

function parseLine(text: string): Line | null {
  try {
    const value = JSON.parse(text) as Partial<Line> | null
    if (value === null || typeof value !== 'object' || typeof value.id !== 'string') return null
    if (value.t === 'reserve' && typeof value.usd === 'number' && value.usd >= 0 && typeof value.at === 'number') {
      return { t: 'reserve', id: value.id, at: value.at, usd: value.usd }
    }
    if (value.t === 'settle' && typeof value.usd === 'number' && value.usd >= 0) return { t: 'settle', id: value.id, usd: value.usd }
    if (value.t === 'cancel') return { t: 'cancel', id: value.id }
    return null
  } catch {
    return null
  }
}

export function createSpendLedger(options: SpendLedgerOptions): SpendLedger {
  const onError = options.onError ?? (() => {})
  const memory = new Map<string, string[]>()
  const processTag = randomBytes(4).toString('hex')
  let counter = 0
  let corruptionReported = false
  let storageBroken = false
  let lastCleanedDay = ''

  const today = (): string => dayKey(options.now(), options.timeZone)

  function readLines(day: string): string[] {
    if (options.dir && !storageBroken) {
      try {
        return readFileSync(join(options.dir, `review-spend-${day}.jsonl`), 'utf8').split('\n').filter((line) => line !== '')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') fallBackToMemory('учёт расхода чтения разговоров не прочитан', error)
        else return []
      }
    }
    return memory.get(day) ?? []
  }

  function appendLine(day: string, line: Line): void {
    const text = JSON.stringify(line)
    if (options.dir && !storageBroken) {
      try {
        mkdirSync(options.dir, { recursive: true })
        appendFileSync(join(options.dir, `review-spend-${day}.jsonl`), `${text}\n`)
        return
      } catch (error) {
        fallBackToMemory('расход чтения разговоров не записан', error)
      }
    }
    const lines = memory.get(day) ?? []
    lines.push(text)
    memory.set(day, lines)
  }

  /** Диск не работает: сообщаем один раз и считаем дальше в памяти — приложение не падает и бюджет не отменяется. */
  function fallBackToMemory(what: string, error: unknown): void {
    if (!storageBroken) onError(what, error)
    storageBroken = true
  }

  function cleanOldFiles(day: string): void {
    if (!options.dir || storageBroken || lastCleanedDay === day) return
    lastCleanedDay = day
    try {
      const keep = new Set([day, dayKey(options.now() - 24 * HOUR_MS, options.timeZone)])
      for (const name of readdirSync(options.dir)) {
        const match = FILE_PATTERN.exec(name)
        if (match?.[1] && !keep.has(match[1])) unlinkSync(join(options.dir, name))
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') onError('старые файлы учёта чтения не убраны', error)
    }
  }

  /** Свёртка журнала до строки `upTo` включительно (по умолчанию — весь). */
  function fold(day: string, upTo?: string): Map<string, Entry> {
    const entries = new Map<string, Entry>()
    for (const text of readLines(day)) {
      const line = parseLine(text)
      if (!line) {
        if (!corruptionReported) {
          corruptionReported = true
          onError('в учёте расхода чтения разговоров есть испорченная строка, пропускаю')
        }
        continue
      }
      if (line.t === 'reserve') entries.set(line.id, { usd: line.usd, at: line.at })
      else if (line.t === 'settle') {
        const known = entries.get(line.id)
        if (known) known.usd = line.usd
      } else entries.delete(line.id)
      if (upTo !== undefined && line.t === 'reserve' && line.id === upTo) break
    }
    return entries
  }

  function totals(entries: Map<string, Entry>): number {
    let sum = 0
    for (const entry of entries.values()) sum += entry.usd
    return sum
  }

  function limitReached(entries: Map<string, Entry>, now: number): ReserveResult | null {
    if (entries.size >= options.maxReviewsPerDay) return { ok: false, reason: 'daily_limit' }
    const recent = [...entries.values()].filter((entry) => entry.at > now - HOUR_MS).map((entry) => entry.at)
    if (recent.length >= options.maxReviewsPerHour) {
      const oldest = Math.min(...recent)
      return { ok: false, reason: 'hourly_limit', retryAt: oldest + HOUR_MS }
    }
    return null
  }

  return {
    reserve(estimateUsd) {
      try {
        const now = options.now()
        const day = today()
        cleanOldFiles(day)
        const before = fold(day)
        const blocked = limitReached(before, now)
        if (blocked) return blocked
        if (totals(before) + estimateUsd > options.usdPerDay + BUDGET_TOLERANCE_USD) return { ok: false, reason: 'budget' }

        const id = `${processTag}-${(counter += 1)}`
        appendLine(day, { t: 'reserve', id, at: now, usd: estimateUsd })
        // Проверка по порядку строк: если пока мы писали, чужие резервы встали раньше и бюджет или лимит кончились — отменяем свой.
        const upToMine = fold(day, id)
        const mine = upToMine.get(id)
        upToMine.delete(id)
        const overLimit = limitReached(upToMine, now)
        const overBudget = totals(upToMine) + (mine?.usd ?? estimateUsd) > options.usdPerDay + BUDGET_TOLERANCE_USD
        if (overLimit || overBudget) {
          appendLine(day, { t: 'cancel', id })
          return overLimit ?? { ok: false, reason: 'budget' }
        }
        return { ok: true, id }
      } catch (error) {
        onError('учёт расхода чтения разговоров сорвался', error)
        return { ok: false, reason: 'budget' }
      }
    },
    settle(id, actualUsd) {
      try {
        appendLine(today(), { t: 'settle', id, usd: Math.max(0, actualUsd) })
      } catch (error) {
        onError('расход чтения разговоров не записан', error)
      }
    },
    spentToday() {
      try {
        return totals(fold(today()))
      } catch (error) {
        onError('расход чтения разговоров не прочитан', error)
        return 0
      }
    },
    readsToday() {
      try {
        return fold(today()).size
      } catch {
        return 0
      }
    },
  }
}
