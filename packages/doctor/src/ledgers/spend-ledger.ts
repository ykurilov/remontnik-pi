// Дневной расход врача (data-model: SpendLedger) — в записях, поэтому переживает перезапуск.
// Модель и eval считаются отдельно: у каждого свой дневной потолок (`doctorModelUsdPerDay`, `evalUsdPerDay`).
// Сутки — по поясу приложения (`app.timeZone`). Дневные потолки — с запасом 10% (R1): последняя секунда потока
// может не попасть в учёт при падении, поэтому работа останавливается на 90% потолка.
// Модель — бронью до каждого запроса (`holdModelIn`): наибольшая цена запроса при длине ответа до предела модели.
// Денег на бронь нет — запрос не уходит. После ответа бронь заменяется настоящей ценой (`settleModelHoldIn`).
// Бронь прошлого запуска врача (упал посреди запроса) списывается целиком: ответ мог быть оплачен.
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
  /** Брони запросов к модели, которые ещё идут. */
  modelHolds?: Record<string, ModelHold>
}

export interface ModelHold {
  /** Случай; пусто — запрос не от разговора случая (например, сжатие): он считается только в день. */
  caseKey: string
  usd: number
  /** Запуск врача, который сделал бронь. */
  boot: string
  at: number
}

export interface EvalReservation {
  reservedUsd: number
  /** Запуск врача и время брони: бронь мёртвого запуска или слишком старая закрывается. */
  boot?: string
  reservedAt?: number
  /** Итог: бронь закрыта. */
  actualUsd?: number
  /** Расход по прокси, пока eval идёт. */
  observedUsd?: number
  /** Брони запросов к модели, которые ещё шли при последней записи. */
  inFlightUsd?: number
}

