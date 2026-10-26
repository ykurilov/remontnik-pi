import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { verifySignedRequest } from '@ykurilov/remontnik-core/signed-http'
import { STOP_DEPLOYS_CALLBACK } from '@ykurilov/remontnik-core/telegram'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createWatch, type Watch, type WatchOptions } from '../index.js'

const secret = 'shared-test-secret'

interface ControlRequest {
  url: string
  body: { action?: unknown; by?: unknown }
  signed: boolean
}

interface FakeDoctor {
  url: string
  requests: ControlRequest[]
  status: number
  close(): Promise<void>
}

async function startFakeDoctor(): Promise<FakeDoctor> {
  const doctor: FakeDoctor = { url: '', requests: [], status: 200, close: async () => {} }
  const server: Server = createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(chunk as Buffer)
    const body = Buffer.concat(chunks).toString('utf8')
    const signed = verifySignedRequest({ method: request.method ?? '', target: request.url ?? '', body, headers: request.headers, secret }).ok
    doctor.requests.push({ url: request.url ?? '', body: JSON.parse(body) as ControlRequest['body'], signed })
    response.writeHead(doctor.status, { 'content-type': 'application/json' })
    response.end(JSON.stringify(doctor.status === 200 ? { autoDeploy: 'stopped' } : { error: 'nope' }))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  doctor.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  doctor.close = () =>
    new Promise<void>((resolve) => {
      server.closeAllConnections()
      server.close(() => resolve())
    })
  return doctor
}

let dir: string
let doctor: FakeDoctor
let watches: Watch[]

function watch(overrides: Partial<WatchOptions> = {}): Watch {
  const created = createWatch({
    appName: 'patient',
    processName: 'web',
    dir,
    doctor: { url: doctor.url, secret },
    telegram: { botToken: '123456:test-bot-token', chatId: '-100500' },
    ...overrides,
  })
  watches.push(created)
  return created
}

const press = (overrides: Record<string, unknown> = {}) => ({
  id: 'query-1',
  data: STOP_DEPLOYS_CALLBACK,
  from: { id: 42, username: 'owner' },
  message: { message_id: 7, chat: { id: -100500 } },
  ...overrides,
})

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'remontnik-stop-button-'))
  doctor = await startFakeDoctor()
  watches = []
})

afterEach(async () => {
  for (const item of watches) item.close()
  await doctor.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('кнопка стоп-крана: handleStopButton', () => {
  it('нажатие в чате тревог — подписанный общим секретом stop врачу и текст для ответа', async () => {
    const text = await watch().handleStopButton(press())

    expect(doctor.requests).toEqual([{ url: '/v1/control/deploys', body: { action: 'stop', by: 'telegram:@owner' }, signed: true }])
    expect(text).toMatch(/автовыкатка остановлена/i)
  })

  it('без имени пользователя врач видит номер нажавшего', async () => {
    await watch().handleStopButton(press({ from: { id: 42 } }))

    expect(doctor.requests[0]?.body.by).toBe('telegram:42')
  })

  it('чат тревог из функции приложения', async () => {
    const text = await watch({ telegram: { botToken: '123456:test-bot-token', chatId: async () => '-100500' } }).handleStopButton(press())

    expect(doctor.requests).toHaveLength(1)
    expect(text).toMatch(/остановлена/i)
  })

  it('нажатие из другого чата врачу не уходит', async () => {
    const text = await watch().handleStopButton(press({ message: { message_id: 7, chat: { id: 777 } } }))

    expect(doctor.requests).toEqual([])
    expect(text).toMatch(/только в чате тревог/i)
  })

  it('нажатие без сообщения (чат неизвестен) врачу не уходит', async () => {
    const text = await watch().handleStopButton(press({ message: undefined }))

    expect(doctor.requests).toEqual([])
    expect(text).toMatch(/только в чате тревог/i)
  })

  it('чат тревог ещё не задан — врачу не уходит', async () => {
    const text = await watch({ telegram: { botToken: '123456:test-bot-token', chatId: async () => null } }).handleStopButton(press())

    expect(doctor.requests).toEqual([])
    expect(text).toMatch(/только в чате тревог/i)
  })

  it('чужая кнопка — null: приложение обрабатывает её само', async () => {
    expect(await watch().handleStopButton(press({ data: 'app:like' }))).toBeNull()
    expect(await watch().handleStopButton(press({ data: undefined }))).toBeNull()
    expect(doctor.requests).toEqual([])
  })

  it('врач отказал — не бросает, текст подсказывает команду из консоли', async () => {
    doctor.status = 401
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})

    const text = await watch().handleStopButton(press())

    expect(text).toMatch(/не получилось/i)
    expect(text).toContain('deploys stop')
    expect(errors).toHaveBeenCalled()
    errors.mockRestore()
  })

  it('врач недоступен — не бросает', async () => {
    const url = doctor.url
    await doctor.close()
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})

    const text = await watch({ doctor: { url, secret } }).handleStopButton(press())

    expect(text).toMatch(/не получилось/i)
    errors.mockRestore()
  })

  it('кривой объект нажатия не роняет приложение', async () => {
    const handle = watch().handleStopButton
    expect(await handle(null)).toBeNull()
    expect(await handle('remontnik:stop')).toBeNull()
    expect(doctor.requests).toEqual([])
  })
})
