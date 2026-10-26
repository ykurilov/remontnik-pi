import { NONCE_HEADER, signRequest, verifySignedResponse } from '@ykurilov/remontnik-core/signed-http'
import { createTelegramClient } from '@ykurilov/remontnik-core/telegram'
import { startFakeTelegram, type FakeTelegramServer } from '@ykurilov/remontnik-core/testing'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createIntakeHandler, startIntakeServer, type IntakeServer } from '../intake/index.js'
import { createReportsFeedHandler } from '../intake/reports-feed.js'
import { createMemoryRecordStore, type RecordStore } from '../records/index.js'
import { REPORT_FULL_LIMIT, createReports, type Reports } from './index.js'

// Лента отчётов для Paseo (история 9): порядок по курсору, подтверждение, доступ, повторы Telegram.

const BRIDGE_SECRET = 'bridge-secret-for-tests'
const TOKEN = 'reports-token-for-tests'
const APP = 'patient'
const start = Date.parse('2026-10-26T10:00:00Z')

let telegram: FakeTelegramServer
let store: RecordStore
let reports: Reports
let bridge: IntakeServer
let main: IntakeServer
let now: number

function reportsOver(source: RecordStore): Reports {
  return createReports({
    store: source,
    telegram: { client: createTelegramClient({ botToken: '123456:test-bot-token', apiBaseUrl: telegram.baseUrl }), chatId: 'owner-chat' },
    now: () => now,
  })
}

async function startServers(): Promise<void> {
  bridge = await startIntakeServer({
    handler: createReportsFeedHandler({ reports, access: { kind: 'bridge', secret: BRIDGE_SECRET, appName: APP } }),
    host: '127.0.0.1',
    port: 0,
  })
  main = await startIntakeServer({
    handler: createIntakeHandler({
      secret: 'watch-secret',
      receiveEvents: async () => ({ accepted: [] }),
      health: () => ({ ok: true }),
      reportsFeed: createReportsFeedHandler({ reports, access: { kind: 'token', token: TOKEN } }),
    }),
    host: '127.0.0.1',
    port: 0,
  })
}

beforeEach(async () => {
  telegram = await startFakeTelegram()
  now = start
  store = createMemoryRecordStore()
  reports = reportsOver(store)
  await startServers()
})

afterEach(async () => {
  await bridge.close()
  await main.close()
  await telegram.close()
})

interface Answer {
  status: number
  text: string
  body: any
  headers: Headers
  nonce: string
}

/** Подписанный запрос моста; `signedFor` — подписать другой путь (проверка подмены). */
async function asBridge(
  method: 'GET' | 'POST',
  path: string,
  payload?: unknown,
  options: { secret?: string; signedFor?: string; now?: number; nonce?: string } = {},
): Promise<Answer> {
  const body = payload === undefined ? '' : JSON.stringify(payload)
  const signature = signRequest({
    method,
    target: options.signedFor ?? path,
    body,
    secret: options.secret ?? BRIDGE_SECRET,
    ...(options.now === undefined ? {} : { now: options.now }),
  })
  return send(bridge, method, path, body, signature)
}

