import { mkdtempSync, readFileSync, readdirSync, writeFileSync, appendFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createIncidentEvent, type IncidentEvent } from '@ykurilov/remontnik-core/incident'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OUTBOX_RETRY_DELAYS_MS, openOutbox as openOutboxRaw, type OpenOutboxOptions, type Outbox } from './index.js'

const start = Date.parse('2026-10-26T10:00:00Z')
let dir: string

function event(message: string, occurredAt = new Date(start)): IncidentEvent {
  return createIncidentEvent({ appName: 'patient', kind: 'crash', where: 'src/server.ts:1:1', message, occurredAt })
}

const opened: Outbox[] = []

function openOutbox(options: OpenOutboxOptions): Outbox {
  const outbox = openOutboxRaw(options)
  opened.push(outbox)
  return outbox
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'remontnik-outbox-'))
})

afterEach(() => {
  for (const outbox of opened.splice(0)) outbox.close()
  vi.restoreAllMocks()
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
    expect(readdirSync(dir).filter((name) => name.endsWith('.jsonl')).sort()).toEqual(['outbox-web.jsonl', 'outbox-worker.jsonl'])
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
    outbox.close()

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
    outbox.close()

    const reopened = openOutbox({ dir, processName: 'web', now: () => start })

    expect(reopened.due(start).map((entry) => entry.event.eventId)).toEqual([first.eventId])
  })

  it('подтверждённые сразу уходят из памяти и из файла при сжатии', () => {
    const outbox = openOutbox({ dir, processName: 'web', now: () => start })
    const delivered = event('delivered')
    const pending = event('pending')
    outbox.append(delivered, { notify: false })
    outbox.append(pending, { notify: false })

    outbox.ack([delivered.eventId])

    expect(outbox.stats()).toMatchObject({ pending: 1, stored: 1 })
    outbox.close()
    const compacted = openOutbox({ dir, processName: 'web', now: () => start })
    const text = readFileSync(compacted.file, 'utf8')
    expect(text).not.toContain(delivered.eventId)
    expect(compacted.due(start).map((entry) => entry.event.eventId)).toEqual([pending.eventId])
  })

  it('подтверждённое с неотправленной тревогой ждёт тревоги, потом уходит', () => {
    const outbox = openOutbox({ dir, processName: 'web', now: () => start })
    const crash = event('crash')
    outbox.append(crash, { notify: true })

    outbox.ack([crash.eventId])
    expect(outbox.awaitingNotification().map((entry) => entry.event.eventId)).toEqual([crash.eventId])
    expect(outbox.stats()).toMatchObject({ pending: 0, stored: 1 })

    outbox.markNotified(crash.eventId)
    expect(outbox.stats().stored).toBe(0)
  })

  it('сжимает файл и на ходу, а не только при старте', () => {
    const outbox = openOutbox({ dir, processName: 'web', now: () => start })
    for (let index = 0; index < 3000; index += 1) {
      const item = event(`event ${index}`)
      outbox.append(item, { notify: false })
      outbox.ack([item.eventId])
    }

    const lines = readFileSync(outbox.file, 'utf8').trim().split('\n').filter(Boolean)
    expect(lines.length).toBeLessThan(2100)
  })

  it('потолок очереди: повторы отпечатка склеиваются в счётчик', () => {
    const outbox = openOutbox({ dir, processName: 'web', now: () => start, maxEntries: 3 })
    const same = (index: number) =>
      createIncidentEvent({ appName: 'patient', kind: 'tool_error', where: 'lookupOrder', message: `order ${index} failed` })
    for (let index = 0; index < 3; index += 1) outbox.append(same(index), { notify: false })

    for (let index = 3; index < 10; index += 1) outbox.append(same(index), { notify: false })

    expect(outbox.stats()).toMatchObject({ pending: 3, lost: 0 })
    expect(outbox.due(start).map((entry) => entry.repeats)).toEqual([0, 0, 7])
    outbox.close()
    const reopened = openOutbox({ dir, processName: 'web', now: () => start, maxEntries: 3 })
    expect(reopened.due(start).map((entry) => entry.repeats)).toEqual([0, 0, 7])
  })

  it('потолок очереди: новый отпечаток вытесняет самый старый с пометкой «потеряно N»', () => {
    const outbox = openOutbox({ dir, processName: 'web', now: () => start, maxEntries: 3 })
    const items = Array.from({ length: 5 }, (_, index) => event(`distinct failure ${'x'.repeat(index)}`))
    for (const item of items) outbox.append(item, { notify: false })

    expect(outbox.stats()).toMatchObject({ pending: 3, lost: 2 })
    const due = outbox.due(start)
    expect(due.map((entry) => entry.event.eventId)).toEqual(items.slice(2).map((item) => item.eventId))
    expect(due.map((entry) => entry.lostBefore)).toEqual([0, 1, 1])
    outbox.close()
    const reopened = openOutbox({ dir, processName: 'web', now: () => start, maxEntries: 3 })
    expect(reopened.stats()).toMatchObject({ pending: 3, lost: 2 })
  })

  it('большая очередь не ломает расчёт следующей попытки', () => {
    const outbox = openOutbox({ dir, processName: 'web', now: () => start, maxEntries: 200_000 })
    for (let index = 0; index < 130_000; index += 1) {
      outbox.append(createIncidentEvent({ appName: 'p', kind: 'crash', where: 'w', message: `m ${'y'.repeat(index % 7)}`, eventId: `E${index}` }), { notify: false })
    }

    expect(() => outbox.nextAttemptAt()).not.toThrow()
    expect(() => outbox.stats()).not.toThrow()
  }, 60_000)

  it('второй экземпляр с тем же именем процесса пишет в свой файл и предупреждает', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const first = openOutbox({ dir, processName: 'web', now: () => start })
    const second = openOutbox({ dir, processName: 'web', now: () => start })

    first.append(event('first'), { notify: false })
    second.append(event('second'), { notify: false })

    expect(second.file).not.toBe(first.file)
    expect(errors.mock.calls.some(([line]) => String(line).startsWith('[remontnik]'))).toBe(true)
    expect(first.stats().pending).toBe(1)
    expect(second.stats().pending).toBe(1)
  })

  it('подбирает осиротевший файл второго экземпляра после его смерти', () => {
    const orphan = event('orphan')
    writeFileSync(join(dir, 'outbox-web.dead-1.jsonl'), `${JSON.stringify({ event: orphan, state: 'pending', attempts: 0, nextAttemptAt: 0, notify: true })}\n`)
    writeFileSync(join(dir, 'outbox-web.dead-1.lock'), '999999999:token')

    const outbox = openOutbox({ dir, processName: 'web', now: () => start })

    expect(outbox.due(start).map((entry) => entry.event.eventId)).toEqual([orphan.eventId])
    expect(outbox.awaitingNotification()).toHaveLength(1)
    expect(existsSync(join(dir, 'outbox-web.dead-1.jsonl'))).toBe(false)
  })

  it('после падения процесса (замок с мёртвым номером) файл снова свой', () => {
    writeFileSync(join(dir, 'outbox-web.lock'), '999999999:token')

    const outbox = openOutbox({ dir, processName: 'web', now: () => start })

    expect(outbox.file).toBe(join(dir, 'outbox-web.jsonl'))
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
