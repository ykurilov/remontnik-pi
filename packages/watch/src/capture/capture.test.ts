import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, existsSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { IncidentEvent } from '@ykurilov/remontnik-core/incident'
import { verifySignedBody } from '@ykurilov/remontnik-core/signed-http'
import { startFakeTelegram, type FakeTelegramServer } from '@ykurilov/remontnik-core/testing'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { openOutbox } from '../outbox/index.js'
import { createWatch, type Watch, type WatchOptions } from './index.js'

const secret = 'shared-test-secret'
const botToken = '123456:test-bot-token'
const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url))
const loader = join(repoRoot, 'scripts/source-loader/register.mjs')
const crashingApp = join(repoRoot, 'packages/watch/test/fixtures/crashing-app.ts')

interface FakeDoctor {
  url: string
  batches: IncidentEvent[][]
  signatureFailures: number
  /** Сколько следующих запросов получат 503. */
  failNext: number
  /** Пауза перед ответом. */
  delayMs: number
  close(): Promise<void>
}

async function startFakeDoctor(): Promise<FakeDoctor> {
  const doctor: FakeDoctor = { url: '', batches: [], signatureFailures: 0, failNext: 0, delayMs: 0, close: async () => {} }
  const server: Server = createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(chunk as Buffer)
    const body = Buffer.concat(chunks).toString('utf8')
    if (doctor.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, doctor.delayMs))
    if (doctor.failNext > 0) {
      doctor.failNext -= 1
      response.writeHead(503).end()
      return
    }
    if (!verifySignedBody({ body, headers: request.headers, secret }).ok || request.url !== '/v1/events') {
      doctor.signatureFailures += 1
      response.writeHead(401).end()
      return
    }
    const { events } = JSON.parse(body) as { events: IncidentEvent[] }
    doctor.batches.push(events)
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ accepted: events.map((item) => item.eventId) }))
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
let telegram: FakeTelegramServer
let doctor: FakeDoctor
let watches: Watch[]

function watchOptions(overrides: Partial<WatchOptions> = {}): WatchOptions {
  return {
    appName: 'patient',
    processName: 'web',
    dir,
    doctor: { url: doctor.url, secret },
    telegram: { botToken, chatId: 'owner-chat', apiBaseUrl: telegram.baseUrl },
    appRoot: repoRoot,
    ...overrides,
  }
}

function openWatch(overrides: Partial<WatchOptions> = {}): Watch {
  const watch = createWatch(watchOptions(overrides))
  watches.push(watch)
  return watch
}

async function until(condition: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('условие не выполнилось')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'remontnik-watch-'))
  telegram = await startFakeTelegram()
  doctor = await startFakeDoctor()
  watches = []
})

afterEach(async () => {
  for (const watch of watches) watch.close()
  vi.restoreAllMocks()
  await telegram.close()
  await doctor.close()
})

