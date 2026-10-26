import { mkdtempSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startDoctorService, type DoctorService } from '@ykurilov/remontnik-doctor'
import { startFakeModel, startFakeTelegram, type FakeModelServer, type FakeTelegramServer } from '@ykurilov/remontnik-core/testing'
import { createWatch, type Watch } from '@ykurilov/remontnik-watch'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import patientConfig from '../../remontnik.config.ts'
import type { PatientBug } from '../../src/bugs.ts'
import { createPatientServer } from '../../src/server.ts'
import { reportToWatch, sendConversationsToWatch } from './watch-glue.ts'

// История 6 на «Пациенте»: бот ответил плохо → разговор закончился → сторож прочитал →
// событие bad_answer дошло до врача → случай записан, владелец получил одно сообщение.

const secret = 'shared-test-secret'
/** Места, к которым сторож относит нарушения бота: отпечаток случая строится от них. */
const BOT_PLACES = ['цены тарифов', 'статус заказа', 'тон ответа', 'выход за задачи бота']
const botToken = '123456:test-bot-token'

let telegram: FakeTelegramServer
let model: FakeModelServer
let watchDir: string
let stateDir: string
const cleanups: (() => Promise<void> | void)[] = []

async function startDoctor(): Promise<DoctorService> {
  const doctor = await startDoctorService({
    stateDir,
    sharedSecret: secret,
    listen: { host: '127.0.0.1', port: 0 },
    telegram: { botToken, chatId: 'owner-chat', apiBaseUrl: telegram.baseUrl },
    exit: () => {},
    log: () => {},
  })
  cleanups.push(() => doctor.close())
  return doctor
}

function openWatch(doctorUrl: string, usdPerDay = 1): Watch {
  const watch = createWatch({
    appName: 'patient',
    processName: 'web',
    dir: watchDir,
    doctor: { url: doctorUrl, secret },
    telegram: { botToken, chatId: 'owner-chat', apiBaseUrl: telegram.baseUrl },
    model: {
      primary: { baseUrl: model.baseUrl, apiKey: 'test-primary-key', model: 'deepseek-flash' },
      fallback: { baseUrl: model.baseUrl, apiKey: 'test-fallback-key', model: 'deepseek/deepseek-v4.1-flash-1017' },
    },
    review: { botDescription: patientConfig.review!.botDescription, places: BOT_PLACES, limits: { watchModelUsdPerDay: usdPerDay }, summaryDelayMs: 150 },
  })
  cleanups.push(() => watch.close())
  return watch
}

async function startPatient(bug: PatientBug | null, watch: Watch) {
  const server = createPatientServer({
    bug,
    reportError: reportToWatch(watch),
    conversationFinished: sendConversationsToWatch(watch),
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())))
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return {
    /** Один разговор одного посетителя (со своей кукой): реплики по порядку, затем «пользователь ушёл». */
    async talk(...messages: string[]) {
      let cookie = ''
      const post = async (path: string, body: unknown) => {
        const response = await fetch(`${url}${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
          body: JSON.stringify(body),
        })
        cookie = response.headers.get('set-cookie')?.split(';')[0] ?? cookie
      }
      for (const message of messages) await post('/api/chat', { message })
      await post('/api/chat/finish', {})
    },
  }
}

const fabrication = {
  findings: [
    {
      messageIndex: 1,
      category: 'fabrication',
      place: 'цены тарифов',
      excerpt: 'Тариф «Макс» стоит 5990 ₽ в месяц.',
      explanation: 'Тарифа «Макс» нет, цена выдумана.',
      confidence: 0.95,
    },
  ],
}

async function until(condition: () => boolean | Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error('условие не выполнилось')
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

beforeEach(async () => {
  telegram = await startFakeTelegram()
  model = await startFakeModel()
  watchDir = mkdtempSync(join(tmpdir(), 'remontnik-us6-watch-'))
  stateDir = mkdtempSync(join(tmpdir(), 'remontnik-us6-doctor-'))
})

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  await Promise.all([telegram.close(), model.close()])
})

describe('История 6: сторож замечает неадекватные ответы', () => {
  it('плохой ответ бота: разговор прочитан, bad_answer дошёл до врача, случай записан, владелец уведомлён', async () => {
    const doctor = await startDoctor()
    const watch = openWatch(doctor.url)
    const patient = await startPatient('bad_answer', watch)
    model.replyNext(fabrication)

    await patient.talk('Сколько стоит тариф Макс?')
    await until(async () => (await doctor.caseBook.getCase(1)) !== undefined)

    expect(await doctor.caseBook.getCase(1)).toMatchObject({ kind: 'bad_answer', events: 1, appName: 'patient' })
    const readRequest = JSON.stringify(model.requests[0]?.body.messages)
    expect(readRequest).toContain('5990')
    await until(() => telegram.messages.length === 1)
    expect(telegram.messages[0]?.text).toContain('bad_answer')
    expect(telegram.messages[0]?.text).toMatch(/Разговор: [0-9a-f]{24}/)
    expect(await watch.flush(2000)).toBe(true)
  })

  it('хорошие разговоры: модель ничего не нашла — случая нет, сообщений нет', async () => {
    const doctor = await startDoctor()
    const watch = openWatch(doctor.url)
    const patient = await startPatient(null, watch)
    model.replyNext({ findings: [] })
    model.replyNext({ findings: [] })

    await patient.talk('Привет', 'Сколько стоит тариф Про?')
    await patient.talk('Где мой заказ 42?')
    await until(() => watch.stats().review?.reviewed === 2)
    expect(await watch.flush(2000)).toBe(true)

    expect(await doctor.caseBook.getCase(1)).toBeUndefined()
    expect(telegram.messages).toHaveLength(0)
  })

  it('одна ошибка бота в трёх разговорах — один случай со счётчиком 3 и одно сообщение', async () => {
    const doctor = await startDoctor()
    const watch = openWatch(doctor.url)
    const patient = await startPatient('bad_answer', watch)
    for (let index = 0; index < 3; index += 1) model.replyNext(fabrication)

    for (let index = 0; index < 3; index += 1) await patient.talk('Сколько стоит тариф Макс?')
    await until(async () => (await doctor.caseBook.getCase(1))?.events === 3)
    expect(await watch.flush(3000)).toBe(true)

    expect(await doctor.caseBook.getCase(2)).toBeUndefined()
    expect(telegram.messages).toHaveLength(1)
  })

  it('бюджет на сутки исчерпан: лишние разговоры отложены, владелец получает «отложено N»', async () => {
    const doctor = await startDoctor()
    const watch = openWatch(doctor.url, 0.0035)
    const patient = await startPatient('bad_answer', watch)
    model.replyNext(fabrication, { costUsd: 0.003 })

    for (let index = 0; index < 3; index += 1) await patient.talk('Сколько стоит тариф Макс?')
    await until(() => telegram.messages.some((message) => message.text.includes('отложено 2')))

    expect(model.requests).toHaveLength(1)
    expect(watch.stats().review).toMatchObject({ reviewed: 1, deferred: 2 })
  })

  it('чтение не мешает чату: ответ бота приходит быстро, пока модель чтения молчит', async () => {
    const doctor = await startDoctor()
    const watch = openWatch(doctor.url)
    const patient = await startPatient('bad_answer', watch)
    model.hangNext()

    const startedAt = Date.now()
    await patient.talk('Привет')
    expect(Date.now() - startedAt).toBeLessThan(2000)
    await until(() => model.requests.length === 1)
  })
})
