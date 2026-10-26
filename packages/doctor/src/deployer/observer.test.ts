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
  previousVersion: 'prev',
  observeUntil: minutes(30),
}
const quiet = { errors: 0, errorsPerHour: 0, newFingerprints: [], caseFingerprintSeen: false }
const sick = { health: { ok: false, reason: 'нет ответа' } } as const

function tick(at: number, overrides: Partial<ObservationTick> = {}): ObservationTick {
  return {
    at: minutes(at),
    current: { ok: true, version: 'cand', previous: 'prev' },
    health: { ok: true },
    errors: quiet,
    recentErrors: quiet,
    ...overrides,
  }
}

/** Прогон окна по тикам раз в 30 с (часы подменены: время — в самих тиках). */
function run(ticks: (minute: number) => Partial<ObservationTick>, from = 0.5) {
  let state = startObservation()
  for (let at = from; at <= from + 40; at += 0.5) {
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
    const inRow = run((at) => (at >= 5 ? sick : {}))
    expect(inRow.at).toBe(6)
    expect(inRow.verdict).toMatchObject({ kind: 'rollback', reason: 'health', detail: expect.stringContaining('нет ответа') })

    const scattered = run((at) => (at % 2 === 1 ? sick : {}))
    expect(scattered.verdict).toEqual({ kind: 'window_over', outcome: 'holding' })
  })

  it('три сбоя из последних пяти проверок — откат, даже вперемешку со здоровыми', () => {
    const flapping = run((at) => (at >= 5 && (at * 2) % 2 === 0 ? sick : {}))
    expect(flapping).toMatchObject({ at: 7, verdict: { kind: 'rollback', reason: 'health', detail: expect.stringContaining('3 из 5') } })
  })

  it('сбой здоровья на последней проверке окна — откат, а не «держится»', () => {
    const last = run((at) => (at === 30 ? sick : {}))
    expect(last).toMatchObject({ at: 30, verdict: { kind: 'rollback', reason: 'health' } })
  })

  it('одной проверки мало: окно уже прошло (врач долго спал) — сначала пять проверок', () => {
    const late = run(() => ({}), 31)
    expect(late).toEqual({ at: 33, verdict: { kind: 'window_over', outcome: 'holding' } })
  })

  it('current не отвечает или не знает версии — неизвестно, что работает: откат сразу', () => {
    const silent = run((at) => (at >= 10 ? { current: { ok: false, reason: 'current: тайм-аут' } } : {}))
    expect(silent).toMatchObject({ at: 10, verdict: { kind: 'rollback', reason: 'current_unavailable', detail: 'current: тайм-аут' } })
    const empty = run((at) => (at >= 4 ? { current: { ok: true, version: null, previous: null } } : {}))
    expect(empty).toMatchObject({ at: 4, verdict: { kind: 'rollback', reason: 'current_unavailable' } })
  })

  it('приложение само вернулось к прежней версии — это откат, а не выкатка человека', () => {
    const reverted = run((at) => (at >= 12 ? { current: { ok: true, version: 'prev', previous: null } } : {}))
    expect(reverted).toEqual({ at: 12, verdict: { kind: 'rollback', reason: 'reverted', detail: 'приложение вернулось к прежней версии' } })
  })

  it('рост ошибок выше множителя и порога — откат; рост ниже порога по числу — нет', () => {
    const burst = run((at) => (at >= 3 ? { errors: { ...quiet, errors: 6, errorsPerHour: 13 } } : {}))
    expect(burst).toMatchObject({ at: 3, verdict: { kind: 'rollback', reason: 'error_rate' } })

    const few = run(() => ({ errors: { ...quiet, errors: 4, errorsPerHour: 40 } }))
    expect(few.verdict).toEqual({ kind: 'window_over', outcome: 'holding' })
    const usual = run(() => ({ errors: { ...quiet, errors: 6, errorsPerHour: 12 } }))
    expect(usual.verdict).toEqual({ kind: 'window_over', outcome: 'holding' })
  })

  it('всплеск за последние 10 минут — откат, даже если по всему окну в среднем терпимо', () => {
    const late = run((at) => (at >= 25 ? { errors: { ...quiet, errors: 6, errorsPerHour: 11 }, recentErrors: { ...quiet, errors: 6, errorsPerHour: 36 } } : {}))
    expect(late).toMatchObject({ at: 25, verdict: { kind: 'rollback', reason: 'error_rate', detail: expect.stringContaining('10 минут') } })
  })

  it('новые отпечатки, которых не было неделю, — откат', () => {
    const fresh = run((at) => ({ errors: { ...quiet, errors: 3, errorsPerHour: 6, newFingerprints: at >= 8 ? ['a', 'b', 'c'] : ['a', 'b'] } }))
    expect(fresh).toMatchObject({ at: 8, verdict: { kind: 'rollback', reason: 'new_fingerprints' } })
  })

  it('сбой случая повторяется без ухудшения — не помогло, без отката', () => {
    const same = run(() => ({ errors: { ...quiet, errors: 2, errorsPerHour: 4, caseFingerprintSeen: true } }))
    expect(same).toEqual({ at: 30, verdict: { kind: 'window_over', outcome: 'not_helped' } })
  })

  it('человек сменил current — выкатку перебили, без отката', () => {
    const human = run((at) => (at >= 12 ? { current: { ok: true, version: 'human', previous: 'cand' }, health: { ok: false, reason: 'перезапуск' } } : {}))
    expect(human).toEqual({ at: 12, verdict: { kind: 'superseded', version: 'human' } })
  })
})