describe('capture', () => {
  it('пишет событие в очередь синхронно и не ходит в сеть в горячем пути', async () => {
    const fetchSpy = vi.fn(globalThis.fetch)
    const watch = openWatch({ fetch: fetchSpy })

    const eventId = watch.capture(new Error('order 17 not found'), { kind: 'tool_error', where: 'lookupOrder' })

    expect(eventId).toMatch(/^[0-9A-Z]{26}$/)
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(readFileSync(join(dir, 'outbox-web.jsonl'), 'utf8')).toContain(eventId)
    await until(() => doctor.batches.length === 1 && telegram.messages.length === 1)
    expect(fetchSpy).toHaveBeenCalled()
  })

  it('отправляет врачу подписанную пачку и подтверждает принятое', async () => {
    const watch = openWatch()

    const eventId = watch.capture(new Error('model overloaded'), { kind: 'model_error', context: { model: 'm', provider: 'p' } })
    await until(() => doctor.batches.length === 1)

    const [received] = doctor.batches[0] ?? []
    expect(received).toMatchObject({ eventId, appName: 'patient', kind: 'model_error', context: { processName: 'web', model: 'm' } })
    expect(doctor.signatureFailures).toBe(0)
    await until(() => watch.stats().queue.pending === 0)
  })

  it('место — первая строка следа внутри кода приложения', async () => {
    const watch = openWatch()

    watch.capture(new Error('boom'), { kind: 'manual' })
    await until(() => doctor.batches.length === 1)

    expect(doctor.batches[0]?.[0]?.where).toMatch(/^packages\/watch\/src\/capture\/capture\.test\.ts:\d+:\d+/)
  })

  it('одно сообщение Telegram на отпечаток, врачу — каждое появление', async () => {
    const watch = openWatch()

    for (let index = 0; index < 5; index += 1) watch.capture(new Error(`order ${index} failed`), { kind: 'tool_error', where: 'lookupOrder' })
    expect(await watch.flush(3000)).toBe(true)

    expect(telegram.messages).toHaveLength(1)
    expect(telegram.messages[0]).toMatchObject({ chatId: 'owner-chat', botToken })
    expect(doctor.batches.flat()).toHaveLength(5)
  })

  it('чат Telegram можно отдать функцией приложения', async () => {
    const watch = openWatch({ telegram: { botToken, chatId: async () => 'chat-from-db', apiBaseUrl: telegram.baseUrl } })

    watch.capture(new Error('x'))
    await until(() => telegram.messages.length === 1)

    expect(telegram.messages[0]?.chatId).toBe('chat-from-db')
  })

  it('вычищает секреты и личные данные до очереди и сообщения', async () => {
    const key = `sk-${'a1B2'.repeat(6)}`
    const watch = openWatch({ redact: (text) => text.replaceAll('Иван', '[имя]') })

    watch.capture(new Error(`call failed with ${key} for Иван, mail ivan@example.com, phone +7 999 123-45-67`))
    expect(await watch.flush(3000)).toBe(true)

    const everything = readFileSync(join(dir, 'outbox-web.jsonl'), 'utf8') + JSON.stringify(doctor.batches) + JSON.stringify(telegram.messages)
    for (const leaked of [key, 'Иван', 'ivan@example.com', '123-45-67']) expect(everything).not.toContain(leaked)
    expect(telegram.messages[0]?.text).toContain('[ключ]')
  })

  it('врач недоступен — сообщение уходит, событие ждёт и доходит потом', async () => {
    doctor.failNext = 1
    const watch = openWatch()

    watch.capture(new Error('db timeout'))
    await until(() => telegram.messages.length === 1)
    await until(() => watch.stats().queue.failedAttempts === 1)
    expect(doctor.batches).toHaveLength(0)

    expect(await watch.flush(3000)).toBe(true)
    expect(doctor.batches.flat()).toHaveLength(1)
  })

  it('тревога о падении, записанном прошлым процессом, уходит при старте', async () => {
    const before = openOutbox({ dir, processName: 'web' })
    const { createIncidentEvent } = await import('@ykurilov/remontnik-core/incident')
    before.append(createIncidentEvent({ appName: 'patient', kind: 'crash', where: 'src/x.ts:1:1', message: 'crashed' }), { notify: true })
    before.close()

    const watch = openWatch()
    await until(() => telegram.messages.length === 1 && doctor.batches.length === 1)

    expect(telegram.messages[0]?.text).toContain('crash')
    expect(await watch.flush(3000)).toBe(true)
    watch.close()
    const after = openOutbox({ dir, processName: 'web' })
    expect(after.awaitingNotification()).toHaveLength(0)
    after.close()
  })

  it('остатки прошлого процесса склеиваются по отпечатку: одна тревога со счётчиком', async () => {
    const before = openOutbox({ dir, processName: 'web' })
    const { createIncidentEvent } = await import('@ykurilov/remontnik-core/incident')
    for (let index = 0; index < 3; index += 1) {
      before.append(createIncidentEvent({ appName: 'patient', kind: 'crash', where: 'src/x.ts:1:1', message: `crashed on ${index}` }), { notify: true })
    }
    before.close()

    const watch = openWatch()
    expect(await watch.flush(3000)).toBe(true)

    expect(telegram.messages).toHaveLength(1)
    expect(telegram.messages[0]?.text).toContain('Повторов: 3')
    watch.close()
    const after = openOutbox({ dir, processName: 'web' })
    expect(after.awaitingNotification()).toHaveLength(0)
    after.close()
  })

  it('сломанная очередь посреди работы не роняет приложение', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown) => unhandled.push(reason)
    process.on('unhandledRejection', onUnhandled)
    try {
      const watch = openWatch()
      watch.capture(new Error('first'))
      // Файл очереди становится папкой: любая запись в него бросает.
      rmSync(join(dir, 'outbox-web.jsonl'))
      mkdirSync(join(dir, 'outbox-web.jsonl'))

      await until(() => doctor.batches.length >= 1)
      await expect(watch.flush(500)).resolves.toBeTypeOf('boolean')
      await new Promise((resolve) => setTimeout(resolve, 100))

      expect(unhandled).toEqual([])
      expect(watch.stats().ownErrors).toBeGreaterThan(0)
      expect(errors.mock.calls.some(([line]) => String(line).startsWith('[remontnik]'))).toBe(true)
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })

  it('flush по сроку не запускает вторую доставку тех же событий', async () => {
    doctor.delayMs = 400
    const watch = openWatch()
    watch.capture(new Error('slow doctor'))

    expect(await watch.flush(50)).toBe(false)
    expect(await watch.flush(3000)).toBe(true)

    expect(doctor.batches.flat()).toHaveLength(1)
  })

  it('потолок очереди: повторы склеены, врач получает счётчик повторов', async () => {
    const watch = openWatch({ maxQueue: 2 })

    for (let index = 0; index < 5; index += 1) watch.capture(new Error(`order ${index} failed`), { kind: 'tool_error', where: 'lookupOrder' })
    expect(watch.stats().queue.pending).toBe(2)
    expect(await watch.flush(3000)).toBe(true)

    const received = doctor.batches.flat()
    expect(received).toHaveLength(2)
    expect(received.map((item) => item.context.repeats ?? 0)).toEqual([0, 3])
  })

  it('свои ошибки — строка [remontnik] без случая, приложение не падает', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    telegram.failNext(500)
    const watch = openWatch()

    watch.capture(new Error('real failure'))
    await until(() => errors.mock.calls.some(([line]) => String(line).startsWith('[remontnik]')))
    expect(await watch.flush(3000)).toBe(true)

    expect(doctor.batches.flat()).toHaveLength(1)
    expect(watch.stats().ownErrors).toBeGreaterThan(0)
  })

  it('непригодная папка очереди не роняет приложение', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const file = join(dir, 'not-a-directory')
    writeFileSync(file, 'x')

    const watch = openWatch({ dir: join(file, 'nested') })

    expect(() => watch.capture(new Error('x'))).not.toThrow()
    expect(errors.mock.calls.some(([line]) => String(line).startsWith('[remontnik]'))).toBe(true)
  })

  it.each([
    ['dir', { dir: undefined }],
    ['doctor.url', { doctor: { url: undefined, secret } }],
    ['doctor.secret', { doctor: { url: 'http://127.0.0.1:1', secret: undefined } }],
    ['telegram.botToken', { telegram: { botToken: undefined, chatId: 'owner-chat' } }],
    ['telegram.chatId', { telegram: { botToken, chatId: undefined } }],
  ])('без поля %s createWatch бросает TypeError с его названием', (field, broken) => {
    expect(() => createWatch(watchOptions(broken as unknown as Partial<WatchOptions>))).toThrow(TypeError)
    expect(() => createWatch(watchOptions(broken as unknown as Partial<WatchOptions>))).toThrow(field)
  })

  it('stats показывает очередь', () => {
    const watch = openWatch({ doctor: { url: 'http://127.0.0.1:9', secret } })

    watch.capture(new Error('x'))

    expect(watch.stats()).toMatchObject({ queue: { pending: 1 } })
  })
})

