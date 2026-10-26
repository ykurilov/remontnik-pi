import { describe, expect, it } from 'vitest'
import { testRemontnikConfig } from '../testing/config.js'
import { observe, startObservation, type ObservationTick } from './observer.js'

const settings = testRemontnikConfig().observe
const promotedAt = Date.parse('2026-10-26T12:00:00Z')
const minutes = (count: number) => new Date(promotedAt + count * 60_000)
const window = {
  settings,
  baseline: { errorsPerHour: 4, knownFingerprints7d: ['known'] },
  candidateVersion: 'cand',
  observeUntil: minutes(30),
}

function tick(at: number, overrides: Partial<ObservationTick> = {}): ObservationTick {
  return {
    at: minutes(at),
    current: { ok: true, version: 'cand', previous: 'prev' },
    health: { ok: true },
    errors: { errors: 0, errorsPerHour: 0, newFingerprints: [], caseFingerprintSeen: false },
    ...overrides,
  }
}

/** Прогон окна по тикам раз в 30 с (часы подменены: время — в самих тиках). */
function run(ticks: (minute: number) => Partial<ObservationTick>) {
  let state = startObservation()
  for (let at = 0.5; at <= 31; at += 0.5) {
    const step = observe(state, tick(at, ticks(at)), window)
    state = step.state
    if (step.verdict.kind !== 'continue') return { at, verdict: step.verdict }
  }
  throw new Error('окно не закончилось')
}

describe('наблюдение после выкатки', () => {
  it('тихое окно: к концу — выкатка держится', () => {
    expect(run(() => ({}))).toEqual({ at: 30, verdict: { kind: 'window_over', outcome: 'holding' } })
  })

  it('три сбоя здоровья подряд — откат; одиночные сбои с паузами — нет', () => {
    const inRow = run((at) => (at >= 5 ? { health: { ok: false, reason: 'нет ответа' } } : {}))
    expect(inRow.at).toBe(6)
    expect(inRow.verdict).toMatchObject({ kind: 'rollback', reason: 'health', detail: expect.stringContaining('нет ответа') })

    const scattered = run((at) => (at % 2 === 0 ? { health: { ok: false, reason: 'миг' } } : {}))
    expect(scattered.verdict).toEqual({ kind: 'window_over', outcome: 'holding' })
  })

  it('current не отвечает — считается сбоем здоровья', () => {
    const silent = run((at) => (at >= 10 ? { current: { ok: false, reason: 'current: тайм-аут' } } : {}))
    expect(silent).toMatchObject({ at: 11, verdict: { kind: 'rollback', reason: 'health' } })
  })

  it('рост ошибок выше множителя и порога — откат; рост ниже порога по числу — нет', () => {
    const burst = run((at) => (at >= 3 ? { errors: { errors: 6, errorsPerHour: 13, newFingerprints: [], caseFingerprintSeen: false } } : {}))
    expect(burst).toMatchObject({ at: 3, verdict: { kind: 'rollback', reason: 'error_rate' } })

    const few = run(() => ({ errors: { errors: 4, errorsPerHour: 40, newFingerprints: [], caseFingerprintSeen: false } }))
    expect(few.verdict).toEqual({ kind: 'window_over', outcome: 'holding' })
    const usual = run(() => ({ errors: { errors: 6, errorsPerHour: 12, newFingerprints: [], caseFingerprintSeen: false } }))
    expect(usual.verdict).toEqual({ kind: 'window_over', outcome: 'holding' })
  })

  it('новые отпечатки, которых не было неделю, — откат', () => {
    const fresh = run((at) => ({ errors: { errors: 3, errorsPerHour: 6, newFingerprints: at >= 8 ? ['a', 'b', 'c'] : ['a', 'b'], caseFingerprintSeen: false } }))
    expect(fresh).toMatchObject({ at: 8, verdict: { kind: 'rollback', reason: 'new_fingerprints' } })
  })

  it('сбой случая повторяется без ухудшения — не помогло, без отката', () => {
    const same = run(() => ({ errors: { errors: 2, errorsPerHour: 4, newFingerprints: [], caseFingerprintSeen: true } }))
    expect(same).toEqual({ at: 30, verdict: { kind: 'window_over', outcome: 'not_helped' } })
  })

  it('человек сменил current — выкатку перебили, без отката', () => {
    const human = run((at) => (at >= 12 ? { current: { ok: true, version: 'human', previous: 'cand' }, health: { ok: false, reason: 'перезапуск' } } : {}))
    expect(human).toEqual({ at: 12, verdict: { kind: 'superseded', version: 'human' } })
  })
})
