import { describe, expect, it } from 'vitest'
import {
  NONCE_HEADER,
  ReplayGuard,
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
  precheckSignedRequest,
  signBody,
  signRequest,
  signResponse,
  verifySignedBody,
  verifySignedRequest,
  verifySignedResponse,
} from './index.js'

const secret = 'shared-test-secret'
const body = JSON.stringify({ events: [{ eventId: '01JB2XKQ9Z8M4N6P7R3S5T1V0W' }] })
const now = Date.parse('2026-10-26T10:00:00Z')

describe('signBody', () => {
  it('даёт заголовки подписи sha256=<hex> и отметку времени в секундах', () => {
    const headers = signBody(body, secret, now)

    expect(headers[SIGNATURE_HEADER]).toMatch(/^sha256=[0-9a-f]{64}$/)
    expect(headers[TIMESTAMP_HEADER]).toBe(String(now / 1000))
    expect(SIGNATURE_HEADER).toBe('X-Remontnik-Signature')
    expect(TIMESTAMP_HEADER).toBe('X-Remontnik-Timestamp')
  })
})

describe('verifySignedBody', () => {
  it('принимает верную подпись', () => {
    const headers = signBody(body, secret, now)

    expect(verifySignedBody({ body, headers, secret, now })).toEqual({ ok: true })
  })

  it('читает заголовки без учёта регистра', () => {
    const signed = signBody(body, secret, now)
    const headers = { 'x-remontnik-signature': signed[SIGNATURE_HEADER], 'x-remontnik-timestamp': signed[TIMESTAMP_HEADER] }

    expect(verifySignedBody({ body, headers, secret, now })).toEqual({ ok: true })
  })

  it('отклоняет неверную подпись, чужой секрет и изменённое тело', () => {
    const headers = signBody(body, secret, now)

    expect(verifySignedBody({ body, headers, secret: 'other', now })).toEqual({ ok: false, reason: 'bad_signature' })
    expect(verifySignedBody({ body: body + ' ', headers, secret, now })).toEqual({ ok: false, reason: 'bad_signature' })
    expect(
      verifySignedBody({ body, headers: { ...headers, [SIGNATURE_HEADER]: 'sha256=00' }, secret, now }),
    ).toEqual({ ok: false, reason: 'bad_signature' })
  })

  it('подпись привязана к отметке времени: подмена отметки не проходит', () => {
    const headers = signBody(body, secret, now)

    expect(
      verifySignedBody({ body, headers: { ...headers, [TIMESTAMP_HEADER]: String(now / 1000 + 10) }, secret, now }),
    ).toEqual({ ok: false, reason: 'bad_signature' })
  })

  it('отклоняет старую и слишком будущую отметку времени', () => {
    const old = signBody(body, secret, now - 301_000)
    const future = signBody(body, secret, now + 301_000)

    expect(verifySignedBody({ body, headers: old, secret, now })).toEqual({ ok: false, reason: 'stale' })
    expect(verifySignedBody({ body, headers: future, secret, now })).toEqual({ ok: false, reason: 'stale' })
    expect(verifySignedBody({ body, headers: old, secret, now, maxSkewMs: 400_000 })).toEqual({ ok: true })
  })

  it('без заголовков — missing', () => {
    expect(verifySignedBody({ body, headers: {}, secret, now })).toEqual({ ok: false, reason: 'missing' })
  })

  it('пустой секрет не принимается', () => {
    expect(() => signBody(body, '', now)).toThrow()
    expect(verifySignedBody({ body, headers: signBody(body, secret, now), secret: '', now })).toEqual({
      ok: false,
      reason: 'bad_signature',
    })
  })
})

