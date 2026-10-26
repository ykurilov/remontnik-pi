import { describe, expect, it } from 'vitest'
import {
  NONCE_HEADER,
  ReplayGuard,
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
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
})
