import { describe, expect, it } from 'vitest'
import type { BlockedRequest } from '../guard/index.js'
import { createBlockedJournal } from './blocked-journal.js'

describe('журнал отказов замка', () => {
  it('одинаковые отказы сливаются со счётчиком; в журнал службы — только первый', () => {
    const logged: BlockedRequest[] = []
    const journal = createBlockedJournal((request) => logged.push(request), () => {})
    for (let index = 0; index < 1000; index += 1) journal.record({ code: 'refused_leak', reason: 'соединение с a.test:443' })
    journal.record({ code: 'refused_internal', reason: 'соединение с 10.0.0.1:80' })
    expect(journal.take()).toEqual([
      { code: 'refused_leak', reason: 'соединение с a.test:443 (×1000)' },
      { code: 'refused_internal', reason: 'соединение с 10.0.0.1:80' },
    ])
    expect(logged).toHaveLength(2)
    expect(journal.take()).toEqual([])
  })

  it('разных отказов не больше предела: остальные — одной итоговой записью и одной строкой в журнале', () => {
    const logged: BlockedRequest[] = []
    let overflows = 0
    const journal = createBlockedJournal((request) => logged.push(request), () => (overflows += 1), 3)
    for (let port = 1; port <= 10_000; port += 1) journal.record({ code: 'refused_leak', reason: `соединение с a.test:${port}` })
    const taken = journal.take()
    expect(taken).toHaveLength(4)
    expect(taken[3]).toEqual({ code: 'refused_leak', reason: 'ещё 9997 отказов не записаны: больше 3 разных' })
    expect(logged).toHaveLength(3)
    expect(overflows).toBe(1)

    // После take окно новое: снова пишется первое.
    journal.record({ code: 'refused_leak', reason: 'соединение с a.test:1' })
    expect(logged).toHaveLength(4)
  })
})
