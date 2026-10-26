import { mkdtempSync, readFileSync, readdirSync, writeFileSync, appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createIncidentEvent, type IncidentEvent } from '@ykurilov/remontnik-core/incident'
import { beforeEach, describe, expect, it } from 'vitest'
import { OUTBOX_RETRY_DELAYS_MS, openOutbox } from './index.js'

const start = Date.parse('2026-10-26T10:00:00Z')
let dir: string

function event(message: string, occurredAt = new Date(start)): IncidentEvent {
  return createIncidentEvent({ appName: 'patient', kind: 'crash', where: 'src/server.ts:1:1', message, occurredAt })
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'remontnik-outbox-'))
})

describe('очередь сторожа', () => {
  it('дописывает событие строкой JSONL синхронно и отдаёт его к отправке', () => {
    const outbox = openOutbox({ dir, processName: 'web', now: () => start })
    const first = event('first')

    outbox.append(first, { notify: true })

    const lines = readFileSync(outbox.file, 'utf8').trim().split('\n')
    expect(lines).toHaveLength(1)
    expect(JSON.parse(lines[0] ?? '')).toMatchObject({ event: { eventId: first.eventId }, state: 'pending', attempts: 0 })
    expect(outbox.due(start).map((entry) => entry.event.eventId)).toEqual([first.eventId])
  })

  it('свой файл на процесс: веб и фоновый работник не мешают друг другу', () => {
    const web = openOutbox({ dir, processName: 'web', now: () => start })
    const worker = openOutbox({ dir, processName: 'worker', now: () => start })

    web.append(event('web'), { notify: false })
    worker.append(event('worker'), { notify: false })

    expect(web.file).not.toBe(worker.file)
    expect(readdirSync(dir).sort()).toEqual(['outbox-web.jsonl', 'outbox-worker.jsonl'])
    expect(web.due(start)).toHaveLength(1)
  })

  it('подтверждённые события больше не отдаются', () => {
    const outbox = openOutbox({ dir, processName: 'web', now: () => start })
    const first = event('first')
    const second = event('second')
    outbox.append(first, { notify: false })
    outbox.append(second, { notify: false })

    outbox.ack([first.eventId])

    expect(outbox.due(start).map((entry) => entry.event.eventId)).toEqual([second.eventId])
    expect(outbox.stats().pending).toBe(1)
  })

  it('переживает переоткрытие: неподтверждённые, попытки и отметка о сообщении на месте', () => {
    const outbox = openOutbox({ dir, processName: 'web', now: () => start })
    const delivered = event('delivered')
    const failing = event('failing')
    const unnotified = event('unnotified')
    outbox.append(delivered, { notify: false })
    outbox.append(failing, { notify: false })
    outbox.append(unnotified, { notify: true })
    outbox.ack([delivered.eventId])
    outbox.recordFailure([failing.eventId], start)
    outbox.markNotified(failing.eventId)

    const reopened = openOutbox({ dir, processName: 'web', now: () => start })

    expect(reopened.stats().pending).toBe(2)
    expect(reopened.due(start).map((entry) => entry.event.eventId)).toEqual([unnotified.eventId])
    expect(reopened.due(start + OUTBOX_RETRY_DELAYS_MS[0]).map((entry) => entry.event.eventId)).toEqual([
      failing.eventId,
      unnotified.eventId,
    ])
    expect(reopened.awaitingNotification().map((entry) => entry.event.eventId)).toEqual([unnotified.eventId])
  })

  it('пропускает оборванную последнюю строку после падения на записи', () => {
    const outbox = openOutbox({ dir, processName: 'web', now: () => start })
    const first = event('first')
    outbox.append(first, { notify: false })
    appendFileSync(outbox.file, '{"event":{"eventId":"broken')

    const reopened = openOutbox({ dir, processName: 'web', now: () => start })

    expect(reopened.due(start).map((entry) => entry.event.eventId)).toEqual([first.eventId])
  })

  it('сжимает файл при старте: подтверждённые старше суток выброшены, ожидающие остались', () => {
    const day = 24 * 60 * 60 * 1000
    const outbox = openOutbox({ dir, processName: 'web', now: () => start })
    const old = event('old')
    const fresh = event('fresh')
    const pending = event('pending')
    outbox.append(old, { notify: false })
    outbox.ack([old.eventId])
    const later = start + day + 1
    const outboxLater = openOutbox({ dir, processName: 'web', now: () => later })
    outboxLater.append(fresh, { notify: false })
    outboxLater.append(pending, { notify: false })
    outboxLater.ack([fresh.eventId])

    const compacted = openOutbox({ dir, processName: 'web', now: () => later + 1 })

    const text = readFileSync(compacted.file, 'utf8')
    expect(text).not.toContain(old.eventId)
    expect(text).toContain(fresh.eventId)
    expect(text).toContain(pending.eventId)
    expect(compacted.due(later + 1).map((entry) => entry.event.eventId)).toEqual([pending.eventId])
  })

  it('повторы через 5 с, 30 с, 2 мин, 10 мин, дальше каждые 10 мин', () => {
    expect(OUTBOX_RETRY_DELAYS_MS).toEqual([5_000, 30_000, 120_000, 600_000])
    const outbox = openOutbox({ dir, processName: 'web', now: () => start })
    const first = event('first')
    outbox.append(first, { notify: false })

    let now = start
    const waits: number[] = []
    for (let attempt = 0; attempt < 6; attempt += 1) {
      outbox.recordFailure([first.eventId], now)
      const next = outbox.nextAttemptAt()
      if (next === null) throw new Error('нет следующей попытки')
      expect(outbox.due(next - 1)).toEqual([])
      expect(outbox.due(next)).toHaveLength(1)
      waits.push(next - now)
      now = next
    }

    expect(waits).toEqual([5_000, 30_000, 120_000, 600_000, 600_000, 600_000])
  })

  it('отдаёт не больше 50 событий за раз', () => {
    const outbox = openOutbox({ dir, processName: 'web', now: () => start })
    for (let index = 0; index < 60; index += 1) outbox.append(event(`event ${index}`), { notify: false })

    expect(outbox.due(start)).toHaveLength(50)
    expect(outbox.due(start, 10)).toHaveLength(10)
  })

  it('чужой мусор в файле не роняет открытие', () => {
    writeFileSync(join(dir, 'outbox-web.jsonl'), 'not json\n{"unknown":true}\n')

    const outbox = openOutbox({ dir, processName: 'web', now: () => start })

    expect(outbox.stats().pending).toBe(0)
  })

  it('имя процесса не выводит файл за пределы папки', () => {
    const outbox = openOutbox({ dir, processName: '../web/../../x', now: () => start })

    expect(outbox.file.startsWith(dir)).toBe(true)
  })
})
