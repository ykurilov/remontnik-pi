import { mkdtempSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createIncidentEvent } from '@ykurilov/remontnik-core/incident'
import { signBody, signRequest } from '@ykurilov/remontnik-core/signed-http'
import { startFakeTelegram, type FakeTelegramServer } from '@ykurilov/remontnik-core/testing'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GitGuardError } from '../git-guard/index.js'
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
  it('открывает хранилище SQLite в папке состояния и отвечает на /health', async () => {
    const service = await start()

    const health = await (await fetch(`${service.url}/health`)).json()

    expect(existsSync(join(stateDir, 'doctor.sqlite'))).toBe(true)
    expect(health).toMatchObject({ ok: true, harness: 'open', autoDeploy: 'on' })
  })

  it('секрет владельца, равный общему, — не секрет владельца: врач не запускается', async () => {
    await expect(startDoctorService(options({ controlSecret: secret }))).rejects.toThrow(/совпадает с общим/)
    expect(existsSync(join(stateDir, 'doctor.sqlite'))).toBe(false)
  })

  it('стоп-кран: подписанная команда останавливает автовыкатку, /health это показывает и после перезапуска', async () => {
    const service = await start()
    const body = JSON.stringify({ action: 'stop', by: 'telegram' })
    const stop = await fetch(`${service.url}/v1/control/deploys`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...signRequest({ method: 'POST', target: '/v1/control/deploys', body, secret }) },
      body,
    })
    expect(await stop.json()).toEqual({ autoDeploy: 'stopped' })
    await service.close()

    const again = await start()
    expect(await (await fetch(`${again.url}/health`)).json()).toMatchObject({ autoDeploy: 'stopped' })
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

  it('doctor_problem не выносит текст git, адреса и пути origin: сбой git — причина по коду, остальное — без адресов', async () => {
    const lines: string[] = []
    const service = await start({ log: (line) => lines.push(line) })
    const task = { id: 'task-1' as never, kind: 'remontnik.treatment', conversationId: 'conv-1' as never }
    const stderr = 'fatal: unable to access https://owner:pass@git.example.com/owner/app.git/: 403; also git@git.example.com:owner/app.git and /srv/git/app.git'

    service.handleHarnessReport(new Error('шаг выкатки', { cause: new GitGuardError('failed', `git worktree add: ${stderr}`) }), { type: 'task_parked', task })
    service.handleHarnessReport(new Error(`push не прошёл: ${stderr}`), { type: 'task_parked', task })

    await until(() => telegram.messages.length === 2)
    for (const message of telegram.messages) {
      expect(message.text).not.toMatch(/example\.com|app\.git|pass|owner\//)
    }
    expect(telegram.messages[0]?.text).toContain('origin отказал')
    expect(telegram.messages[1]?.text).toContain('push не прошёл')
    // Полный текст остаётся в журнале врача.
    expect(lines.join('\n')).toContain('git.example.com')
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

    // После перезапуска отказ виден и в ленте отчётов; в Telegram тревога второй раз не идёт.
    await service.close()
    const restarted = await start()
    const problems = (await restarted.reports.list({ after: 0, limit: 10 })).filter((report) => report.type === 'doctor_problem')
    expect(problems).toHaveLength(1)
    expect(problems[0]).toMatchObject({ telegram: { state: 'not_needed' } })
    expect(problems[0]?.short).toContain('disk I/O error')
    expect(existsSync(join(stateDir, 'storage-failure.json'))).toBe(false)
  })

  it('тревога об отказе хранилища не ушла → после перезапуска отчёт doctor_problem идёт в Telegram', async () => {
    writeFileSync(join(stateDir, 'storage-failure.json'), JSON.stringify({ at: '2026-10-26T10:00:00.000Z', reason: 'disk I/O error', telegramSent: false }))

    await start()

    await until(() => telegram.messages.some((item) => item.text.includes('отказа хранилища')))
    expect(existsSync(join(stateDir, 'storage-failure.json'))).toBe(false)
  })
})
