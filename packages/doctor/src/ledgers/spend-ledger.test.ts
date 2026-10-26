import { describe, expect, it } from 'vitest'
import { createMemoryRecordStore, type RecordStore } from '../records/index.js'
import {
  admitEval,
  closeInterruptedEval,
  emptySpendDay,
  evalSpentUsd,
  modelDayTotalUsd,
  modelBlock,
  modelSpentUsd,
  nextDayStartMs,
  recordEvalObserved,
  settleEvalWithProxyFact,
  spendDayKey,
  waitingForEval,
  type EvalReservation,
  type SpendDay,
  joinEvalQueueIn,
  leaveEvalQueueIn,
  reserveEvalIn,
  usableUsd,
  type EvalQueue,
} from './spend-ledger.js'

const HOUR = 3_600_000

describe('дневной расход', () => {
  it('день — по часовому поясу приложения', () => {
    const ms = Date.UTC(2026, 9, 25, 22, 30)
    expect(spendDayKey(ms, 'UTC')).toBe('2026-10-25')
    expect(spendDayKey(ms, 'Europe/Moscow')).toBe('2026-10-26')
  })

  it('модель — сумма по случаям; eval — факт, а без факта бронь', () => {
    const day = { model: { '1': 0.3, '2': 0.2 }, eval: { 'case-1-0': { reservedUsd: 2, actualUsd: 0.4 }, 'case-2-0': { reservedUsd: 1 } } }
    expect(modelSpentUsd(day)).toBeCloseTo(0.5)
    expect(evalSpentUsd(day)).toBeCloseTo(1.4)
    expect(modelSpentUsd(undefined)).toBe(0)
  })
})

describe('граница суток', () => {
  it('следующие сутки начинаются в полночь пояса приложения, а не UTC', () => {
    const ms = Date.UTC(2026, 9, 25, 22, 30)
    expect(nextDayStartMs(ms, 'UTC')).toBe(Date.UTC(2026, 9, 26, 0, 0))
    expect(nextDayStartMs(ms, 'Europe/Moscow')).toBe(Date.UTC(2026, 9, 26, 21, 0))
    expect(nextDayStartMs(ms, 'Asia/Makassar')).toBe(Date.UTC(2026, 9, 26, 16, 0))
  })

  it('ровно в полночь — следующие сутки, а не эти же', () => {
    const midnight = Date.UTC(2026, 9, 26, 0, 0)
    expect(nextDayStartMs(midnight, 'UTC')).toBe(midnight + 24 * HOUR)
    expect(spendDayKey(midnight - 1, 'UTC')).toBe('2026-10-25')
    expect(spendDayKey(midnight, 'UTC')).toBe('2026-10-26')
  })

  it('день перевода часов: сутки в 25 часов кончаются в настоящую полночь', () => {
    // В Берлине 25.10.2026 часы переводятся назад: сутки длиннее на час.
    const morning = Date.UTC(2026, 9, 25, 6, 0)
    expect(nextDayStartMs(morning, 'Europe/Berlin')).toBe(Date.UTC(2026, 9, 25, 23, 0))
    expect(spendDayKey(Date.UTC(2026, 9, 25, 22, 59), 'Europe/Berlin')).toBe('2026-10-25')
  })
})

describe('блок обращения к модели', () => {
  const limits = { modelUsdPerDay: 5 }

  it('за день считается и то, что разговор случая потратил, но ещё не записано', () => {
    const day: SpendDay = { model: { '1': 2, '2': 1 }, eval: {} }
    expect(modelDayTotalUsd(day, { recordedModelUsd: 2 }, 2.5)).toBeCloseTo(3.5)
    expect(modelDayTotalUsd(day, { recordedModelUsd: 2 }, 2)).toBeCloseTo(3)
    expect(modelDayTotalUsd(undefined, undefined, 0.4)).toBeCloseTo(0.4)
  })

  it('запас 10%: модель останавливается на 90% дневного потолка', () => {
    expect(modelBlock({ caseUsd: 0, caseLimitUsd: 1, dayUsd: 4.49, limits })).toBeUndefined()
    expect(modelBlock({ caseUsd: 0, caseLimitUsd: 1, dayUsd: 4.5, limits })).toBe('day_budget')
  })

  it('потолок случая — без запаса; день важнее случая', () => {
    expect(modelBlock({ caseUsd: 0.99, caseLimitUsd: 1, dayUsd: 1, limits })).toBeUndefined()
    expect(modelBlock({ caseUsd: 1, caseLimitUsd: 1, dayUsd: 1, limits })).toBe('budget')
    expect(modelBlock({ caseUsd: 1, caseLimitUsd: 1, dayUsd: 4.6, limits })).toBe('day_budget')
  })

  it('нулевой потолок дня — модель не зовётся вовсе', () => {
    expect(modelBlock({ caseUsd: 0, caseLimitUsd: 1, dayUsd: 0, limits: { modelUsdPerDay: 0 } })).toBe('day_budget')
  })
})

