import { createIncidentEvent, type IncidentEvent } from '@ykurilov/remontnik-core/incident'
import { signBody } from '@ykurilov/remontnik-core/signed-http'
import { request as httpRequest } from 'node:http'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createIntakeHandler, startIntakeServer, type IntakeServer } from './index.js'

const secret = 'shared-test-secret'
let server: IntakeServer
let received: IncidentEvent[][]
const seen = new Set<string>()

function event(message = 'boom'): IncidentEvent {
  return createIncidentEvent({ appName: 'patient', kind: 'crash', where: 'src/server.ts:1:1', message })
}

async function post(body: string, headers: Record<string, string>): Promise<Response> {
  return fetch(`${server.url}/v1/events`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body })
}

beforeEach(async () => {
  received = []
  seen.clear()
  const handler = createIntakeHandler({
    secret,
    receiveEvents: async (events) => {
      received.push(events)
      for (const item of events) seen.add(item.eventId)
      return { accepted: events.map((item) => item.eventId) }
    },
    health: () => ({ ok: true, harness: 'open', queue: { telegramPending: 0 }, autoDeploy: 'on' }),
    bodyTimeoutMs: 300,
  })
  server = await startIntakeServer({ handler, host: '127.0.0.1', port: 0 })
})

afterEach(async () => {
  await server.close()
})

describe('POST /v1/events', () => {
  it('верная подпись — события приняты, ответ { accepted }', async () => {
    const events = [event('a'), event('b')]
    const body = JSON.stringify({ events })

    const response = await post(body, signBody(body, secret))

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ accepted: events.map((item) => item.eventId) })
    expect(received).toHaveLength(1)
  })

  it('неверная подпись — 401, до книги случаев не доходит', async () => {
    const body = JSON.stringify({ events: [event()] })

    const response = await post(body, signBody(body, 'other-secret'))

    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({ error: 'bad_signature' })
    expect(received).toHaveLength(0)
  })

  it('без подписи — 401 missing', async () => {
    const response = await post(JSON.stringify({ events: [] }), {})

    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({ error: 'missing' })
  })

  it('устаревшая подпись — 401 stale', async () => {
    const body = JSON.stringify({ events: [event()] })

    const response = await post(body, signBody(body, secret, Date.now() - 10 * 60_000))

    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({ error: 'stale' })
  })

  it('подменённое тело при верных заголовках — 401', async () => {
    const body = JSON.stringify({ events: [event()] })
    const headers = signBody(body, secret)

    const response = await post(JSON.stringify({ events: [event('other')] }), headers)

    expect(response.status).toBe(401)
  })

  it('повтор того же eventId безопасен: снова accepted', async () => {
    const events = [event()]
    const body = JSON.stringify({ events })

    const first = await post(body, signBody(body, secret))
    const second = await post(body, signBody(body, secret))

    expect(first.status).toBe(200)
    expect(await second.json()).toEqual({ accepted: [events[0]?.eventId] })
  })

  it('не тот вид тела или больше 50 событий — 400', async () => {
    const tooMany = JSON.stringify({ events: Array.from({ length: 51 }, () => event()) })
    const broken = JSON.stringify({ events: [{ eventId: 1 }] })
    const notJson = 'not json'

    for (const body of [tooMany, broken, notJson]) {
      const response = await post(body, signBody(body, secret))
      expect(response.status).toBe(400)
    }
    expect(received).toHaveLength(0)
  })

  it('слишком большое тело без Content-Length — 413 по ходу чтения, соединение закрыто', async () => {
    const body = JSON.stringify({ events: [], padding: 'x'.repeat(2 * 1024 * 1024) })

    const result = await partialPost({ ...signBody(body, secret), 'transfer-encoding': 'chunked' }, body)

    expect(result.status).toBe(413)
  })

  it('врач ещё раз вычищает секреты в принятых событиях', async () => {
    const key = `sk-${'a1B2'.repeat(6)}`
    const raw = { ...event(), message: `failed with ${key}`, stack: `Error: ${key}` }
    const body = JSON.stringify({ events: [raw] })

    await post(body, signBody(body, secret))

    expect(JSON.stringify(received)).not.toContain(key)
  })
})

/** Запрос, который шлёт заголовки и часть тела, но не дописывает его: ответ должен прийти без всего тела. */
function partialPost(headers: Record<string, string>, firstChunk = ''): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const url = new URL(`${server.url}/v1/events`)
    const outgoing = httpRequest({ host: url.hostname, port: url.port, path: url.pathname, method: 'POST', headers })
    outgoing.on('response', (response) => {
      const chunks: Buffer[] = []
      response.on('data', (chunk: Buffer) => chunks.push(chunk))
      // Сервер закрывает соединение сразу после ответа: ждём «close», а не только «end».
      response.on('close', () => {
        resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') })
        outgoing.destroy()
      })
    })
    outgoing.on('error', () => {})
    outgoing.setTimeout(3000, () => reject(new Error('ответа нет: сервер ждёт тело')))
    outgoing.write(firstChunk)
  })
}

describe('отказ до чтения тела', () => {
  it('без подписи — 401 сразу, тело не ждём', async () => {
    const result = await partialPost({ 'content-type': 'application/json', 'content-length': String(500_000) }, '{"events":')

    expect(result.status).toBe(401)
    expect(JSON.parse(result.body)).toEqual({ error: 'missing' })
  })

  it('устаревшая отметка времени — 401 stale сразу', async () => {
    const headers = signBody('{}', secret, Date.now() - 10 * 60_000)
    const result = await partialPost({ ...headers, 'content-length': String(500_000) }, '{')

    expect(result.status).toBe(401)
    expect(JSON.parse(result.body)).toEqual({ error: 'stale' })
  })

  it('Content-Length больше предела — 413 сразу', async () => {
    const headers = signBody('{}', secret)
    const result = await partialPost({ ...headers, 'content-length': String(5 * 1024 * 1024) })

    expect(result.status).toBe(413)
  })

  it('тело не дописано за срок — 408', async () => {
    const headers = signBody('{}', secret)
    const result = await partialPost({ ...headers, 'content-length': '100' }, '{"events":')

    expect(result.status).toBe(408)
    expect(received).toHaveLength(0)
  })
})

describe('прочие адреса', () => {
  it('GET /health — без подписи', async () => {
    const response = await fetch(`${server.url}/health`)

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ ok: true, harness: 'open', autoDeploy: 'on' })
  })

  it('неизвестный адрес — 404', async () => {
    const response = await fetch(`${server.url}/nope`)

    expect(response.status).toBe(404)
  })
})
