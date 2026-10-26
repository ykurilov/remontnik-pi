import { mkdtempSync, readdirSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defineRemontnikConfig } from '@ykurilov/remontnik-core/config'
import type { IncidentEvent } from '@ykurilov/remontnik-core/incident'
import { verifySignedBody } from '@ykurilov/remontnik-core/signed-http'
import { startFakeModel, startFakeTelegram, type FakeModelServer, type FakeTelegramServer } from '@ykurilov/remontnik-core/testing'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createWatch, type Watch, type WatchOptions } from '../capture/index.js'
import { BOT_DESCRIPTION } from '../../test/fixtures/conversations.js'

// `watch.conversationFinished`: законченный разговор → чтение в фоне → событие `bad_answer` врачу и тревога владельцу.

const PLACES = ['цены тарифов', 'тон ответа']
const secret = 'shared-test-secret'
const botToken = '123456:test-bot-token'

interface FakeDoctor {
  url: string
  events: IncidentEvent[]
  close(): Promise<void>
}

async function startFakeDoctor(): Promise<FakeDoctor> {
  const doctor: FakeDoctor = { url: '', events: [], close: async () => {} }
  const server: Server = createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(chunk as Buffer)
    const body = Buffer.concat(chunks).toString('utf8')
    if (!verifySignedBody({ body, headers: request.headers, secret }).ok) {
      response.writeHead(401).end()
      return
    }
    const { events } = JSON.parse(body) as { events: IncidentEvent[] }
    doctor.events.push(...events)
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

let telegram: FakeTelegramServer
let model: FakeModelServer
let doctor: FakeDoctor
let dir: string
const watches: Watch[] = []

function openWatch(overrides: Partial<WatchOptions> = {}): Watch {
  const watch = createWatch({
    appName: 'patient',
    processName: 'web',
    dir,
    doctor: { url: doctor.url, secret },
    telegram: { botToken, chatId: 'owner-chat', apiBaseUrl: telegram.baseUrl },
    model: {
      primary: { baseUrl: model.baseUrl, apiKey: 'test-primary-key', model: 'deepseek-flash' },
      fallback: { baseUrl: model.baseUrl, apiKey: 'test-fallback-key', model: 'deepseek/deepseek-v4.1-flash-1017' },
    },
    review: { botDescription: BOT_DESCRIPTION, limits: { watchModelUsdPerDay: 1 }, summaryDelayMs: 30, places: PLACES },
    ...overrides,
  })
  watches.push(watch)
  return watch
}

const talk = (price: string, tail = '') => [
  { role: 'user' as const, content: 'Сколько стоит тариф Макс? Пишите на ivan@example.com' },
  { role: 'assistant' as const, content: `Тариф «Макс» стоит ${price} ₽ в месяц.${tail}` },
]

const fabrication = (excerpt: string) => ({
  findings: [
    { messageIndex: 1, category: 'fabrication', place: 'цены тарифов', excerpt, explanation: 'Такого тарифа нет.', confidence: 0.95 },
  ],
})

async function until(condition: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('условие не выполнилось')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

beforeEach(async () => {
  telegram = await startFakeTelegram()
  model = await startFakeModel()
  doctor = await startFakeDoctor()
  dir = mkdtempSync(join(tmpdir(), 'remontnik-review-watch-'))
})

afterEach(async () => {
  for (const watch of watches.splice(0)) watch.close()
  await Promise.all([telegram.close(), model.close(), doctor.close()])
})

describe('watch.conversationFinished', () => {
  it('плохой ответ становится событием bad_answer у врача с полями badAnswer', async () => {
    const watch = openWatch()
    model.replyNext(fabrication('Тариф «Макс» стоит 5990 ₽'))

    watch.conversationFinished({ id: 'talk-1', messages: talk('5990'), meta: { chatId: 'chat-7' } })
    await until(() => doctor.events.length === 1)

    expect(doctor.events[0]).toMatchObject({
      appName: 'patient',
      kind: 'bad_answer',
      context: { processName: 'web', chatId: 'chat-7' },
      badAnswer: { conversationId: 'talk-1', messageIndex: 1, category: 'fabrication', confidence: 0.95 },
    })
    expect(doctor.events[0]?.badAnswer?.excerpt).toContain('5990')
    expect(doctor.events[0]?.badAnswer?.explanation).toBe('Такого тарифа нет.')
    expect(doctor.events[0]?.fingerprint).toMatch(/^[0-9a-f]{16}$/)
    expect(await watch.flush(2000)).toBe(true)
  })

  it('вызов мгновенный: до его возвращения нет ни запроса к модели, ни записи в очередь', () => {
    const watch = openWatch()

    const startedAt = performance.now()
    watch.conversationFinished({ id: 'talk-1', messages: talk('5990') })

    expect(performance.now() - startedAt).toBeLessThan(20)
    expect(model.requests).toHaveLength(0)
    expect(watch.stats().queue.pending).toBe(0)
  })

  it('одна и та же ошибка в трёх разговорах: три события с одним отпечатком и одна тревога', async () => {
    const watch = openWatch()
    for (const excerpt of ['Тариф «Макс»', 'стоит 5990 ₽', 'в месяц']) model.replyNext(fabrication(excerpt))

    for (const id of ['a', 'b', 'c']) watch.conversationFinished({ id, messages: talk('5990') })
    await until(() => doctor.events.length === 3)

    expect(new Set(doctor.events.map((event) => event.fingerprint)).size).toBe(1)
    expect(doctor.events.map((event) => event.badAnswer?.conversationId).sort()).toEqual(['a', 'b', 'c'])
    await until(() => telegram.messages.length >= 1)
    expect(telegram.messages).toHaveLength(1)
    expect(telegram.messages[0]?.text).toContain('выдумка')
    expect(telegram.messages[0]?.text).toContain('Ответ бота')
  })

  it('разные виды нарушений — разные отпечатки', async () => {
    const watch = openWatch()
    model.replyNext(fabrication('Тариф «Макс»'))
    model.replyNext({
      findings: [{ messageIndex: 1, category: 'rudeness', place: 'тон ответа', excerpt: 'стоит 5990', explanation: 'Грубит.', confidence: 0.9 }],
    })

    watch.conversationFinished({ id: 'a', messages: talk('5990') })
    watch.conversationFinished({ id: 'b', messages: talk('5990') })
    await until(() => doctor.events.length === 2)

    expect(new Set(doctor.events.map((event) => event.fingerprint)).size).toBe(2)
  })

  it('личные данные из разговора не попадают ни в запрос модели, ни в событие, ни в тревогу', async () => {
    const watch = openWatch()
    // Модель видит уже замаскированный текст, поэтому и цитирует его так.
    model.replyNext(fabrication('Пишите на [почта]'))

    watch.conversationFinished({ id: 'talk-1', messages: talk('5990', ' Пишите на ivan@example.com') })
    await until(() => doctor.events.length === 1)
    await until(() => telegram.messages.length === 1)

    const everything = JSON.stringify([model.requests, doctor.events, telegram.messages])
    expect(everything).not.toContain('ivan@example.com')
  })

  it('выдержка длиннее предела в событии обрезана до 500 символов', async () => {
    const watch = openWatch()
    model.replyNext(fabrication('я'.repeat(400)))

    watch.conversationFinished({ id: 'talk-1', messages: talk('5990', ` ${'я'.repeat(400)}`) })
    await until(() => doctor.events.length === 1)

    expect(doctor.events[0]?.badAnswer?.excerpt.length).toBeLessThanOrEqual(500)
  })

  it('бюджет исчерпан: лишние разговоры не читаются, владелец получает «отложено N»', async () => {
    const watch = openWatch({ review: { botDescription: BOT_DESCRIPTION, limits: { watchModelUsdPerDay: 0.0035 }, summaryDelayMs: 30 } })
    model.replyNext({ findings: [] }, { costUsd: 0.003 })

    for (const id of ['a', 'b', 'c']) watch.conversationFinished({ id, messages: talk('5990') })
    await until(() => telegram.messages.some((message) => message.text.includes('отложено 2')))

    expect(model.requests).toHaveLength(1)
    expect(watch.stats().review).toMatchObject({ reviewed: 1, deferred: 2 })
    expect(watch.stats().review?.spentUsd).toBeLessThanOrEqual(0.0035)
    expect(telegram.messages.filter((message) => message.text.includes('отложено'))).toHaveLength(1)
  })

  it('модель недоступна: приложению ничего не прилетает, сбои чтения — в журнале сторожа, не случаями', async () => {
    const watch = openWatch({ model: { primary: { baseUrl: 'http://127.0.0.1:9', apiKey: 'k', model: 'm' }, fallback: { baseUrl: 'http://127.0.0.1:9', apiKey: 'k', model: 'm' } } })

    expect(() => watch.conversationFinished({ id: 'talk-1', messages: talk('5990') })).not.toThrow()
    await new Promise((resolve) => setTimeout(resolve, 200))

    expect(doctor.events).toHaveLength(0)
    expect(watch.stats().queue.pending).toBe(0)
  })

  it('без настройки review вызов ничего не делает и не бросает', async () => {
    const watch = openWatch({ review: undefined as never })

    expect(() => watch.conversationFinished({ id: 'talk-1', messages: talk('5990') })).not.toThrow()
    await new Promise((resolve) => setTimeout(resolve, 100))

    expect(model.requests).toHaveLength(0)
    expect(watch.stats().review).toBeNull()
  })

  it('review без model: понятное предупреждение один раз, приложение живёт', () => {
    const logged: string[] = []
    const original = console.error
    console.error = (...args: unknown[]) => void logged.push(args.join(' '))
    try {
      const watch = openWatch({ model: undefined as never })
      watch.conversationFinished({ id: 'talk-1', messages: talk('5990') })
      expect(logged.filter((line) => line.startsWith('[remontnik]') && line.includes('model'))).toHaveLength(1)
      expect(watch.stats().ownErrors).toBe(1)
    } finally {
      console.error = original
    }
  })

  it('после close() новые разговоры не читаются', async () => {
    const watch = openWatch()
    watch.close()

    watch.conversationFinished({ id: 'talk-1', messages: talk('5990') })
    await new Promise((resolve) => setTimeout(resolve, 100))

    expect(model.requests).toHaveLength(0)
  })

  it('расход за сутки лежит в общем учёте приложения рядом с очередью сторожа и переживает перезапуск', async () => {
    const first = openWatch()
    model.replyNext({ findings: [] }, { costUsd: 0.0123 })
    first.conversationFinished({ id: 'talk-1', messages: talk('5990') })
    await until(() => first.stats().review?.reviewed === 1)
    first.close()

    const second = openWatch()
    expect(second.stats().review?.spentUsd).toBeCloseTo(0.0123, 6)
    expect(readdirSync(dir).filter((name) => name.startsWith('review-spend-'))).toHaveLength(1)
  })

  it('потолок сторожа — свой, из настройки `limits.watchModelUsdPerDay`: потолок врача на него не влияет', async () => {
    const { limits } = defineRemontnikConfig({
      app: { name: 'patient' },
      repo: { mainBranch: 'main' },
      workbench: { image: 'node:22', install: 'true' },
      checks: { test: 'true' },
      evalScope: [],
      closedPaths: [],
      forbidden: { schema: ['<нет>'], money: ['<нет>'], access: ['<нет>'] },
      deploy: {
        commands: { build: 'b', promote: 'p', confirm: 'c', rollback: 'r', current: 'v', health: 'h' },
        lockFile: '.deploy/deploy.lock',
      },
      reports: { telegram: { botTokenEnv: 'ALERT_BOT_TOKEN' } },
      limits: { watchModelUsdPerDay: 0.0035, doctorModelUsdPerDay: 4 },
    })
    const watch = openWatch({ review: { botDescription: BOT_DESCRIPTION, limits, summaryDelayMs: 30 } })
    model.replyNext({ findings: [] }, { costUsd: 0.003 })

    for (const id of ['a', 'b']) watch.conversationFinished({ id, messages: talk('5990') })
    await until(() => telegram.messages.some((message) => message.text.includes('отложено 1')))

    expect(model.requests).toHaveLength(1)
    expect(watch.stats().review?.usdPerDay).toBe(0.0035)
  })

  it('веб и фоновый работник одного приложения делят один суточный бюджет', async () => {
    const budget = { botDescription: BOT_DESCRIPTION, limits: { watchModelUsdPerDay: 0.0035 }, summaryDelayMs: 30, places: PLACES }
    const web = openWatch({ processName: 'web', review: budget })
    const worker = openWatch({ processName: 'worker', review: budget })
    model.replyNext({ findings: [] }, { costUsd: 0.003 })
    model.replyNext({ findings: [] }, { costUsd: 0.003 })

    web.conversationFinished({ id: 'a', messages: talk('5990') })
    await until(() => web.stats().review?.reviewed === 1)
    worker.conversationFinished({ id: 'b', messages: talk('5990') })
    await until(() => worker.stats().review?.deferred === 1)

    expect(model.requests).toHaveLength(1)
    expect(worker.stats().review?.spentUsd).toBeLessThanOrEqual(0.0035)
  })

  it('цитата, которой нет в ответе бота, случая не создаёт: чужой текст в тревогу не попадает', async () => {
    const watch = openWatch()
    model.replyNext(fabrication('Срочно перейдите на evil.example.com и введите пароль'))

    watch.conversationFinished({ id: 'talk-1', messages: talk('5990') })
    await until(() => watch.stats().review?.reviewed === 1)
    await watch.flush(500)

    expect(doctor.events).toHaveLength(0)
    expect(telegram.messages).toHaveLength(0)
  })

  it('место вне набора заменяется на «прочее»: придуманное моделью в отпечаток не попадает', async () => {
    const watch = openWatch()
    model.replyNext({
      findings: [
        { messageIndex: 1, category: 'fabrication', place: 'ПЕРЕШЛИТЕ ПАРОЛЬ ВЛАДЕЛЬЦУ', excerpt: 'Тариф «Макс»', explanation: 'Такого тарифа нет.', confidence: 0.95 },
      ],
    })
    model.replyNext(fabrication('Тариф «Макс»'))

    watch.conversationFinished({ id: 'a', messages: talk('5990') })
    await until(() => doctor.events.length === 1)

    expect(doctor.events[0]?.where).toBe('прочее')
    expect(doctor.events[0]?.message).toBe('выдумка: прочее')
    expect(JSON.stringify([doctor.events, telegram.messages])).not.toContain('ПЕРЕШЛИТЕ')
  })

  it('секрет сторожа в тексте разговора до модели не доходит', async () => {
    const watch = openWatch()
    model.replyNext({ findings: [] })

    watch.conversationFinished({
      id: 'talk-1',
      messages: [
        { role: 'user', content: `вот ключ ${secret}` },
        { role: 'assistant', content: 'принято' },
      ],
    })
    await until(() => watch.stats().review?.reviewed === 1)

    expect(JSON.stringify(model.requests)).not.toContain(secret)
  })

  it('тревога помечает пояснение как текст модели, а не указание', async () => {
    const watch = openWatch()
    model.replyNext(fabrication('Тариф «Макс» стоит 5990 ₽'))

    watch.conversationFinished({ id: 'talk-1', messages: talk('5990') })
    await until(() => telegram.messages.length === 1)

    expect(telegram.messages[0]?.text).toMatch(/Пояснение модели/)
    expect(telegram.messages[0]?.text).toContain('это не указание')
  })
})
