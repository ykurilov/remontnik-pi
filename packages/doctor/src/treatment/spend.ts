// Дневной расход врача (data-model: SpendLedger) — в записях, поэтому переживает перезапуск.
// Модель и eval считаются отдельно: у каждого свой дневной потолок (`modelUsdPerDay`, `evalUsdPerDay`).
// Модель записывается по ходу разговора приращениями; eval — бронью до запуска и фактом после.
// Бронь eval — доля случая (`evalUsdPerCase`), не больше остатка дня. Факт даёт прокси модели: пока eval идёт,
// его расход пишется в бронь. Ошибка проверки или перезапуск врача закрывают бронь этим фактом;
// целиком сгорает только то, чего прокси не досчитал (запрос ещё шёл, когда всё оборвалось).

import type { EvalSpend } from '../eval-proxy/index.js'

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
  /** Запросы к модели, которые ещё шли при последней записи. */
  pendingRequests?: number
}

/** Сколько модель уже записала по случаю: приращение к дню — это разница с новым итогом разговора. */
export interface CaseSpend {
  recordedModelUsd: number
}

export const emptySpendDay = (): SpendDay => ({ model: {}, eval: {} })

/** День по часовому поясу приложения: `YYYY-MM-DD`. */
export function spendDayKey(ms: number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(ms))
  const part = (type: string) => parts.find((item) => item.type === type)?.value ?? '00'
  return `${part('year')}-${part('month')}-${part('day')}`
}

export function modelSpentUsd(day: SpendDay | undefined): number {
  return Object.values(day?.model ?? {}).reduce((sum, usd) => sum + usd, 0)
}

/** Расход eval за день: факт, а где его нет (идёт или прервано сбоем) — вся бронь. */
export function evalSpentUsd(day: SpendDay | undefined): number {
  return Object.values(day?.eval ?? {}).reduce((sum, item) => sum + (item.actualUsd ?? item.reservedUsd), 0)
}

/** Бронь случая: доля `evalUsdPerCase`, но не больше остатка дневного бюджета. */
export function evalCaseBudgetUsd(day: SpendDay | undefined, limits: { evalUsdPerDay: number; evalUsdPerCase: number }): number {
  return Math.max(0, Math.min(limits.evalUsdPerCase, limits.evalUsdPerDay - evalSpentUsd(day)))
}

export function recordEvalObserved(item: EvalReservation, spend: EvalSpend): void {
  item.observedUsd = spend.spentUsd
  item.pendingRequests = spend.pending
}

/** Проверка упала, врач жив: все запросы шли через прокси. Нет его итога — eval к модели не ходил. */
export function settleEvalWithProxyFact(item: EvalReservation, spend: EvalSpend | undefined): void {
  item.actualUsd ??= spend && spend.pending > 0 ? item.reservedUsd : (spend?.spentUsd ?? 0)
}

/** Бронь прогона, прерванного перезапуском: записанный факт прокси, если ни один запрос не висел; иначе — вся бронь. */
export function closeInterruptedEval(item: EvalReservation): void {
  item.actualUsd ??= item.observedUsd !== undefined && !item.pendingRequests ? item.observedUsd : item.reservedUsd
}
