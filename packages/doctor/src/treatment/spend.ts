// Дневной расход врача (data-model: SpendLedger) — в записях, поэтому переживает перезапуск.
// Модель и eval считаются отдельно: у каждого свой дневной потолок (`modelUsdPerDay`, `evalUsdPerDay`).
// Модель записывается по ходу разговора приращениями; eval — бронью до запуска и фактом после.
// Сбой посреди eval оставляет бронь: потраченное до сбоя не теряется, а лишь считается с запасом.

export interface SpendDay {
  /** Расход модели по случаям за день. */
  model: Record<string, number>
  /** Брони eval: сколько выделено и сколько потрачено на деле. */
  eval: Record<string, { reservedUsd: number; actualUsd?: number }>
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