/** Расход модели по случаю за всё лечение. */
export interface CaseSpend {
  modelUsd: number
  /** Последнюю бронь случая не пустили: почему. Снимается следующей удачной бронью. */
  refused?: ModelBlock
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
/** Бронь eval старше этого — прогон точно не идёт (дольше eval не живёт): бронь закрывается. */
export const EVAL_RESERVATION_STALE_MS = 2 * 3_600_000
/** Ключ дня для запросов к модели не от случая. */
const NO_CASE = '-'
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

/** Потолок расходов модели на случай. */
export function caseLimitUsdOf(limits: { diagnoseUsdPerCase?: number | undefined; doctorModelUsdPerDay: number }): number {
  return limits.diagnoseUsdPerCase ?? limits.doctorModelUsdPerDay
}

function caseSpendIn(tx: RecordTransaction, caseKey: string): Promise<CaseSpend> {
  return tx.doc<CaseSpend>('spend-case', caseKey, { modelUsd: 0 })
}

/** Не пройдёт ли ещё `addUsd` сверх потолка: уже исчерпан или вместе с новой бронью больше. */
function exceeds(usedUsd: number, addUsd: number, limitUsd: number): boolean {
  return limitUsd <= 0 || usedUsd >= limitUsd - USD_EPSILON || usedUsd + addUsd > limitUsd + USD_EPSILON
}

/**
 * Бронь запроса к модели одной транзакцией. Дневной потолок — с запасом и важнее случая; потолок случая — без запаса
 * и на всё лечение. Брони прошлого запуска врача сначала списываются целиком. Отказ ничего не бронирует.
 */
export async function holdModelIn(
  tx: RecordTransaction,
  input: {
    dayKey: string
    caseKey?: string
    holdId: string
    maxUsd: number
    boot: string
    now: number
    caseLimitUsd: number
    limits: { doctorModelUsdPerDay: number }
  },
): Promise<{ held: true } | { held: false; block: ModelBlock }> {
  const day = await tx.doc<SpendDay>('spend', input.dayKey, emptySpendDay())
  day.modelHolds ??= {}
  // Черновик pi-durable: вложенное правится через документ — ссылка на только что присвоенный объект правок не запишет.
  const holds = day.modelHolds
  for (const [id, stale] of Object.entries(holds)) {
    if (stale.boot === input.boot) continue
    await chargeModelIn(tx, day, stale.caseKey, stale.usd)
    delete holds[id]
  }
  const heldUsd = (caseKey?: string) => Object.values(holds).reduce((sum, item) => sum + (caseKey === undefined || item.caseKey === caseKey ? item.usd : 0), 0)
  let block: ModelBlock | undefined
  if (exceeds(modelSpentUsd(day) + heldUsd(), input.maxUsd, usableUsd(input.limits.doctorModelUsdPerDay))) block = 'day_budget'
  const spend = input.caseKey === undefined ? undefined : await caseSpendIn(tx, input.caseKey)
  if (!block && spend && exceeds(spend.modelUsd + heldUsd(input.caseKey), input.maxUsd, input.caseLimitUsd)) block = 'budget'
  if (block) {
    if (spend) spend.refused = block
    return { held: false, block }
  }
  if (spend) delete spend.refused
  holds[input.holdId] = { caseKey: input.caseKey ?? '', usd: input.maxUsd, boot: input.boot, at: input.now }
  return { held: true }
}

/** Ответ пришёл (или запрос оборвался): бронь заменяется настоящей ценой. */
export async function settleModelHoldIn(tx: RecordTransaction, input: { dayKey: string; holdId: string; actualUsd: number }): Promise<void> {
  const day = await tx.doc<SpendDay>('spend', input.dayKey, emptySpendDay())
  const hold = day.modelHolds?.[input.holdId]
  if (!hold) return
  delete day.modelHolds![input.holdId]
  await chargeModelIn(tx, day, hold.caseKey, input.actualUsd)
}

async function chargeModelIn(tx: RecordTransaction, day: SpendDay, caseKey: string, usd: number): Promise<void> {
  const key = caseKey === '' ? NO_CASE : caseKey
  day.model[key] = (day.model[key] ?? 0) + usd
  if (caseKey !== '') (await caseSpendIn(tx, caseKey)).modelUsd += usd
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
 * как и чужие брони прошлого запуска врача или старше `EVAL_RESERVATION_STALE_MS`; остаток дня делится с ждущими.
 * Не пустили — случай остаётся в очереди со свежей отметкой.
 */
export async function reserveEvalIn(
  tx: RecordTransaction,
  input: { dayKey: string; caseKey: string; now: number; boot: string; limits: { evalUsdPerDay: number; evalUsdPerCase: number } },
): Promise<{ admission: EvalAdmission; id?: string }> {
  const day = await tx.doc<SpendDay>('spend', input.dayKey, emptySpendDay())
  const queue = await evalQueueIn(tx)
  for (const item of Object.values(day.eval)) {
    const dead = item.boot !== input.boot || input.now - (item.reservedAt ?? 0) > EVAL_RESERVATION_STALE_MS
    if (dead) closeInterruptedEval(item)
  }
  let attempt = 0
  for (; day.eval[`case-${input.caseKey}-${attempt}`]; attempt += 1) closeInterruptedEval(day.eval[`case-${input.caseKey}-${attempt}`]!)
  const admission = admitEval(day, input.limits, waitingForEval(queue, input.caseKey, input.now))
  if (admission.kind !== 'reserve') {
    queue.waiting[input.caseKey] = input.now
    return { admission }
  }
  if (Object.hasOwn(queue.waiting, input.caseKey)) delete queue.waiting[input.caseKey]
  const id = `case-${input.caseKey}-${attempt}`
  day.eval[id] = { reservedUsd: admission.usd, boot: input.boot, reservedAt: input.now }
  return { admission, id }
}

/** Задачу случая сняли: его открытые брони eval за эти дни закрываются фактом прокси, из очереди он уходит. */
export async function closeCaseEvalIn(tx: RecordTransaction, input: { caseKey: string; dayKeys: string[] }): Promise<void> {
  for (const dayKey of input.dayKeys) {
    const day = await tx.doc<SpendDay>('spend', dayKey, emptySpendDay())
    for (const [id, item] of Object.entries(day.eval)) if (id.startsWith(`case-${input.caseKey}-`)) closeInterruptedEval(item)
  }
  await leaveEvalQueueIn(tx, input.caseKey)
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
