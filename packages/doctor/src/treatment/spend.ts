// Дневной расход врача (data-model: SpendLedger) — в записях, поэтому переживает перезапуск.
// Модель и eval считаются отдельно: у каждого свой дневной потолок (`modelUsdPerDay`, `evalUsdPerDay`).
// Модель записывается по ходу разговора приращениями; eval — бронью до запуска и фактом после.
// Бронь eval — доля случая (`evalUsdPerCase`), не больше остатка дня; ставится прямо перед запуском eval.
// Факт даёт прокси модели: до отправки каждого запроса к поставщику он ждёт записи его брони, после ответа —
// записи факта. Ошибка проверки или перезапуск врача закрывают бронь eval записанным фактом плюс брони
// запросов, которые ещё шли; ничего не записано — eval к модели не ходил, бронь закрывается нулём.

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
  /** Брони запросов к модели, которые ещё шли при последней записи. */
  inFlightUsd?: number
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
