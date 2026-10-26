import { appendFileSync, mkdtempSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { createReviewQueue, dayKey, type ReviewJobInput, type ReviewQueue } from './review-queue.js'

const hour = 3_600_000
const start = Date.parse('2026-10-26T10:00:00Z')
let clock = start
let dir: string

function job(id: string, content = 'ответ'): ReviewJobInput {
  return { conversationId: id, finishedAt: clock, messages: [{ role: 'assistant', content }], meta: {} }
}

function open(
  options: {
    usdPerDay?: number
    timeZone?: string
    spendDir?: string
    maxJobs?: number
    maxBufferedChars?: number
    maxReviewsPerHour?: number
    maxReviewsPerDay?: number
  } = {},
): ReviewQueue {
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
    expect(queue.takeDeferredSummary()).toEqual({
      day: '2026-10-26',
      deferred: 2,
      usdPerDay: 0.1,
      spentUsd: 0.1,
      reason: 'budget',
      maxReviewsPerDay: 1000,
    })
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
    // Вчерашний расход не считается; занят только резерв под чтение «b».
    expect(queue.stats().spentUsd).toBeCloseTo(0.1)
    expect(queue.stats().deferred).toBe(0)
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
    const first = open({ usdPerDay: 0.3, spendDir: dir })
    first.enqueue(job('a'))
    first.finish(first.next(cheap)!, { spentUsd: 0.25 })
    expect(readdirSync(dir)).toEqual(['review-spend-2026-10-26.jsonl'])

    const sameDay = open({ usdPerDay: 0.3, spendDir: dir })
    expect(sameDay.stats().spentUsd).toBeCloseTo(0.25)
    sameDay.enqueue(job('b'))
    expect(sameDay.next(cheap)).toBeNull()

    clock += 24 * hour
    const nextDay = open({ usdPerDay: 0.3, spendDir: dir })
    expect(nextDay.stats().spentUsd).toBe(0)
  })

  it('испорченная строка в учёте не ломает очередь: она пропускается и об ошибке сообщается', () => {
    const errors: string[] = []
    const queue = createReviewQueue({ usdPerDay: 1, now: () => clock, spendDir: dir, onError: (what) => errors.push(what) })
    queue.enqueue(job('a'))
    queue.finish(queue.next(cheap)!, { spentUsd: 0.1 })
    appendFileSync(join(dir, 'review-spend-2026-10-26.jsonl'), '{ это не json\n')

    expect(queue.stats().spentUsd).toBeCloseTo(0.1)
    expect(errors).toHaveLength(1)
  })

  it('два процесса одного приложения с одной папкой учёта делят бюджет', () => {
    const web = open({ usdPerDay: 0.25, spendDir: dir })
    const worker = open({ usdPerDay: 0.25, spendDir: dir })
    web.enqueue(job('a'))
    worker.enqueue(job('b'))
    worker.enqueue(job('c'))

    web.finish(web.next(cheap)!, { spentUsd: 0.1 })
    worker.finish(worker.next(cheap)!, { spentUsd: 0.1 })

    expect(worker.next(cheap)).toBeNull()
    expect(worker.stats()).toMatchObject({ deferred: 1 })
    expect(web.stats().spentUsd).toBeCloseTo(0.2)
  })

  it('бюджет занят уже во время чтения: параллельный процесс видит резерв до ответа модели', () => {
    const web = open({ usdPerDay: 0.15, spendDir: dir })
    const worker = open({ usdPerDay: 0.15, spendDir: dir })
    web.enqueue(job('a'))
    worker.enqueue(job('b'))

    expect(web.next(cheap)).not.toBeNull() // ответа ещё нет
    expect(worker.next(cheap)).toBeNull()
    expect(worker.stats().deferred).toBe(1)
  })
})

describe('очередь чтения: память и лимиты', () => {
  it('потолок по символам: старые вытесняются, пока всё не уместится', () => {
    const queue = open({ maxBufferedChars: 1_000 })
    queue.enqueue(job('a', 'x'.repeat(400)))
    queue.enqueue(job('b', 'x'.repeat(400)))
    queue.enqueue(job('c', 'x'.repeat(400)))

    expect(queue.stats()).toMatchObject({ queued: 2, dropped: 1, bufferedChars: 800 })
    expect(queue.next(cheap)?.conversationId).toBe('b')
  })

  it('один огромный разговор не вытесняет сам себя', () => {
    const queue = open({ maxBufferedChars: 100 })
    queue.enqueue(job('big', 'x'.repeat(5_000)))

    expect(queue.stats()).toMatchObject({ queued: 1, dropped: 0 })
  })

  it('часовой лимит чтений: разговоры ждут часа, ничего не теряется', () => {
    const queue = open({ maxReviewsPerHour: 2 })
    for (const id of ['a', 'b', 'c']) queue.enqueue(job(id))
    for (let index = 0; index < 2; index += 1) queue.finish(queue.next(cheap)!, { spentUsd: 0.01 })

    expect(queue.next(cheap)).toBeNull()
    expect(queue.nextReadyAt()).toBe(start + hour)
    expect(queue.stats()).toMatchObject({ queued: 1, deferred: 0 })

    clock = start + hour
    expect(queue.next(cheap)?.conversationId).toBe('c')
  })

  it('суточный лимит чтений откладывает до новых суток и называется в сводке', () => {
    const queue = open({ maxReviewsPerDay: 1 })
    queue.enqueue(job('a'))
    queue.enqueue(job('b'))
    queue.finish(queue.next(cheap)!, { spentUsd: 0.01 })

    expect(queue.next(cheap)).toBeNull()
    expect(queue.takeDeferredSummary()).toMatchObject({ deferred: 1, reason: 'daily_limit', maxReviewsPerDay: 1 })
  })

  it('номер, с которого читать, сохраняется в задании', () => {
    const queue = open()
    queue.enqueue({ ...job('a'), reviewFrom: 4 })

    expect(queue.next(cheap)?.reviewFrom).toBe(4)
  })
})