describe('signRequest / verifySignedRequest', () => {
  const request = { method: 'POST', target: '/v1/tasks?x=1', body }

  it('подпись покрывает метод, путь с запросом, отметку времени, разовую метку и тело', () => {
    const headers = signRequest({ ...request, secret, now })
    expect(headers[SIGNATURE_HEADER]).toMatch(/^sha256=[0-9a-f]{64}$/)
    expect(headers[NONCE_HEADER]).toMatch(/^[0-9a-f]{32}$/)
    expect(verifySignedRequest({ ...request, headers, secret, now })).toMatchObject({ ok: true })

    for (const changed of [
      { method: 'GET' },
      { target: '/v1/tasks?x=2' },
      { target: '/v1/agent/result' },
      { body: body + ' ' },
    ]) {
      expect(verifySignedRequest({ ...request, ...changed, headers, secret, now })).toEqual({ ok: false, reason: 'bad_signature' })
    }
    expect(
      verifySignedRequest({ ...request, headers: { ...headers, [NONCE_HEADER]: '0'.repeat(32) }, secret, now }),
    ).toEqual({ ok: false, reason: 'bad_signature' })
  })

  it('подпись тела старым способом не подходит как подпись запроса', () => {
    const headers = { ...signBody(body, secret, now), [NONCE_HEADER]: '0'.repeat(32) }
    expect(verifySignedRequest({ ...request, headers, secret, now })).toEqual({ ok: false, reason: 'bad_signature' })
  })

  it('без разовой метки — missing; старая отметка — stale', () => {
    const headers = signRequest({ ...request, secret, now })
    const { [NONCE_HEADER]: _nonce, ...withoutNonce } = headers
    expect(verifySignedRequest({ ...request, headers: withoutNonce, secret, now })).toEqual({ ok: false, reason: 'missing' })
    const old = signRequest({ ...request, secret, now: now - 301_000 })
    expect(verifySignedRequest({ ...request, headers: old, secret, now })).toEqual({ ok: false, reason: 'stale' })
  })

  it('две подписи одного запроса различаются разовой меткой', () => {
    const first = signRequest({ ...request, secret, now })
    const second = signRequest({ ...request, secret, now })
    expect(first[SIGNATURE_HEADER]).not.toBe(second[SIGNATURE_HEADER])
  })
})

describe('signResponse / verifySignedResponse', () => {
  const request = { method: 'GET', target: '/v1/reports?after=0&limit=50', nonce: 'a'.repeat(32) }
  const answer = JSON.stringify({ reports: [] })

  it('ответ привязан к запросу, статусу и телу', () => {
    const headers = signResponse({ request, status: 200, body: answer, secret, now })
    expect(verifySignedResponse({ request, status: 200, body: answer, headers, secret, now })).toEqual({ ok: true })
    expect(verifySignedResponse({ request, status: 201, body: answer, headers, secret, now })).toEqual({ ok: false, reason: 'bad_signature' })
    expect(verifySignedResponse({ request, status: 200, body: '{}', headers, secret, now })).toEqual({ ok: false, reason: 'bad_signature' })
    expect(
      verifySignedResponse({ request: { ...request, nonce: 'b'.repeat(32) }, status: 200, body: answer, headers, secret, now }),
    ).toEqual({ ok: false, reason: 'bad_signature' })
    expect(verifySignedResponse({ request, status: 200, body: answer, headers: {}, secret, now })).toEqual({ ok: false, reason: 'missing' })
  })
})

describe('ReplayGuard', () => {
  it('пропускает подпись один раз за окно и забывает её после окна', () => {
    const guard = new ReplayGuard(1_000)
    expect(guard.firstSeen('sig-1', now)).toBe(true)
    expect(guard.firstSeen('sig-1', now + 500)).toBe(false)
    expect(guard.firstSeen('sig-2', now + 500)).toBe(true)
    expect(guard.firstSeen('sig-1', now + 1_001)).toBe(true)
  })

  it('память полна — новый ключ отвергается как full, принятые раньше не вытесняются', () => {
    const guard = new ReplayGuard(1_000, 2)
    expect(guard.remember('a', now)).toBe('first')
    expect(guard.remember('b', now)).toBe('first')
    expect(guard.remember('c', now + 10)).toBe('full')
    expect(guard.firstSeen('c', now + 10)).toBe(false)
    // Вытеснения нет: принятый ключ всё ещё узнаётся как повтор.
    expect(guard.remember('a', now + 20)).toBe('replayed')
    expect(guard.wasSeen('a', now + 20)).toBe(true)
    // Окно прошло — место освободилось.
    expect(guard.remember('c', now + 1_001)).toBe('first')
  })
})