describe('блок eval и бронь', () => {
  const limits = { evalUsdPerDay: 5, evalUsdPerCase: 1 }

  it('бронируется доля случая, но не больше остатка дня с запасом 10%', () => {
    expect(admitEval(emptySpendDay(), limits, 0)).toEqual({ kind: 'reserve', usd: 1 })
    const day: SpendDay = { model: {}, eval: { 'case-1-0': { reservedUsd: 1, actualUsd: 4.1 } } }
    const admitted = admitEval(day, limits, 0)
    expect(admitted.kind).toBe('reserve')
    expect(admitted.kind === 'reserve' && admitted.usd).toBeCloseTo(0.4)
  })

  it('денег на сегодня нет и чужих броней нет → до следующих суток', () => {
    const day: SpendDay = { model: {}, eval: { 'case-1-0': { reservedUsd: 1, actualUsd: 4.5 } } }
    expect(admitEval(day, limits, 0)).toEqual({ kind: 'next_day' })
  })

  it('денег нет, но чужой eval ещё идёт → подождать: его бронь вернёт неистраченное', () => {
    const day: SpendDay = { model: {}, eval: { 'case-1-0': { reservedUsd: 1, actualUsd: 3.5 }, 'case-2-0': { reservedUsd: 1 } } }
    expect(admitEval(day, limits, 0)).toEqual({ kind: 'wait' })
  })

  it('честное деление: остаток делится с теми, кто тоже ждёт eval, а не уходит первому', () => {
    const day: SpendDay = { model: {}, eval: { 'case-1-0': { reservedUsd: 1, actualUsd: 3.3 } } }
    // Остаток 4.5 − 3.3 = 1.2; ждут ещё двое — каждому по 0.4, хотя доля случая 1.
    const first = admitEval(day, limits, 2)
    expect(first.kind === 'reserve' && first.usd).toBeCloseTo(0.4)
    day.eval['case-2-0'] = { reservedUsd: 0.4 }
    const second = admitEval(day, limits, 1)
    expect(second.kind === 'reserve' && second.usd).toBeCloseTo(0.4)
    day.eval['case-3-0'] = { reservedUsd: 0.4 }
    const third = admitEval(day, limits, 0)
    expect(third.kind === 'reserve' && third.usd).toBeCloseTo(0.4)
  })

  it('кто ждёт eval: другие случаи, свежие отметки; свой и забытые не считаются', () => {
    const now = Date.UTC(2026, 9, 26, 12)
    const queue = { waiting: { '1': now - 1000, '2': now - 2000, '3': now - 5 * HOUR } }
    expect(waitingForEval(queue, '1', now)).toBe(1)
    expect(waitingForEval(queue, '9', now)).toBe(2)
    expect(waitingForEval(undefined, '1', now)).toBe(0)
  })

  it('расход прокси по ходу пишется в бронь вместе с бронями запросов в пути', () => {
    const item: EvalReservation = { reservedUsd: 1 }
    recordEvalObserved(item, { spentUsd: 0.3, inFlightUsd: 0.2 })
    expect(item).toEqual({ reservedUsd: 1, observedUsd: 0.3, inFlightUsd: 0.2 })
  })

  it('ошибка проверки при живом враче → бронь закрывается фактом прокси; прокси не открывался → нулём', () => {
    const item: EvalReservation = { reservedUsd: 1 }
    settleEvalWithProxyFact(item, { spentUsd: 0.3, inFlightUsd: 0 })
    expect(item.actualUsd).toBe(0.3)
    const untouched: EvalReservation = { reservedUsd: 1 }
    settleEvalWithProxyFact(untouched, undefined)
    expect(untouched.actualUsd).toBe(0)
  })

  it('запрос ещё шёл, когда всё оборвалось → засчитывается его бронь, а не вся бронь eval', () => {
    const item: EvalReservation = { reservedUsd: 1 }
    settleEvalWithProxyFact(item, { spentUsd: 0.3, inFlightUsd: 0.2 })
    expect(item.actualUsd).toBeCloseTo(0.5)
  })

  it('после перезапуска: записанный факт плюс брони запросов в пути; ничего не записано — ноль', () => {
    const seen: EvalReservation = { reservedUsd: 1, observedUsd: 0.3, inFlightUsd: 0 }
    const hanging: EvalReservation = { reservedUsd: 1, observedUsd: 0.3, inFlightUsd: 0.2 }
    const unseen: EvalReservation = { reservedUsd: 1 }
    const settled: EvalReservation = { reservedUsd: 1, actualUsd: 0.1, observedUsd: 0.3, inFlightUsd: 0 }
    for (const item of [seen, hanging, unseen, settled]) closeInterruptedEval(item)
    expect(seen.actualUsd).toBeCloseTo(0.3)
    expect(hanging.actualUsd).toBeCloseTo(0.5)
    expect([unseen.actualUsd, settled.actualUsd]).toEqual([0, 0.1])
  })
})

