// Дневной расход врача (data-model: SpendLedger) — в записях, поэтому переживает перезапуск.
// Модель и eval считаются отдельно: у каждого свой дневной потолок (`modelUsdPerDay`, `evalUsdPerDay`).
// Сутки — по поясу приложения (`app.timeZone`). Дневные потолки — с запасом 10% (R1): последняя секунда потока
// может не попасть в учёт при падении, поэтому работа останавливается на 90% потолка.
// Модель записывается по ходу разговора приращениями; перед каждым запросом к модели — проверка (`modelBlock`).
// Eval — бронью до запуска и фактом после. Бронь — доля случая (`evalUsdPerCase`), не больше остатка дня, и остаток
// делится поровну с другими случаями, которые сейчас ждут eval (`eval-queue`); ставится прямо перед запуском eval.
// Факт даёт прокси модели: до отправки каждого запроса к поставщику он ждёт записи его брони, после ответа —
// записи факта. Ошибка проверки или перезапуск врача закрывают бронь eval записанным фактом плюс брони
// запросов, которые ещё шли; ничего не записано — eval к модели не ходил, бронь закрывается нулём.

import type { EvalSpend } from '../eval-proxy/index.js'
import type { RecordTransaction } from '../records/index.js'

export interface SpendDay {
  /** Расход модели по случаям за день. */
  model: Record<string, number>
  /** Брони eval по прогонам проверки. */
  eval: Record<string, EvalReservation>
}

export interface EvalReservation {
  reservedUsd: number
  /** Итог: бронь закрыта. */
  actualUsd?: number
  /** Расход по прокси, пока eval идёт. */
  observedUsd?: number
  /** Брони запросов к модели, которые ещё шли при последней записи. */
  inFlightUsd?: number
}

/** Сколько модель уже записала по случаю: приращение к дню — это разница с новым итогом разговора. */
export interface CaseSpend {
  recordedModelUsd: number
}

/** Случаи, которые дошли до проверки и могут попросить eval: номер случая → с какого момента ждёт. */
export interface EvalQueue {
  waiting: Record<string, number>
}

export type ModelBlock = 'budget' | 'day_budget'

export type EvalAdmission =
  | { kind: 'reserve'; usd: number }
  /** Денег нет, но чужой eval ещё идёт: его бронь вернёт неистраченное. */
  | { kind: 'wait' }
  /** Денег на сегодня нет: до следующих суток. */
  | { kind: 'next_day' }

/** Запас учёта (R1). */
export const SPEND_MARGIN = 0.1
/** Отметка ожидания eval старше этого — случай уже не ждёт (упал или снят), его не считаем. */
export const EVAL_WAITING_STALE_MS = 2 * 3_600_000
const USD_EPSILON = 1e-9
const DAY_SEARCH_MS = 26 * 3_600_000

export const emptySpendDay = (): SpendDay => ({ model: {}, eval: {} })
export const emptyEvalQueue = (): EvalQueue => ({ waiting: {} })

const formatters = new Map<string, Intl.DateTimeFormat>()

/** День по часовому поясу приложения: `YYYY-MM-DD`. */
export function spendDayKey(ms: number, timeZone: string): string {
  let formatter = formatters.get(timeZone)
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
    formatters.set(timeZone, formatter)
  }
  return formatter.format(new Date(ms))
}

/** Начало следующих суток в поясе приложения. Длина суток плавает при переводе часов, поэтому — поиском. */
export function nextDayStartMs(ms: number, timeZone: string): number {
  const today = spendDayKey(ms, timeZone)
  let sameDay = ms
  let nextDay = ms + DAY_SEARCH_MS
  while (nextDay - sameDay > 1) {
    const middle = Math.floor((sameDay + nextDay) / 2)
    if (spendDayKey(middle, timeZone) === today) sameDay = middle
    else nextDay = middle
  }
  return nextDay
}

/** Сколько из дневного потолка можно тратить: потолок за вычетом запаса. */
export function usableUsd(limitUsd: number): number {
  return limitUsd * (1 - SPEND_MARGIN)
}

export function modelSpentUsd(day: SpendDay | undefined): number {
  return Object.values(day?.model ?? {}).reduce((sum, usd) => sum + usd, 0)
}

/** Расход eval за день: факт, а где его нет (идёт или прервано сбоем) — вся бронь. */
export function evalSpentUsd(day: SpendDay | undefined): number {
  return Object.values(day?.eval ?? {}).reduce((sum, item) => sum + (item.actualUsd ?? item.reservedUsd), 0)
}

/** Расход модели за день вместе с тем, что разговор случая уже потратил, но в день ещё не записано. */
export function modelDayTotalUsd(day: SpendDay | undefined, recorded: CaseSpend | undefined, caseTotalUsd: number): number {
  return modelSpentUsd(day) + Math.max(0, caseTotalUsd - (recorded?.recordedModelUsd ?? 0))
}

