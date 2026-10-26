import { createIncidentEvent, type IncidentEvent } from '@ykurilov/remontnik-core/incident'
import { describe, expect, it } from 'vitest'
import { createMemoryRecordStore } from '../records/index.js'
import { CASE_LINKED_EVENTS_LIMIT, createCaseBook } from './index.js'

const start = Date.parse('2026-10-26T10:00:00Z')

function event(message: string, at = start, kind: IncidentEvent['kind'] = 'crash', appName = 'patient'): IncidentEvent {
  return createIncidentEvent({
    appName,
    kind,
    where: 'src/server.ts:10:5',
    message,
    stack: `Error: ${message}`,
    context: { processName: 'web' },
    occurredAt: new Date(at),
  })
}

describe('книга случаев', () => {
  it('первое событие отпечатка открывает случай с номером по порядку', async () => {
    const book = createCaseBook(createMemoryRecordStore())
    const first = event('order 1 failed')

    const result = await book.recordEvents([first])

    expect(result.accepted).toEqual([first.eventId])
    expect(result.newCases).toHaveLength(1)
    expect(result.newCases[0]).toMatchObject({
      caseId: 1,
      appName: 'patient',
      processName: 'web',
      fingerprint: first.fingerprint,
      kind: 'crash',
      where: first.where,
      message: first.message,
      stack: first.stack,
      events: 1,
      state: 'received',
      firstSeenAt: first.occurredAt,
      lastSeenAt: first.occurredAt,
      linkedEventIds: [first.eventId],
      reportIds: [],
    })
  })

  it('события того же отпечатка склеиваются: счётчик, время, один открытый случай', async () => {
    const book = createCaseBook(createMemoryRecordStore())
    await book.recordEvents([event('order 1 failed')])

    const result = await book.recordEvents([event('order 2 failed', start + 60_000), event('order 3 failed', start + 120_000)])

    expect(result.newCases).toEqual([])
    const opened = await book.openCaseFor(event('order 9 failed').fingerprint, 'patient')
    expect(opened).toMatchObject({ caseId: 1, events: 3, lastSeenAt: new Date(start + 120_000).toISOString() })
    expect(await book.getCase(2)).toBeUndefined()
  })

  it('другой отпечаток — другой случай', async () => {
    const book = createCaseBook(createMemoryRecordStore())

    const result = await book.recordEvents([event('order 1 failed'), event('model down', start, 'model_error')])

    expect(result.newCases.map((item) => item.caseId)).toEqual([1, 2])
  })

  it('повтор eventId безопасен: принят, но не считается дважды', async () => {
    const book = createCaseBook(createMemoryRecordStore())
    const first = event('order 1 failed')
    await book.recordEvents([first])

    const again = await book.recordEvents([first, first])

    expect(again.accepted).toEqual([first.eventId, first.eventId])
    expect(again.newCases).toEqual([])
    expect((await book.getCase(1))?.events).toBe(1)
  })

  it(`linkedEventIds хранит последние ${50}`, async () => {
    expect(CASE_LINKED_EVENTS_LIMIT).toBe(50)
    const book = createCaseBook(createMemoryRecordStore())
    const events = Array.from({ length: 60 }, (_, index) => event(`order ${index} failed`, start + index))
    for (let index = 0; index < events.length; index += 10) await book.recordEvents(events.slice(index, index + 10))

    const opened = await book.getCase(1)

    expect(opened?.events).toBe(60)
    expect(opened?.linkedEventIds).toHaveLength(50)
    expect(opened?.linkedEventIds.at(-1)).toBe(events.at(-1)?.eventId)
    expect(opened?.linkedEventIds[0]).toBe(events[10]?.eventId)
  })

  it('после закрытия случая тот же отпечаток открывает новый', async () => {
    const book = createCaseBook(createMemoryRecordStore())
    await book.recordEvents([event('order 1 failed')])
    await book.setState(1, 'healed')

    const result = await book.recordEvents([event('order 2 failed')])

    expect(result.newCases.map((item) => item.caseId)).toEqual([2])
    expect((await book.openCaseFor(event('x 1 failed').fingerprint, 'patient'))?.caseId).toBeUndefined()
    expect((await book.openCaseFor(event('order 5 failed').fingerprint, 'patient'))?.caseId).toBe(2)
  })

  it('связывает отчёты со случаем', async () => {
    const book = createCaseBook(createMemoryRecordStore())
    await book.recordEvents([event('order 1 failed')])

    await book.linkReport(1, 7)

    expect((await book.getCase(1))?.reportIds).toEqual([7])
  })

  it('тот же отпечаток в другом приложении — другой случай', async () => {
    const book = createCaseBook(createMemoryRecordStore())

    const result = await book.recordEvents([event('order 1 failed'), event('order 1 failed', start, 'crash', 'shop')])

    expect(result.newCases.map((item) => [item.caseId, item.appName])).toEqual([
      [1, 'patient'],
      [2, 'shop'],
    ])
    expect((await book.openCaseFor(result.newCases[0]!.fingerprint, 'shop'))?.caseId).toBe(2)
  })

  it('плохой ответ: случай хранит выдержку и пояснение первого события', async () => {
    const book = createCaseBook(createMemoryRecordStore())
    const badAnswer = { conversationId: 'talk-1', messageIndex: 1, category: 'fabrication', excerpt: 'Тариф «Макс» стоит 5990 ₽.', explanation: 'Тарифа нет.', confidence: 0.9 }
    const first = createIncidentEvent({ appName: 'patient', kind: 'bad_answer', where: 'цены тарифов', message: 'выдумка: цены тарифов', badAnswer, occurredAt: new Date(start) })
    const again = createIncidentEvent({ appName: 'patient', kind: 'bad_answer', where: 'цены тарифов', message: 'выдумка: цены тарифов', badAnswer: { ...badAnswer, conversationId: 'talk-2' }, occurredAt: new Date(start + 1000) })

    await book.recordEvents([first, again])

    expect((await book.getCase(1))?.badAnswer).toEqual(badAnswer)
    expect((await book.getCase(1))?.events).toBe(2)
  })

  it('обычный сбой — без badAnswer', async () => {
    const book = createCaseBook(createMemoryRecordStore())
    await book.recordEvents([event('order 1 failed')])
    expect((await book.getCase(1))?.badAnswer).toBeUndefined()
  })

  it('склеенные сторожем повторы (context.repeats) входят в счётчик', async () => {
    const book = createCaseBook(createMemoryRecordStore())
    const collapsed = { ...event('order 1 failed'), context: { processName: 'web', repeats: 4 } }

    await book.recordEvents([collapsed])

    expect((await book.getCase(1))?.events).toBe(5)
  })

  it('отчёт о новом случае пишется в той же транзакции: сбой отчёта откатывает и случай', async () => {
    const book = createCaseBook(createMemoryRecordStore())
    const first = event('order 1 failed')
    let fail = true
    const onNewCase = async (_tx: unknown, opened: { caseId: number; reportIds: number[] }) => {
      if (fail) throw new Error('reports broken')
      opened.reportIds.push(100 + opened.caseId)
    }

    await expect(book.recordEvents([first], { onNewCase })).rejects.toThrow('reports broken')
    expect(await book.getCase(1)).toBeUndefined()

    fail = false
    const again = await book.recordEvents([first], { onNewCase })

    expect(again.newCases.map((item) => item.reportIds)).toEqual([[101]])
    expect((await book.getCase(1))?.reportIds).toEqual([101])
  })

  it('пачка записывается целиком или никак', async () => {
    const store = createMemoryRecordStore()
    const book = createCaseBook(store)
    const broken = { ...event('order 1 failed'), occurredAt: 'not a date' }

    await expect(book.recordEvents([event('fine 1'), broken])).rejects.toThrow()

    expect(await book.getCase(1)).toBeUndefined()
  })
})