describe('wrapModelCatalog', () => {
  class FakeModel {
    readonly #fail: boolean
    readonly modelId = 'fake-model'
    constructor(fail: boolean) {
      this.#fail = fail
    }
    get provider(): string {
      return 'fake-provider.chat'
    }
    async doGenerate(): Promise<{ text: string }> {
      if (this.#fail) throw new Error('503 overloaded, request 9f8e7d6c5b4a')
      return { text: 'ok' }
    }
    async doStream(): Promise<{ stream: ReadableStream<{ type: string; error?: unknown }> }> {
      return {
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: 'text-delta' })
            controller.enqueue({ type: 'error', error: new Error('stream broke') })
            controller.close()
          },
        }),
      }
    }
  }

  function catalog(fail: boolean) {
    return {
      models: [{ id: 'fake-model' }],
      providers: [{ id: 'fake', createLanguageModel: (_id: string, _key: string) => new FakeModel(fail) }],
    }
  }

  it('ошибка обращения к модели — model_error с моделью и поставщиком, ошибка идёт дальше как была', async () => {
    const watch = openWatch()
    const wrapped = watch.wrapModelCatalog(catalog(true))
    const model = wrapped.providers[0]!.createLanguageModel('fake-model', 'key')

    await expect(model.doGenerate()).rejects.toThrow('503 overloaded')
    await until(() => doctor.batches.length === 1)

    expect(doctor.batches[0]?.[0]).toMatchObject({ kind: 'model_error', context: { model: 'fake-model', provider: 'fake' } })
    expect(model.provider).toBe('fake-provider.chat')
  })

  it('отмена запроса («Стоп») — не сбой', async () => {
    class AbortingModel {
      async doGenerate(): Promise<never> {
        throw new DOMException('This operation was aborted', 'AbortError')
      }
    }
    const watch = openWatch()
    const model = watch
      .wrapModelCatalog({ models: [], providers: [{ id: 'fake', createLanguageModel: () => new AbortingModel() }] })
      .providers[0]!.createLanguageModel()

    await expect(model.doGenerate()).rejects.toThrow('aborted')
    await new Promise((resolve) => setTimeout(resolve, 50))

    expect(watch.stats().queue.pending).toBe(0)
    expect(doctor.batches).toEqual([])
  })

  it('каталог-экземпляр класса сохраняет прототип и методы', async () => {
    class Provider {
      readonly id = 'fake'
      createLanguageModel(_id: string, _key: string) {
        return new FakeModel(true)
      }
      describe() {
        return `provider ${this.id}`
      }
    }
    class Catalog {
      readonly models = [{ id: 'fake-model' }]
      readonly providers = [new Provider()]
      count() {
        return this.models.length
      }
    }
    const watch = openWatch()

    const wrapped = watch.wrapModelCatalog(new Catalog())

    expect(wrapped).toBeInstanceOf(Catalog)
    expect(wrapped.count()).toBe(1)
    expect(wrapped.providers[0]).toBeInstanceOf(Provider)
    expect(wrapped.providers[0]!.describe()).toBe('provider fake')
    await expect(wrapped.providers[0]!.createLanguageModel('fake-model', 'key').doGenerate()).rejects.toThrow('503')
    await until(() => doctor.batches.length === 1)
  })

  it('удачный ответ не трогает, ошибка в потоке — model_error', async () => {
    const watch = openWatch()
    const model = watch.wrapModelCatalog(catalog(false)).providers[0]!.createLanguageModel('fake-model', 'key')

    await expect(model.doGenerate()).resolves.toEqual({ text: 'ok' })
    const { stream } = await model.doStream()
    const parts: string[] = []
    for await (const part of stream) parts.push(part.type)
    await until(() => doctor.batches.length === 1)

    expect(parts).toEqual(['text-delta', 'error'])
    expect(doctor.batches[0]?.[0]).toMatchObject({ kind: 'model_error', message: 'stream broke' })
  })
})

