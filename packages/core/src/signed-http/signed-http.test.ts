import { describe, expect, it } from 'vitest'
import { SIGNATURE_HEADER, TIMESTAMP_HEADER, signBody, verifySignedBody } from './index.js'

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
