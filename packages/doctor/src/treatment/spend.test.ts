import { describe, expect, it } from 'vitest'
import { evalSpentUsd, modelSpentUsd, spendDayKey } from './spend.js'

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
