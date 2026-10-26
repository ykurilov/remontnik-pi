import { describe, expect, it } from 'vitest'
import { createAttemptLimiter } from './attempts.js'

describe('ограничение неудачных попыток ключа', () => {
  it('считает ошибки отдельно по адресу клиента: чужие ошибки не блокируют владельца', () => {
    let now = 1_000_000
    const limiter = createAttemptLimiter({ limit: 3, windowMs: 60_000, now: () => now })
    for (let attempt = 0; attempt < 3; attempt++) limiter.fail('10.0.0.9')
    expect(limiter.blocked('10.0.0.9')).toBe(true)
    expect(limiter.blocked('10.0.0.2')).toBe(false)
    now += 60_000
    expect(limiter.blocked('10.0.0.9')).toBe(false)
  })

  it('старые адреса забываются: память не растёт', () => {
    let now = 0
    const limiter = createAttemptLimiter({ limit: 3, windowMs: 1000, now: () => now })
    for (let address = 0; address < 100; address++) limiter.fail(`10.0.1.${address}`)
    now += 1000
    limiter.fail('10.0.2.1')
    expect(limiter.size()).toBe(1)
  })
})
