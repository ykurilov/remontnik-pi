import { describe, expect, it } from 'vitest'
import {
  closeInterruptedEval,
  emptySpendDay,
  evalCaseBudgetUsd,
  evalSpentUsd,
  modelSpentUsd,
  recordEvalObserved,
  settleEvalWithProxyFact,
  spendDayKey,
  type EvalReservation,
} from './spend.js'

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

describe('бронь eval', () => {
  const limits = { evalUsdPerDay: 5, evalUsdPerCase: 1 }

  it('бронируется доля случая, но не больше остатка дня', () => {
    expect(evalCaseBudgetUsd(emptySpendDay(), limits)).toBe(1)
    const day = { model: {}, eval: { 'case-1-0': { reservedUsd: 1, actualUsd: 4.6 } } }
    expect(evalCaseBudgetUsd(day, limits)).toBeCloseTo(0.4)
    day.eval['case-1-0'].actualUsd = 6
    expect(evalCaseBudgetUsd(day, limits)).toBe(0)
  })

  it('расход прокси по ходу пишется в бронь', () => {
    const item: EvalReservation = { reservedUsd: 1 }
    recordEvalObserved(item, { spentUsd: 0.3, pending: 1 })
    expect(item).toEqual({ reservedUsd: 1, observedUsd: 0.3, pendingRequests: 1 })
  })

  it('ошибка проверки при живом враче → бронь закрывается фактом прокси', () => {
    const item: EvalReservation = { reservedUsd: 1 }
    settleEvalWithProxyFact(item, { spentUsd: 0.3, pending: 0 })
    expect(item.actualUsd).toBe(0.3)
    const untouched: EvalReservation = { reservedUsd: 1 }
    settleEvalWithProxyFact(untouched, undefined)
    expect(untouched.actualUsd).toBe(0)
  })

  it('запрос ещё шёл, когда всё оборвалось → бронь сгорает целиком', () => {
    const item: EvalReservation = { reservedUsd: 1 }
    settleEvalWithProxyFact(item, { spentUsd: 0.3, pending: 1 })
    expect(item.actualUsd).toBe(1)
  })

  it('после перезапуска: записанный факт прокси без висящих запросов — он; иначе вся бронь', () => {
    const seen: EvalReservation = { reservedUsd: 1, observedUsd: 0.3, pendingRequests: 0 }
    const hanging: EvalReservation = { reservedUsd: 1, observedUsd: 0.3, pendingRequests: 2 }
    const unseen: EvalReservation = { reservedUsd: 1 }
    const settled: EvalReservation = { reservedUsd: 1, actualUsd: 0.1, observedUsd: 0.3, pendingRequests: 0 }
    for (const item of [seen, hanging, unseen, settled]) closeInterruptedEval(item)
    expect([seen.actualUsd, hanging.actualUsd, unseen.actualUsd, settled.actualUsd]).toEqual([0.3, 1, 1, 0.1])
  })
})