describe('бронь eval в записях: гонки и сбои', () => {
  const limits = { evalUsdPerDay: 2, evalUsdPerCase: 1 }
  const now = Date.UTC(2026, 10, 2, 12)
  const dayKey = '2026-11-02'

  async function reserve(store: RecordStore, caseKey: string, at = now) {
    return store.transaction((tx) => reserveEvalIn(tx, { dayKey, caseKey, now: at, limits }))
  }

  it('два случая бронируют одновременно → вместе не больше дневного потолка с запасом, поровну', async () => {
    const store = createMemoryRecordStore()
    await store.transaction((tx) => joinEvalQueueIn(tx, '1', now))
    await store.transaction((tx) => joinEvalQueueIn(tx, '2', now))
    // Остаток 1.8 > 1, но ждут двое: каждому по 0.9, а не первому весь 1.
    const [first, second] = await Promise.all([reserve(store, '1'), reserve(store, '2')])
    const day = await store.read<SpendDay>('spend', dayKey)
    expect(evalSpentUsd(day)).toBeLessThanOrEqual(usableUsd(limits.evalUsdPerDay) + 1e-9)
    expect(first.admission).toEqual({ kind: 'reserve', usd: 0.9 })
    expect(second.admission).toEqual({ kind: 'reserve', usd: 0.9 })
    expect((await store.read<EvalQueue>('eval-queue', 'main'))?.waiting).toEqual({})
  })

  it('третий случай при открытых бронях → ждёт и остаётся в очереди; брони закрылись — получает остаток', async () => {
    const store = createMemoryRecordStore()
    const first = await reserve(store, '1')
    const second = await reserve(store, '2')
    expect((await reserve(store, '3')).admission).toEqual({ kind: 'wait' })
    expect((await store.read<EvalQueue>('eval-queue', 'main'))?.waiting['3']).toBe(now)
    await store.transaction(async (tx) => {
      const day = await tx.doc<SpendDay>('spend', dayKey, emptySpendDay())
      day.eval[first.id!]!.actualUsd = 0.2
      day.eval[second.id!]!.actualUsd = 0.3
    })
    expect((await reserve(store, '3')).admission).toEqual({ kind: 'reserve', usd: 1 })
  })

  it('врач упал между бронью и записью итога → следующая бронь случая закрывает прерванную фактом прокси', async () => {
    const store = createMemoryRecordStore()
    const before = await reserve(store, '1')
    await store.transaction(async (tx) => {
      const day = await tx.doc<SpendDay>('spend', dayKey, emptySpendDay())
      recordEvalObserved(day.eval[before.id!]!, { spentUsd: 0.25, inFlightUsd: 0.05 })
    })
    const after = await reserve(store, '1', now + 60_000)
    expect(after.id).not.toBe(before.id)
    const day = await store.read<SpendDay>('spend', dayKey)
    expect(day?.eval[before.id!]).toMatchObject({ actualUsd: 0.3 })
    // Прерванная бронь больше не держит деньги: 1.8 − 0.3 = 1.5, доля случая 1.
    expect(after.admission).toEqual({ kind: 'reserve', usd: 1 })
  })

  it('ушёл из очереди → его больше не ждут', async () => {
    const store = createMemoryRecordStore()
    await store.transaction((tx) => joinEvalQueueIn(tx, '2', now))
    await store.transaction((tx) => leaveEvalQueueIn(tx, '2'))
    expect((await reserve(store, '1')).admission).toEqual({ kind: 'reserve', usd: 1 })
  })
})
