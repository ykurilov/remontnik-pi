import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, writeFileSync, appendFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
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

  describe('перезапуск процесса в том же контейнере (тот же номер процесса, та же папка)', () => {
    const pid = process.pid

    it.each([
      ['замок 0.1.3', `${pid}:oldtoken`],
      ['замок с меткой запуска прошлой жизни', `${pid}:oldtoken:proc:1`],
    ])('%s с нашим номером — основной файл снова свой, без предупреждения', (_name, lock) => {
      const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
      const left = event('left by previous life')
      writeFileSync(join(dir, 'outbox-web.jsonl'), `${JSON.stringify({ event: left, state: 'pending', attempts: 0, nextAttemptAt: 0, notify: true })}\n`)
      writeFileSync(join(dir, 'outbox-web.lock'), lock)

      const outbox = openOutbox({ dir, processName: 'web', now: () => start })

      expect(outbox.file).toBe(join(dir, 'outbox-web.jsonl'))
      expect(outbox.due(start).map((entry) => entry.event.eventId)).toEqual([left.eventId])
      expect(errors).not.toHaveBeenCalled()
      expect(readdirSync(dir).sort()).toEqual(['outbox-web.jsonl', 'outbox-web.lock'])
    })

    it('сироты 0.1.3 с нашим номером подбираются в основной файл', () => {
      writeFileSync(join(dir, 'outbox-web.lock'), `${pid}:main`)
      const orphans = [event('orphan a'), event('orphan b')]
      orphans.forEach((orphan, index) => {
        const name = `outbox-web.${pid}-tok${index}`
        writeFileSync(join(dir, `${name}.jsonl`), `${JSON.stringify({ event: orphan, state: 'pending', attempts: 0, nextAttemptAt: 0, notify: false })}\n`)
        writeFileSync(join(dir, `${name}.lock`), `${pid}:tok${index}`)
      })

      const outbox = openOutbox({ dir, processName: 'web', now: () => start })

      expect(outbox.file).toBe(join(dir, 'outbox-web.jsonl'))
      expect(outbox.due(start).map((entry) => entry.event.eventId).sort()).toEqual(orphans.map((orphan) => orphan.eventId).sort())
      expect(readdirSync(dir).sort()).toEqual(['outbox-web.jsonl', 'outbox-web.lock'])
    })

    it('много перезапусков подряд не плодят файлов', () => {
      for (let restart = 0; restart < 8; restart += 1) {
        const outbox = openOutboxRaw({ dir, processName: 'worker', now: () => start })
        outbox.append(event(`restart ${restart}`), { notify: false })
        // Процесс падает, не сняв замок; следующая жизнь получает тот же номер, а замок остаётся от прошлой.
        writeFileSync(join(dir, 'outbox-worker.lock'), `${pid}:life${restart}:proc:1`)
      }

      expect(readdirSync(dir).sort()).toEqual(['outbox-worker.jsonl', 'outbox-worker.lock'])
      expect(openOutbox({ dir, processName: 'worker', now: () => start }).stats().pending).toBe(8)
    })

    it('замок того же процесса, открытый вторым экземпляром той же копии модуля, держится', () => {
      vi.spyOn(console, 'error').mockImplementation(() => {})
      const first = openOutbox({ dir, processName: 'web', now: () => start })
      const second = openOutbox({ dir, processName: 'web', now: () => start })
      const third = openOutbox({ dir, processName: 'web', now: () => start })

      expect(new Set([first.file, second.file, third.file]).size).toBe(3)
      third.close()
      const fourth = openOutbox({ dir, processName: 'web', now: () => start })
      expect([first.file, second.file]).not.toContain(fourth.file)
    })
  })

  describe('другой живой процесс', () => {
    const loader = fileURLToPath(new URL('../../../../scripts/source-loader/register.mjs', import.meta.url))
    const holderScript = fileURLToPath(new URL('../../test/fixtures/outbox-holder.ts', import.meta.url))
    const children: ChildProcess[] = []

    afterEach(() => {
      for (const child of children.splice(0)) child.kill('SIGKILL')
    })

    function startHolder(): Promise<{ child: ChildProcess; file: string }> {
      const child = spawn(process.execPath, ['--import', loader, '--no-warnings', holderScript], {
        env: { ...process.env, OUTBOX_DIR: dir, OUTBOX_PROCESS: 'web' },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      children.push(child)
      return new Promise((resolve, reject) => {
        let output = ''
        child.stdout!.on('data', (chunk: Buffer) => {
          output += chunk.toString()
          const line = output.split('\n')[0]
          if (output.includes('\n') && line) resolve({ child, file: (JSON.parse(line) as { file: string }).file })
        })
        child.once('exit', (code) => reject(new Error(`держатель очереди вышел с кодом ${code}`)))
      })
    }

    it('живой процесс держит основной файл: мы пишем в свой, его файл не подбираем', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {})
      const holder = await startHolder()

      const outbox = openOutbox({ dir, processName: 'web', now: () => start })

      expect(holder.file).toBe(join(dir, 'outbox-web.jsonl'))
      expect(outbox.file).not.toBe(holder.file)
    }, 20_000)

    it('мы держим основной файл: живой процесс пишет в свой и не подбирает наш', async () => {
      const outbox = openOutbox({ dir, processName: 'web', now: () => start })

      const holder = await startHolder()

      expect(outbox.file).toBe(join(dir, 'outbox-web.jsonl'))
      expect(holder.file).not.toBe(outbox.file)
      expect(existsSync(outbox.file)).toBe(true)
    }, 20_000)

    it('живой процесс с номером из замка, но запущенный позже — замок свободен', async () => {
      const stranger = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
      children.push(stranger)
      // Метка запуска того вида, каким её читает эта система: /proc на Linux, ps на остальных.
      const earlier = existsSync('/proc/self/stat') ? 'proc:1' : 'ps:Thu Jan  1 00:00:00 1970'
      writeFileSync(join(dir, 'outbox-web.lock'), `${stranger.pid}:oldtoken:${earlier}`)
      const orphan = event('orphan')
      writeFileSync(join(dir, 'outbox-web.x-1.jsonl'), `${JSON.stringify({ event: orphan, state: 'pending', attempts: 0, nextAttemptAt: 0, notify: false })}\n`)
      writeFileSync(join(dir, 'outbox-web.x-1.lock'), `${stranger.pid}:x:${earlier}`)

      const outbox = openOutbox({ dir, processName: 'web', now: () => start })

      expect(outbox.file).toBe(join(dir, 'outbox-web.jsonl'))
      expect(outbox.due(start).map((entry) => entry.event.eventId)).toEqual([orphan.eventId])
    })
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