describe('строгий вид подписи', () => {
  const request = { method: 'POST', target: '/v1/reports/ack', body }
  const variants = (signature: string) => [
    signature.toUpperCase().replace('SHA256=', 'sha256='),
    `${signature}zz`,
    `${signature}00`,
    signature.slice(0, -2),
    ` ${signature}`,
    `${signature}\n`,
  ]

  it('подпись запроса — ровно sha256= и 64 строчных hex-знака; переписанная подпись не проходит', () => {
    const headers = signRequest({ ...request, secret, now })
    for (const changed of variants(headers[SIGNATURE_HEADER])) {
      expect(verifySignedRequest({ ...request, headers: { ...headers, [SIGNATURE_HEADER]: changed }, secret, now }), changed).toEqual({ ok: false, reason: 'bad_signature' })
    }
  })

  it('то же для подписи тела и подписи ответа', () => {
    const signed = signBody(body, secret, now)
    for (const changed of variants(signed[SIGNATURE_HEADER])) {
      expect(verifySignedBody({ body, headers: { ...signed, [SIGNATURE_HEADER]: changed }, secret, now }), changed).toEqual({ ok: false, reason: 'bad_signature' })
    }
    const ref = { method: 'GET', target: '/v1/reports', nonce: 'a'.repeat(32) }
    const answer = signResponse({ request: ref, status: 200, body: '{}', secret, now })
    for (const changed of variants(answer[SIGNATURE_HEADER])) {
      expect(verifySignedResponse({ request: ref, status: 200, body: '{}', headers: { ...answer, [SIGNATURE_HEADER]: changed }, secret, now }), changed).toEqual({ ok: false, reason: 'bad_signature' })
    }
  })
})

describe('запрос старше запуска принимающей стороны', () => {
  const request = { method: 'GET', target: '/v1/reports?after=0', body: '' }

  it('отметка времени раньше секунды запуска — stale, даже если подпись верна и не старше 5 минут', () => {
    const startedAt = now
    const before = signRequest({ ...request, secret, now: now - 10_000 })
    const sameSecond = signRequest({ ...request, secret, now: now + 300 })
    const later = signRequest({ ...request, secret, now: now + 2_000 })

    expect(verifySignedRequest({ ...request, headers: before, secret, now: now + 1_000, notBefore: startedAt })).toEqual({ ok: false, reason: 'stale' })
    expect(verifySignedRequest({ ...request, headers: sameSecond, secret, now: now + 1_000, notBefore: startedAt })).toEqual({ ok: true })
    expect(verifySignedRequest({ ...request, headers: later, secret, now: now + 2_000, notBefore: startedAt })).toEqual({ ok: true })
  })

  it('без notBefore поведение прежнее', () => {
    const before = signRequest({ ...request, secret, now: now - 10_000 })
    expect(verifySignedRequest({ ...request, headers: before, secret, now })).toEqual({ ok: true })
  })
})

describe('ReplayGuard: проверка без записи', () => {
  it('wasSeen только смотрит и ничего не запоминает', () => {
    const guard = new ReplayGuard(1_000)
    expect(guard.wasSeen('n-1', now)).toBe(false)
    expect(guard.firstSeen('n-1', now)).toBe(true)
    expect(guard.wasSeen('n-1', now + 500)).toBe(true)
    expect(guard.wasSeen('n-1', now + 1_001)).toBe(false)
  })
})

describe('precheckSignedRequest', () => {
  const request = { method: 'POST', target: '/v1/reports/ack', body }
  const headers = () => signRequest({ ...request, secret, now })

  it('верные по виду и времени заголовки проходят без секрета и тела', () => {
    expect(precheckSignedRequest({ headers: headers(), now })).toEqual({ ok: true })
  })

  it('нет заголовка — missing; нечитаемый вид подписи, отметки или метки — bad_signature', () => {
    const good = headers()
    expect(precheckSignedRequest({ headers: { ...good, [NONCE_HEADER]: undefined }, now })).toEqual({ ok: false, reason: 'missing' })
    expect(precheckSignedRequest({ headers: { ...good, [SIGNATURE_HEADER]: good[SIGNATURE_HEADER].toUpperCase() }, now })).toEqual({ ok: false, reason: 'bad_signature' })
    expect(precheckSignedRequest({ headers: { ...good, [TIMESTAMP_HEADER]: '12ab' }, now })).toEqual({ ok: false, reason: 'bad_signature' })
    expect(precheckSignedRequest({ headers: { ...good, [NONCE_HEADER]: 'short' }, now })).toEqual({ ok: false, reason: 'bad_signature' })
  })

  it('старая отметка и отметка раньше notBefore — stale', () => {
    expect(precheckSignedRequest({ headers: headers(), now: now + 10 * 60_000 })).toEqual({ ok: false, reason: 'stale' })
    expect(precheckSignedRequest({ headers: headers(), now, notBefore: now + 5_000 })).toEqual({ ok: false, reason: 'stale' })
  })
})
