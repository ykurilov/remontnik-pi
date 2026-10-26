import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { createReviewQueue, dayKey, type ReviewJobInput, type ReviewQueue } from './review-queue.js'

const hour = 3_600_000
const start = Date.parse('2026-10-26T10:00:00Z')
let clock = start
let dir: string

function job(id: string): ReviewJobInput {
  return { conversationId: id, finishedAt: clock, messages: [{ role: 'assistant', content: 'ответ' }], meta: {} }
}

function open(options: { usdPerDay?: number; timeZone?: string; stateFile?: string; maxJobs?: number } = {}): ReviewQueue {
  return createReviewQueue({ usdPerDay: 1, now: () => clock, ...options })
}

const cheap = () => 0.1

beforeEach(() => {
  clock = start
  dir = mkdtempSync(join(tmpdir(), 'remontnik-review-queue-'))
})

describe('очередь чтения: порядок и состояния', () => {
  it('отдаёт разговоры по одному в порядке поступления', () => {
    const queue = open()
    queue.enqueue(job('a'))
    queue.enqueue(job('b'))

    const first = queue.next(cheap)
    expect(first?.conversationId).toBe('a')
    queue.finish(first!, { spentUsd: 0.1 })
    expect(queue.next(cheap)?.conversationId).toBe('b')
  })

  it('разговор в работе не отдаётся второй раз; прочитанный получает состояние reviewed', () => {
    const queue = open()
    queue.enqueue(job('a'))

    const taken = queue.next(cheap)!
    expect(taken.state).toBe('reviewing')
    expect(queue.next(cheap)).toBeNull()
    queue.finish(taken, { spentUsd: 0.1 })

    expect(taken.state).toBe('reviewed')
    expect(queue.stats()).toMatchObject({ queued: 0, reviewing: 0, reviewed: 1 })
  })

  it('пустая очередь отдаёт null', () => {
    expect(open().next(cheap)).toBeNull()
  })

  it('потолок очереди: самый старый вытесняется и считается', () => {
    const queue = open({ maxJobs: 2 })
    queue.enqueue(job('a'))
    queue.enqueue(job('b'))
    queue.enqueue(job('c'))

    expect(queue.stats()).toMatchObject({ queued: 2, dropped: 1 })
    expect(queue.next(cheap)?.conversationId).toBe('b')
  })

  it('неудачная попытка возвращает разговор в очередь не раньше срока', () => {
    const queue = open()
    queue.enqueue(job('a'))
    const taken = queue.next(cheap)!

    queue.retryLater(taken, { spentUsd: 0.05, at: clock + 30_000 })
    expect(queue.next(cheap)).toBeNull()
    expect(queue.nextReadyAt()).toBe(clock + 30_000)
    expect(taken.attempts).toBe(1)

    clock += 30_000
    expect(queue.next(cheap)?.conversationId).toBe('a')
  })

  it('отброшенный после неудач разговор считается неудачным, а не прочитанным', () => {
    const queue = open()
    queue.enqueue(job('a'))
    queue.abandon(queue.next(cheap)!, { spentUsd: 0.2 })

    expect(queue.stats()).toMatchObject({ queued: 0, failed: 1, reviewed: 0 })
    expect(queue.stats().spentUsd).toBeCloseTo(0.2)
  })
})

