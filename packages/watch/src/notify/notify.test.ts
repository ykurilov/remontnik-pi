import { createIncidentEvent, type IncidentEvent } from '@ykurilov/remontnik-core/incident'
import { describe, expect, it } from 'vitest'
import { NOTIFY_REPEAT_AFTER_MS, createIncidentNotifier, formatIncidentAlert } from './index.js'

const start = Date.parse('2026-10-26T10:00:00Z')
const minute = 60_000

function event(message = 'payment provider timeout after 3000 ms', kind: IncidentEvent['kind'] = 'tool_error'): IncidentEvent {
  return createIncidentEvent({ appName: 'patient', kind, where: 'lookupOrder', message, context: { tool: 'lookupOrder' } })
}

describe('склейка сообщений Telegram', () => {
  it('первое появление отпечатка — сообщение', () => {
    const notifier = createIncidentNotifier()

    const decision = notifier.observe(event(), start)

    expect(decision.notify).toBe(true)
    expect(decision.state).toMatchObject({ count: 1, lastNotifiedCount: 1, lastNotifiedAt: start })
  })

  it('50 повторов за 10 минут — одно сообщение, счётчик 50', () => {
    const notifier = createIncidentNotifier()
    let notifications = 0
    let last = notifier.observe(event(), start)
    if (last.notify) notifications += 1
    for (let index = 1; index < 50; index += 1) {
      last = notifier.observe(event(`payment provider timeout after ${3000 + index} ms`), start + index * 12_000)
      if (last.notify) notifications += 1
    }

    expect(notifications).toBe(1)
    expect(last.state.count).toBe(50)
  })

  it('повтор — только через час и при росте счётчика', () => {
    expect(NOTIFY_REPEAT_AFTER_MS).toBe(60 * minute)
    const notifier = createIncidentNotifier()
    notifier.observe(event(), start)
    expect(notifier.observe(event(), start + 59 * minute).notify).toBe(false)

    const repeat = notifier.observe(event(), start + 61 * minute)

    expect(repeat.notify).toBe(true)
    expect(repeat.state).toMatchObject({ count: 3, lastNotifiedCount: 3, lastNotifiedAt: start + 61 * minute })
    expect(notifier.observe(event(), start + 62 * minute).notify).toBe(false)
  })

  it('разные отпечатки считаются отдельно', () => {
    const notifier = createIncidentNotifier()

    expect(notifier.observe(event('first failure'), start).notify).toBe(true)
    expect(notifier.observe(event('second failure', 'model_error'), start).notify).toBe(true)
  })

  it('помнит ограниченное число отпечатков', () => {
    const notifier = createIncidentNotifier({ maxFingerprints: 3 })
    for (let index = 0; index < 10; index += 1) notifier.observe(event(`failure kind ${'x'.repeat(index)}`), start)

    expect(notifier.size()).toBe(3)
  })
})

describe('текст тревоги', () => {
  it('вид сбоя, место, число повторов, приложение и отпечаток', () => {
    const failure = event()
    const text = formatIncidentAlert(failure, { count: 7, firstSeenAt: start, lastSeenAt: start + minute })

    expect(text).toContain('patient')
    expect(text).toContain('tool_error')
    expect(text).toContain('lookupOrder')
    expect(text).toContain('7')
    expect(text).toContain(failure.fingerprint)
    expect(text).toContain('payment provider timeout')
  })

  it('не длиннее предела Telegram', () => {
    const failure = createIncidentEvent({ appName: 'patient', kind: 'crash', where: 'x', message: 'y'.repeat(2000), stack: 'z'.repeat(8000) })

    expect(formatIncidentAlert(failure, { count: 1, firstSeenAt: start, lastSeenAt: start }).length).toBeLessThanOrEqual(4096)
  })
})
