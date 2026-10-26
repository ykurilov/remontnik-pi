import { mkdtempSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createIncidentEvent } from '@ykurilov/remontnik-core/incident'
import { signBody } from '@ykurilov/remontnik-core/signed-http'
import { startFakeTelegram, type FakeTelegramServer } from '@ykurilov/remontnik-core/testing'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { startDoctorService, type DoctorService, type DoctorServiceOptions } from './index.js'

const secret = 'shared-test-secret'
let stateDir: string
let telegram: FakeTelegramServer
let services: DoctorService[]

function options(overrides: Partial<DoctorServiceOptions> = {}): DoctorServiceOptions {
  return {
    stateDir,
    sharedSecret: secret,
    listen: { host: '127.0.0.1', port: 0 },
    telegram: { botToken: '123456:test-bot-token', chatId: 'owner-chat', apiBaseUrl: telegram.baseUrl },
    exit: vi.fn(),
    log: () => {},
    ...overrides,
  }
}

async function start(overrides: Partial<DoctorServiceOptions> = {}): Promise<DoctorService> {
  const service = await startDoctorService(options(overrides))
  services.push(service)
  return service
}

async function sendEvents(url: string, events: unknown[]): Promise<Response> {
  const body = JSON.stringify({ events })
  return fetch(`${url}/v1/events`, { method: 'POST', headers: signBody(body, secret), body })
}

async function until(condition: () => boolean | Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error('условие не выполнилось')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

beforeEach(async () => {
  stateDir = mkdtempSync(join(tmpdir(), 'remontnik-doctor-'))
  telegram = await startFakeTelegram()
  services = []
})

afterEach(async () => {
  for (const service of services) await service.close()
  await telegram.close()
})

describe('каркас врача', () => {
  it('секрет владельца совпадает с общим → врач не запускается и не открывает хранилище', async () => {
    await expect(start({ controlSecret: secret })).rejects.toThrow(/совпадает с общим/)
    expect(existsSync(join(stateDir, 'doctor.sqlite'))).toBe(false)
  })

  it('открывает хранилище SQLite в папке состояния и отвечает на /health', async () => {
    const service = await start()

    const health = await (await fetch(`${service.url}/health`)).json()

    expect(existsSync(join(stateDir, 'doctor.sqlite'))).toBe(true)
    expect(health).toMatchObject({ ok: true, harness: 'open', autoDeploy: 'on' })
  })

  it('принятое событие становится случаем с отчётом case_received без лишнего сообщения в Telegram', async () => {
    const service = await start()
    const event = createIncidentEvent({ appName: 'patient', kind: 'crash', where: 'src/a.ts:1:1', message: 'boom' })

    const response = await sendEvents(service.url, [event])

    expect(await response.json()).toEqual({ accepted: [event.eventId] })
    const opened = await service.caseBook.getCase(1)
    expect(opened).toMatchObject({ caseId: 1, fingerprint: event.fingerprint, events: 1 })
    expect(opened?.reportIds).toHaveLength(1)
    expect(await service.reports.get(opened?.reportIds[0] ?? 0)).toMatchObject({ type: 'case_received', caseId: 1, telegram: { state: 'not_needed' } })
    expect(telegram.messages).toEqual([])
  })

  it('случаи переживают перезапуск врача', async () => {
    const first = await start()
    const event = createIncidentEvent({ appName: 'patient', kind: 'crash', where: 'src/a.ts:1:1', message: 'boom' })
    await sendEvents(first.url, [event])
    await first.close()

    const second = await start()
    await sendEvents(second.url, [createIncidentEvent({ appName: 'patient', kind: 'crash', where: 'src/a.ts:1:1', message: 'boom' })])

    expect(await second.caseBook.getCase(1)).toMatchObject({ events: 2 })
  })

  it('припаркованная задача pi-durable — отчёт doctor_problem в Telegram', async () => {
    const service = await start()

    service.handleHarnessReport(new Error('crash loop'), {
      type: 'task_parked',
      task: { id: 'task-1' as never, kind: 'remontnik.treatment', conversationId: 'conv-1' as never },
    })

    await until(() => telegram.messages.length === 1)
    expect(telegram.messages[0]?.text).toContain('remontnik.treatment')
  })

  it('отказ хранилища закрывает Harness — тревога и выход с ненулевым кодом', async () => {
    const exit = vi.fn()
    let failCommits = false
    const service = await start({
      exit,
      wrapStorage: (storage) =>
        new Proxy(storage, {
          get(target, property, receiver) {
            if (property === 'commit' && failCommits) return async () => { throw new Error('disk I/O error') }
            const value = Reflect.get(target, property, receiver)
            return typeof value === 'function' ? value.bind(target) : value
          },
        }),
    })

    failCommits = true
    await sendEvents(service.url, [createIncidentEvent({ appName: 'patient', kind: 'crash', where: 'src/a.ts:1:1', message: 'boom' })])

    await until(() => exit.mock.calls.length === 1)
    expect(exit).toHaveBeenCalledWith(1)
    expect(telegram.messages.some((item) => item.text.includes('disk I/O error'))).toBe(true)
  })
})
