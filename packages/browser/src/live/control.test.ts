import { describe, expect, it, vi } from 'vitest'
import { decideRequest } from '../guard/index.js'
import { OWNER_SILENCE_LIMIT_MS, createControlLock, handleOwnerInput, refuseIfHumanControl } from './control.js'
import type { LiveTarget } from './stream.js'

function fakeClock(start = 1_000_000) {
  let now = start
  return { now: () => now, advance: (ms: number) => (now += ms) }
}

function fakeTarget(): LiveTarget & { dispatched: unknown[] } {
  const dispatched: unknown[] = []
  return {
    dispatched,
    subscribe: () => () => {},
    dispatch: async (input) => {
      dispatched.push(input)
    },
  }
}

describe('замок управления', () => {
  it('владелец взял управление — команды врача отклонены; вернул — работают', () => {
    const clock = fakeClock()
    const lock = createControlLock({ now: clock.now })
    expect(refuseIfHumanControl(lock, 'remontnik')).toBeNull()

    lock.take('remontnik')
    expect(lock.holder('remontnik')).toBe('owner')
    expect(refuseIfHumanControl(lock, 'remontnik')).toMatchObject({ ok: false, code: 'refused_human_control' })
    expect(refuseIfHumanControl(lock, 'other-profile')).toBeNull()

    lock.release('remontnik')
    expect(lock.holder('remontnik')).toBe('doctor')
    expect(refuseIfHumanControl(lock, 'remontnik')).toBeNull()
  })

  it('связь владельца пропала на 2 минуты — управление возвращается врачу', () => {
    const clock = fakeClock()
    const lock = createControlLock({ now: clock.now })
    const disconnect = lock.ownerConnected('remontnik')
    lock.take('remontnik')

    clock.advance(10 * 60_000)
    expect(lock.holder('remontnik')).toBe('owner')

    disconnect()
    clock.advance(OWNER_SILENCE_LIMIT_MS - 1)
    expect(lock.holder('remontnik')).toBe('owner')
    clock.advance(1)
    expect(lock.holder('remontnik')).toBe('doctor')

    // Владелец вернулся позже: управление само не возвращается, нужно взять заново.
    lock.ownerConnected('remontnik')
    expect(lock.holder('remontnik')).toBe('doctor')
  })

  it('взял управление без живой связи — отсчёт двух минут от последнего знака владельца', () => {
    const clock = fakeClock()
    const lock = createControlLock({ now: clock.now })
    lock.take('remontnik')
    clock.advance(OWNER_SILENCE_LIMIT_MS - 1000)
    lock.ownerSeen('remontnik')
    clock.advance(OWNER_SILENCE_LIMIT_MS - 1)
    expect(lock.holder('remontnik')).toBe('owner')
    clock.advance(1)
    expect(lock.holder('remontnik')).toBe('doctor')
  })

  it('OWNER_SILENCE_LIMIT_MS — две минуты', () => {
    expect(OWNER_SILENCE_LIMIT_MS).toBe(120_000)
  })
})

describe('ввод владельца', () => {
  it('без взятого управления ввод не доходит до страницы', async () => {
    const lock = createControlLock({ now: fakeClock().now })
    const target = fakeTarget()
    expect(await handleOwnerInput(lock, 'remontnik', { type: 'tap', x: 10, y: 20 }, target)).toMatchObject({ ok: false })
    expect(target.dispatched).toEqual([])
  })

  it('мышь, касание, клавиши и текст доходят при взятом управлении', async () => {
    const lock = createControlLock({ now: fakeClock().now })
    const target = fakeTarget()
    lock.take('remontnik')
    const inputs = [
      { type: 'mouse', action: 'down', x: 1, y: 2, button: 'left' },
      { type: 'mouse', action: 'up', x: 1, y: 2, button: 'left' },
      { type: 'tap', x: 3, y: 4 },
      { type: 'wheel', x: 3, y: 4, dx: 0, dy: 120 },
      { type: 'key', key: 'Enter' },
      { type: 'text', text: 'привет' },
    ]
    for (const input of inputs) expect(await handleOwnerInput(lock, 'remontnik', input, target)).toEqual({ ok: true })
    expect(target.dispatched).toEqual(inputs)
  })

  it('ввод — только мышь, касания, клавиши и текст: переходов и своего кода нет', async () => {
    const lock = createControlLock({ now: fakeClock().now })
    const target = fakeTarget()
    lock.take('remontnik')
    for (const input of [
      { type: 'navigate', url: 'https://evil.example.com/' },
      { type: 'evaluate', code: '1+1' },
      { type: 'mouse', action: 'down', x: 'a', y: 1 },
      { type: 'key', key: 'Enter'.repeat(20) },
      { type: 'text', text: 'x'.repeat(5000) },
      null,
    ]) {
      expect(await handleOwnerInput(lock, 'remontnik', input, target)).toMatchObject({ ok: false, code: 'bad_request' })
    }
    expect(target.dispatched).toEqual([])
  })

  it('связь пропала — ввод владельца больше не принимается', async () => {
    const clock = fakeClock()
    const lock = createControlLock({ now: clock.now })
    const target = fakeTarget()
    lock.take('remontnik')
    clock.advance(OWNER_SILENCE_LIMIT_MS)
    expect(await handleOwnerInput(lock, 'remontnik', { type: 'text', text: 'x' }, target)).toMatchObject({ ok: false })
    expect(target.dispatched).toEqual([])
  })

  it('замки сайтов и запросов не зависят от того, у кого управление', () => {
    const lock = createControlLock({ now: fakeClock().now })
    const policy = { allowedOrigins: ['https://app.example.com'], allowedMutations: [{ method: 'POST', pathPattern: '/login' }] }
    const pay = { method: 'POST', url: 'https://app.example.com/api/pay', isNavigation: false, isMainFrame: false }
    const foreign = { method: 'GET', url: 'https://evil.example.com/', isNavigation: true, isMainFrame: true }
    const before = [decideRequest(pay, policy), decideRequest(foreign, policy)]
    lock.take('remontnik')
    expect([decideRequest(pay, policy), decideRequest(foreign, policy)]).toEqual(before)
    expect(before.map((decision) => decision.allow)).toEqual([false, false])
  })

  it('часы по умолчанию — настоящие', () => {
    vi.useFakeTimers({ now: 5_000_000 })
    try {
      const lock = createControlLock()
      lock.take('remontnik')
      vi.setSystemTime(5_000_000 + OWNER_SILENCE_LIMIT_MS)
      expect(lock.holder('remontnik')).toBe('doctor')
    } finally {
      vi.useRealTimers()
    }
  })
})