describe('очередь чтения: суточный бюджет', () => {
  it('расход суммируется, и бюджет не превышается: оценка, которая не влезает, откладывает разговор', () => {
    const queue = open({ usdPerDay: 0.25 })
    for (const id of ['a', 'b', 'c', 'd']) queue.enqueue(job(id))

    const read: string[] = []
    for (let taken = queue.next(cheap); taken; taken = queue.next(cheap)) {
      read.push(taken.conversationId)
      queue.finish(taken, { spentUsd: 0.1 })
    }

    expect(read).toEqual(['a', 'b'])
    expect(queue.stats().spentUsd).toBeCloseTo(0.2)
    expect(queue.stats().spentUsd).toBeLessThanOrEqual(0.25)
    expect(queue.stats()).toMatchObject({ queued: 0, deferred: 2 })
  })

  it('отложенные получают состояние deferred_budget и сводку «отложено N» один раз в сутки', () => {
    const queue = open({ usdPerDay: 0.1 })
    for (const id of ['a', 'b', 'c']) queue.enqueue(job(id))
    queue.finish(queue.next(cheap)!, { spentUsd: 0.1 })

    expect(queue.next(cheap)).toBeNull()
    expect(queue.summaryPending()).toBe(true)
    expect(queue.takeDeferredSummary()).toEqual({ day: '2026-10-26', deferred: 2, usdPerDay: 0.1, spentUsd: 0.1 })
    expect(queue.summaryPending()).toBe(false)
    expect(queue.takeDeferredSummary()).toBeNull()

    queue.enqueue(job('d'))
    expect(queue.next(cheap)).toBeNull()
    expect(queue.takeDeferredSummary()).toBeNull()
    expect(queue.stats().deferred).toBe(3)
  })

  it('без отложенных сводки нет', () => {
    const queue = open()
    queue.enqueue(job('a'))
    queue.finish(queue.next(cheap)!, { spentUsd: 0.1 })

    expect(queue.takeDeferredSummary()).toBeNull()
  })

  it('на следующие сутки расход обнуляется, отложенные читаются первыми', () => {
    const queue = open({ usdPerDay: 0.1 })
    queue.enqueue(job('a'))
    queue.enqueue(job('b'))
    queue.finish(queue.next(cheap)!, { spentUsd: 0.1 })
    expect(queue.next(cheap)).toBeNull()
    queue.enqueue(job('fresh'))

    clock += 24 * hour
    const read: string[] = []
    const first = queue.next(cheap)!
    read.push(first.conversationId)

    expect(read).toEqual(['b'])
    expect(queue.stats()).toMatchObject({ spentUsd: 0, deferred: 0 })
    expect(first.state).toBe('reviewing')
  })

  it('сутки считаются по поясу из настройки, а не по UTC', () => {
    // 17:00 UTC в Макассаре (UTC+8) уже 01:00 следующего дня.
    clock = Date.parse('2026-10-26T17:00:00Z')
    expect(dayKey(clock, 'UTC')).toBe('2026-10-26')
    expect(dayKey(clock, 'Asia/Makassar')).toBe('2026-10-27')

    const queue = open({ usdPerDay: 0.1, timeZone: 'Asia/Makassar' })
    queue.enqueue(job('a'))
    queue.finish(queue.next(cheap)!, { spentUsd: 0.1 })
    queue.enqueue(job('b'))
    expect(queue.next(cheap)).toBeNull()

    // 15:59 UTC — ещё те же сутки по Макассару, 16:00 UTC — новые.
    clock = Date.parse('2026-10-27T15:59:00Z')
    expect(queue.next(cheap)).toBeNull()
    clock = Date.parse('2026-10-27T16:00:00Z')
    expect(queue.next(cheap)?.conversationId).toBe('b')
  })

  it('разговор, который не влезает даже в целые сутки, откладывается, а следующий поменьше читается', () => {
    const queue = open({ usdPerDay: 0.2 })
    queue.enqueue(job('huge'))
    queue.enqueue(job('small'))

    const taken = queue.next((candidate) => (candidate.conversationId === 'huge' ? 0.5 : 0.1))
    expect(taken?.conversationId).toBe('small')
    expect(queue.stats().deferred).toBe(1)
  })

  it('неизвестный пояс — ошибка при создании, а не молчаливый UTC', () => {
    expect(() => open({ timeZone: 'Mars/Olympus' })).toThrow()
  })

  it('расход за сутки переживает перезапуск: тот же день продолжается, новый — с нуля', () => {
    const stateFile = join(dir, 'review-web.json')
    const first = open({ usdPerDay: 0.3, stateFile })
    first.enqueue(job('a'))
    first.finish(first.next(cheap)!, { spentUsd: 0.25 })
    expect(existsSync(stateFile)).toBe(true)

    const sameDay = open({ usdPerDay: 0.3, stateFile })
    expect(sameDay.stats().spentUsd).toBeCloseTo(0.25)
    sameDay.enqueue(job('b'))
    expect(sameDay.next(cheap)).toBeNull()

    clock += 24 * hour
    const nextDay = open({ usdPerDay: 0.3, stateFile })
    expect(nextDay.stats().spentUsd).toBe(0)
  })

  it('испорченный файл расхода не ломает очередь: считаем с нуля и сообщаем об ошибке', () => {
    const stateFile = join(dir, 'review-web.json')
    writeFileSync(stateFile, '{ это не json')
    const errors: string[] = []
    const queue = createReviewQueue({ usdPerDay: 1, now: () => clock, stateFile, onError: (what) => errors.push(what) })

    expect(queue.stats().spentUsd).toBe(0)
    expect(errors).toHaveLength(1)
    queue.enqueue(job('a'))
    queue.finish(queue.next(cheap)!, { spentUsd: 0.1 })
    expect(JSON.parse(readFileSync(stateFile, 'utf8'))).toMatchObject({ day: '2026-10-26', usd: 0.1 })
  })
})