/** Можно ли модели ещё один запрос. Потолок случая — без запаса; дневной — с запасом и важнее случая. */
export function modelBlock(input: { caseUsd: number; caseLimitUsd: number; dayUsd: number; limits: { modelUsdPerDay: number } }): ModelBlock | undefined {
  const dayLimit = usableUsd(input.limits.modelUsdPerDay)
  if (dayLimit <= 0 || input.dayUsd >= dayLimit - USD_EPSILON) return 'day_budget'
  return input.caseUsd >= input.caseLimitUsd ? 'budget' : undefined
}

/** Сколько других случаев сейчас ждут eval. Свой и давно забытые не считаются. */
export function waitingForEval(queue: EvalQueue | undefined, caseKey: string, now: number): number {
  return Object.entries(queue?.waiting ?? {}).filter(([key, since]) => key !== caseKey && now - since < EVAL_WAITING_STALE_MS).length
}

/**
 * Пускать ли eval и с какой бронью. Остаток дня (с запасом) делится поровну между этим случаем и теми, кто ещё ждёт;
 * бронь — не больше доли случая. Остатка нет — ждать чужие брони или следующие сутки.
 */
export function admitEval(day: SpendDay | undefined, limits: { evalUsdPerDay: number; evalUsdPerCase: number }, waitingOthers: number): EvalAdmission {
  // Доля случая нулевая — eval выключен настройкой, ждать нечего.
  if (limits.evalUsdPerCase <= 0) return { kind: 'reserve', usd: 0 }
  const free = usableUsd(limits.evalUsdPerDay) - evalSpentUsd(day)
  if (free <= USD_EPSILON) {
    const othersRunning = Object.values(day?.eval ?? {}).some((item) => item.actualUsd === undefined)
    return othersRunning ? { kind: 'wait' } : { kind: 'next_day' }
  }
  return { kind: 'reserve', usd: Math.min(limits.evalUsdPerCase, free / (1 + Math.max(0, waitingOthers))) }
}

function evalQueueIn(tx: RecordTransaction): Promise<EvalQueue> {
  return tx.doc<EvalQueue>('eval-queue', 'main', emptyEvalQueue())
}

/** Случай дошёл до проверки и, вероятно, попросит eval: его доля остатка дня бережётся. */
export async function joinEvalQueueIn(tx: RecordTransaction, caseKey: string, now: number): Promise<void> {
  ;(await evalQueueIn(tx)).waiting[caseKey] = now
}

export async function leaveEvalQueueIn(tx: RecordTransaction, caseKey: string): Promise<void> {
  const queue = await evalQueueIn(tx)
  if (Object.hasOwn(queue.waiting, caseKey)) delete queue.waiting[caseKey]
}

/**
 * Бронь eval случая одной транзакцией: брони его прогонов, прерванных перезапуском, закрываются фактом прокси,
 * остаток дня делится с ждущими. Не пустили — случай остаётся в очереди со свежей отметкой.
 */
export async function reserveEvalIn(
  tx: RecordTransaction,
  input: { dayKey: string; caseKey: string; now: number; limits: { evalUsdPerDay: number; evalUsdPerCase: number } },
): Promise<{ admission: EvalAdmission; id?: string }> {
  const day = await tx.doc<SpendDay>('spend', input.dayKey, emptySpendDay())
  const queue = await evalQueueIn(tx)
  let attempt = 0
  for (; day.eval[`case-${input.caseKey}-${attempt}`]; attempt += 1) closeInterruptedEval(day.eval[`case-${input.caseKey}-${attempt}`]!)
  const admission = admitEval(day, input.limits, waitingForEval(queue, input.caseKey, input.now))
  if (admission.kind !== 'reserve') {
    queue.waiting[input.caseKey] = input.now
    return { admission }
  }
  if (Object.hasOwn(queue.waiting, input.caseKey)) delete queue.waiting[input.caseKey]
  const id = `case-${input.caseKey}-${attempt}`
  day.eval[id] = { reservedUsd: admission.usd }
  return { admission, id }
}

export function recordEvalObserved(item: EvalReservation, spend: EvalSpend): void {
  item.observedUsd = spend.spentUsd
  item.inFlightUsd = spend.inFlightUsd
}

/** Проверка упала, врач жив: все запросы шли через прокси. Нет его итога — eval к модели не ходил. */
export function settleEvalWithProxyFact(item: EvalReservation, spend: EvalSpend | undefined): void {
  item.actualUsd ??= spend ? spend.spentUsd + spend.inFlightUsd : 0
}

/** Бронь прогона, прерванного перезапуском: записанный факт прокси плюс брони запросов в пути. */
export function closeInterruptedEval(item: EvalReservation): void {
  item.actualUsd ??= (item.observedUsd ?? 0) + (item.inFlightUsd ?? 0)
}