describe('installProcessHandlers: поведение процесса как без сторожа', () => {
  function runCrashingApp(mode: string) {
    const watchDir = mkdtempSync(join(tmpdir(), 'remontnik-crash-'))
    const result = spawnSync(process.execPath, ['--import', loader, '--no-warnings', crashingApp], {
      env: { ...process.env, REMONTNIK_WATCH_DIR: watchDir, CRASH_MODE: mode },
      encoding: 'utf8',
      timeout: 20_000,
    })
    const outboxFile = join(watchDir, 'outbox-web.jsonl')
    const outbox = existsSync(outboxFile) ? readFileSync(outboxFile, 'utf8') : ''
    return { ...result, outbox }
  }

  it('необработанная ошибка: случай записан, процесс падает с кодом 1 и следом в stderr', () => {
    const run = runCrashingApp('throw')

    expect(run.status).toBe(1)
    expect(run.stderr).toContain('crashed on order 41')
    expect(run.outbox).toContain('"kind":"crash"')
    expect(run.outbox).toContain('"notify":true')
  })

  it('необработанный отказ промиса: случай записан, процесс падает с кодом 1', () => {
    const run = runCrashingApp('rejection')

    expect(run.status).toBe(1)
    expect(run.stderr).toContain('rejected order 42')
    expect(run.outbox).toContain('rejected order <n>'.replace('<n>', '42'))
    expect(run.outbox.match(/"kind":"crash"/g)).toHaveLength(1)
  })

  it('свой обработчик приложения работает как раньше, случай записан', () => {
    const run = runCrashingApp('own-handler')

    expect(run.status).toBe(0)
    expect(run.stdout).toContain('app handled: crashed on order 41')
    expect(run.stdout).toContain('still alive')
    expect(run.outbox).toContain('crashed on order 41')
  })

  it('одна и та же ошибка-константа, брошенная дважды, — два падения', () => {
    const run = runCrashingApp('same-error-twice')

    expect(run.status).toBe(0)
    expect(run.outbox.match(/"kind":"crash"/g)).toHaveLength(2)
  })

  it('свой обработчик отказов приложения работает как раньше, случай записан', () => {
    const run = runCrashingApp('rejection-own-handler')

    expect(run.status).toBe(0)
    expect(run.stdout).toContain('app handled rejection: rejected order 43')
    expect(run.outbox).toContain('rejected order 43')
  })
})