async function send(server: IntakeServer, method: string, path: string, body: string, headers: Record<string, string>): Promise<Answer> {
  const response = await fetch(`${server.url}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    ...(method === 'POST' ? { body } : {}),
    redirect: 'manual',
  })
  const text = await response.text()
  let parsed: unknown = null
  try {
    parsed = JSON.parse(text)
  } catch {}
  return { status: response.status, text, body: parsed, headers: response.headers, nonce: headers[NONCE_HEADER] ?? '' }
}

const asOwner = (method: 'GET' | 'POST', path: string, payload?: unknown, token: string | null = TOKEN) =>
  send(main, method, path, payload === undefined ? '' : JSON.stringify(payload), token === null ? {} : { authorization: `Bearer ${token}` })

async function addReports(count: number, full?: string) {
  for (let index = 1; index <= count; index += 1) {
    await reports.add({ type: 'doctor_problem', short: `отчёт ${index}`, ...(full === undefined ? {} : { full }), telegram: 'not_needed' })
  }
}

const ids = (answer: Answer) => (answer.body.reports as { reportId: number }[]).map((report) => report.reportId)

describe('лента отчётов: порядок и курсор', () => {
  it('отчёты идут по возрастанию номера, после курсора — только новые', async () => {
    await addReports(3)

    expect(ids(await asBridge('GET', '/v1/reports?after=0&limit=50'))).toEqual([1, 2, 3])
    expect(ids(await asBridge('GET', '/v1/reports?after=1&limit=50'))).toEqual([2, 3])
    expect(ids(await asBridge('GET', '/v1/reports?after=3&limit=50'))).toEqual([])
  })

  it('last — номер последнего отчёта в ответе, а без новых — сам курсор', async () => {
    await addReports(3)

    expect((await asBridge('GET', '/v1/reports?after=0&limit=2')).body).toMatchObject({ last: 2 })
    expect((await asBridge('GET', '/v1/reports?after=3&limit=50')).body).toMatchObject({ reports: [], last: 3 })
  })

  it('страницы по limit склеиваются без пропусков и повторов', async () => {
    await addReports(5)
    const seen: number[] = []
    let cursor = 0
    for (;;) {
      const page = await asBridge('GET', `/v1/reports?after=${cursor}&limit=2`)
      if (ids(page).length === 0) break
      seen.push(...ids(page))
      cursor = page.body.last
    }

    expect(seen).toEqual([1, 2, 3, 4, 5])
  })

  it('отчёт отдаётся с полями из договора и без внутренней отметки Telegram', async () => {
    await reports.add({ type: 'deployed', caseId: 4, short: 'выкачено', full: '# Выкачено\nподробности', telegram: 'pending' })
    await reports.add({ type: 'doctor_problem', short: 'без случая', telegram: 'not_needed' })

    const [first, second] = (await asBridge('GET', '/v1/reports?after=0&limit=50')).body.reports

    expect(first).toEqual({ reportId: 1, caseId: 4, type: 'deployed', short: 'выкачено', full: '# Выкачено\nподробности', createdAt: new Date(start).toISOString() })
    expect(second).not.toHaveProperty('caseId')
    expect(second).not.toHaveProperty('telegram')
  })

  it('отчёты, записанные пока моста нет, ждут и уходят по порядку после его появления', async () => {
    await addReports(3)
    await bridge.close()
    await addReports(2)
    await startServers()

    expect(ids(await asBridge('GET', '/v1/reports?after=0&limit=50'))).toEqual([1, 2, 3, 4, 5])
  })

  it('ответ не больше 256 КиБ, но хотя бы один отчёт идёт всегда', async () => {
    await addReports(10, 'ж'.repeat(REPORT_FULL_LIMIT))
    const seen: number[] = []
    let cursor = 0
    for (;;) {
      const page = await asBridge('GET', `/v1/reports?after=${cursor}&limit=50`)
      expect(Buffer.byteLength(page.text)).toBeLessThanOrEqual(256 * 1024)
      if (ids(page).length === 0) break
      seen.push(...ids(page))
      cursor = page.body.last
    }

    expect(seen).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
  })

  it('полный текст отчёта обрезается до предела, который принимает мост', async () => {
    const added = await reports.add({ type: 'doctor_problem', short: 'x', full: 'ж'.repeat(REPORT_FULL_LIMIT * 3), telegram: 'not_needed' })

    expect(added.full.length).toBeLessThanOrEqual(REPORT_FULL_LIMIT)
    expect(REPORT_FULL_LIMIT).toBeLessThan(64 * 1024)
  })

  it('кривые after и limit — 400, большой limit урезается', async () => {
    await addReports(120)

    for (const query of ['after=abc', 'after=-1', 'after=1.5', 'limit=0', 'limit=x', 'after=99999999999999999999']) {
      const answer = await asBridge('GET', `/v1/reports?${query}`)
      expect(answer.status, query).toBe(400)
      expect(answer.body).toEqual({ error: 'bad_request' })
    }
    expect(ids(await asBridge('GET', '/v1/reports?after=0&limit=100000')).length).toBe(100)
    expect(ids(await asBridge('GET', '/v1/reports')).length).toBe(50)
  })
})

describe('лента отчётов: подтверждение', () => {
  it('ack запоминается, не уменьшается и виден в ленте', async () => {
    await addReports(3)

    expect((await asBridge('POST', '/v1/reports/ack', { app: APP, upTo: 2 })).body).toEqual({ ok: true, acked: 2 })
    expect((await asBridge('POST', '/v1/reports/ack', { app: APP, upTo: 1 })).body).toEqual({ ok: true, acked: 2 })
    expect((await asBridge('GET', '/v1/reports?after=2&limit=50')).body).toMatchObject({ acked: 2 })
  })

  it('подтверждение переживает перезапуск врача', async () => {
    await addReports(3)
    await asBridge('POST', '/v1/reports/ack', { app: APP, upTo: 3 })
    await bridge.close()
    await main.close()

    reports = reportsOver(store)
    await startServers()

    expect((await asBridge('GET', '/v1/reports?after=3&limit=50')).body).toMatchObject({ acked: 3 })
  })

  it('подтвердить можно только существующий номер', async () => {
    await addReports(2)

    for (const upTo of [3, -1, 1.5, '2', null]) {
      const answer = await asBridge('POST', '/v1/reports/ack', { app: APP, upTo })
      expect(answer.status, String(upTo)).toBe(400)
    }
    expect(await reports.paseoAcked()).toBe(0)
  })

  it('подтверждение без app принимается — так шлёт мост; чужое app — как неверная подпись', async () => {
    await addReports(2)

    expect((await asBridge('POST', '/v1/reports/ack', { upTo: 1 })).body).toEqual({ ok: true, acked: 1 })
    expect((await asBridge('POST', '/v1/reports/ack', { app: 42, upTo: 2 })).status).toBe(400)
    const foreign = await asBridge('POST', '/v1/reports/ack', { app: 'other', upTo: 2 })
    expect(foreign.status).toBe(401)
    expect(foreign.body).toEqual({ error: 'bad_signature' })
    expect(await reports.paseoAcked()).toBe(1)
  })
})

describe('лента отчётов: доступ для моста', () => {
  it('без подписи — 401 missing', async () => {
    const answer = await send(bridge, 'GET', '/v1/reports?after=0', '', {})

    expect(answer.status).toBe(401)
    expect(answer.body).toEqual({ error: 'missing' })
  })

  it('подпись чужим секретом — 401 bad_signature, отчёты не отдаются', async () => {
    await addReports(1)

    const answer = await asBridge('GET', '/v1/reports?after=0&limit=50', undefined, { secret: 'other-secret' })

    expect(answer.status).toBe(401)
    expect(answer.body).toEqual({ error: 'bad_signature' })
    expect(answer.text).not.toContain('отчёт 1')
  })

  it('подпись, снятая с другого пути, не годится: курсор не подменить', async () => {
    await addReports(3)

    const answer = await asBridge('GET', '/v1/reports?after=2&limit=50', undefined, { signedFor: '/v1/reports?after=0&limit=50' })

    expect(answer.status).toBe(401)
  })

  it('подпись метода GET не годится для POST', async () => {
    await addReports(1)
    const signature = signRequest({ method: 'GET', target: '/v1/reports/ack', body: '', secret: BRIDGE_SECRET })

    const answer = await send(bridge, 'POST', '/v1/reports/ack', JSON.stringify({ app: APP, upTo: 1 }), signature)

    expect(answer.status).toBe(401)
    expect(await reports.paseoAcked()).toBe(0)
  })

  it('подмена тела при верной подписи пути — 401', async () => {
    await addReports(3)
    const signature = signRequest({ method: 'POST', target: '/v1/reports/ack', body: JSON.stringify({ app: APP, upTo: 1 }), secret: BRIDGE_SECRET })

    const answer = await send(bridge, 'POST', '/v1/reports/ack', JSON.stringify({ app: APP, upTo: 3 }), signature)

    expect(answer.status).toBe(401)
    expect(await reports.paseoAcked()).toBe(0)
  })

  it('устаревшая отметка времени — 401 stale', async () => {
    const answer = await asBridge('GET', '/v1/reports?after=0', undefined, { now: Date.now() - 10 * 60_000 })

    expect(answer.status).toBe(401)
    expect(answer.body).toEqual({ error: 'stale' })
  })

  it('повтор той же подписи — 401 replayed', async () => {
    const signature = signRequest({ method: 'GET', target: '/v1/reports?after=0&limit=50', body: '', secret: BRIDGE_SECRET })

    const first = await send(bridge, 'GET', '/v1/reports?after=0&limit=50', '', signature)
    const second = await send(bridge, 'GET', '/v1/reports?after=0&limit=50', '', signature)

    expect(first.status).toBe(200)
    expect(second.status).toBe(401)
    expect(second.body).toEqual({ error: 'replayed' })
  })

  it('ключ доступа владельца на адресе моста не принимается', async () => {
    await addReports(1)

    const answer = await send(bridge, 'GET', '/v1/reports?after=0&limit=50', '', { authorization: `Bearer ${TOKEN}` })

    expect(answer.status).toBe(401)
  })

  it('на адресе моста нет ничего, кроме ленты', async () => {
    for (const [method, path] of [['GET', '/health'], ['POST', '/v1/events'], ['GET', '/v1/cases/1']] as const) {
      const signature = signRequest({ method, target: path, body: '', secret: BRIDGE_SECRET })
      expect((await send(bridge, method, path, '', signature)).status, path).toBe(404)
    }
  })

  it('ответ подписан и привязан к запросу: верная подпись проходит, чужой секрет и чужая метка — нет', async () => {
    await addReports(1)
    const path = '/v1/reports?after=0&limit=50'
    const answer = await asBridge('GET', path)
    const check = (secret: string, nonce: string) =>
      verifySignedResponse({ request: { method: 'GET', target: path, nonce }, status: answer.status, body: answer.text, headers: answer.headers, secret })

    expect(check(BRIDGE_SECRET, answer.nonce)).toEqual({ ok: true })
    expect(check('other-secret', answer.nonce)).toMatchObject({ ok: false })
    expect(check(BRIDGE_SECRET, '0'.repeat(32))).toMatchObject({ ok: false })
  })

  it('ответ об ошибке после проверки подписи тоже подписан', async () => {
    const path = '/v1/reports?after=abc'
    const answer = await asBridge('GET', path)

    expect(answer.status).toBe(400)
    expect(
      verifySignedResponse({ request: { method: 'GET', target: path, nonce: answer.nonce }, status: 400, body: answer.text, headers: answer.headers, secret: BRIDGE_SECRET }),
    ).toEqual({ ok: true })
  })

  it('отказ по подписи не подписывается: подписи на выбранную метку чужой не получить', async () => {
    const answer = await asBridge('GET', '/v1/reports?after=0', undefined, { secret: 'other-secret' })

    expect(answer.headers.get('x-remontnik-signature')).toBeNull()
  })

  it('перенаправлений врач не отправляет', async () => {
    const answer = await asBridge('GET', '/v1/reports?after=0&limit=50')

    expect(answer.status).toBe(200)
    expect(answer.headers.get('location')).toBeNull()
  })
})

describe('лента отчётов: доступ по ключу владельца (забор по SSH)', () => {
  it('верный ключ — лента и подтверждение работают, app в теле не нужен', async () => {
    await addReports(2)

    expect(ids(await asOwner('GET', '/v1/reports?after=0&limit=50'))).toEqual([1, 2])
    expect((await asOwner('POST', '/v1/reports/ack', { upTo: 2 })).body).toEqual({ ok: true, acked: 2 })
  })

  it('без ключа, с чужим ключом, с ключом другой длины — 401', async () => {
    await addReports(1)

    for (const token of [null, 'wrong-token', TOKEN.slice(0, -1), `${TOKEN}x`, '']) {
      const answer = await asOwner('GET', '/v1/reports?after=0&limit=50', undefined, token)
      expect(answer.status, String(token)).toBe(401)
      expect(answer.text).not.toContain('отчёт 1')
    }
    expect((await asOwner('POST', '/v1/reports/ack', { upTo: 1 }, 'wrong-token')).status).toBe(401)
    expect(await reports.paseoAcked()).toBe(0)
  })

  it('подпись моста на этом адресе не принимается', async () => {
    const signature = signRequest({ method: 'GET', target: '/v1/reports?after=0', body: '', secret: BRIDGE_SECRET })

    expect((await send(main, 'GET', '/v1/reports?after=0', '', signature)).status).toBe(401)
  })

  it('схема не Bearer — 401', async () => {
    const answer = await send(main, 'GET', '/v1/reports?after=0', '', { authorization: `Basic ${TOKEN}` })

    expect(answer.status).toBe(401)
  })

  it('без настроенной ленты адреса нет совсем', async () => {
    const bare = await startIntakeServer({
      handler: createIntakeHandler({ secret: 'watch-secret', receiveEvents: async () => ({ accepted: [] }), health: () => ({ ok: true }) }),
      host: '127.0.0.1',
      port: 0,
    })
    try {
      const answer = await send(bare, 'GET', '/v1/reports?after=0', '', { authorization: `Bearer ${TOKEN}` })
      expect(answer.status).toBe(404)
    } finally {
      await bare.close()
    }
  })

  it('пустой ключ в настройке ленты — ошибка при создании, а не открытая лента', () => {
    expect(() => createReportsFeedHandler({ reports, access: { kind: 'token', token: '' } })).toThrow(/ключ/)
    expect(() => createReportsFeedHandler({ reports, access: { kind: 'bridge', secret: '', appName: APP } })).toThrow(/секрет/)
  })
})

describe('повторы Telegram переживают перезапуск', () => {
  it('отчёт, не ушедший в Telegram, остаётся в ленте и доходит после рестарта врача', async () => {
    const added = await reports.add({ type: 'doctor_problem', short: 'важное', telegram: 'pending' })
    telegram.failNext(500)
    await reports.pump()
    expect((await reports.get(added.reportId))?.telegram).toMatchObject({ state: 'pending', attempts: 1 })
    expect(ids(await asBridge('GET', '/v1/reports?after=0&limit=50'))).toEqual([1])

    await bridge.close()
    await main.close()
    reports = reportsOver(store)
    await startServers()
    now = start + 5_000
    await reports.pump()

    expect(telegram.messages.map((item) => item.text)).toEqual(['важное'])
    expect((await reports.get(added.reportId))?.telegram).toMatchObject({ state: 'sent', attempts: 2 })
    expect(ids(await asBridge('GET', '/v1/reports?after=0&limit=50'))).toEqual([1])
  })

  it('отчёты в Telegram и в ленту идут независимо: сбой Telegram не задерживает ленту', async () => {
    await reports.add({ type: 'doctor_problem', short: 'a', telegram: 'pending' })
    await reports.add({ type: 'doctor_problem', short: 'b', telegram: 'pending' })
    telegram.failNext(500)
    telegram.failNext(500)
    await reports.pump()

    expect(ids(await asBridge('GET', '/v1/reports?after=0&limit=50'))).toEqual([1, 2])
  })
})
