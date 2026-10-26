import { describe, expect, it } from 'vitest'
import {
  INCIDENT_LIMITS,
  createIncidentEvent,
  fingerprint,
  newEventId,
  normalizeErrorText,
  whereFromStack,
} from './index.js'

describe('normalizeErrorText', () => {
  it('вырезает числа, адреса и идентификаторы', () => {
    const text = [
      'User 4821 not found',
      'request 0f8fad5b-d9cb-469f-a165-70867728950e',
      'event 01JB2XKQ9Z8M4N6P7R3S5T1V0W',
      'object 5f3a9c2e7b1d',
      'GET https://app.example.com/api/orders/77?x=1 failed',
      'connect ECONNREFUSED 10.0.0.12:5432',
      'mail owner@example.com',
    ].join('; ')

    const normalized = normalizeErrorText(text)

    expect(normalized).not.toMatch(/\d/)
    expect(normalized).not.toContain('example.com')
    expect(normalized).not.toContain('5f3a9c2e7b1d')
    expect(normalized).toContain('not found')
    expect(normalized).toContain('ECONNREFUSED')
  })

  it('сводит пробелы', () => {
    expect(normalizeErrorText('  a \n\t b  ')).toBe('a b')
  })
})

describe('fingerprint', () => {
  it('sha256, 16 шестнадцатеричных символов', () => {
    expect(fingerprint({ kind: 'crash', where: 'src/a.ts', message: 'boom' })).toMatch(/^[0-9a-f]{16}$/)
  })

  it('одинаковый сбой с разными числами и идентификаторами — одинаковый отпечаток', () => {
    const first = fingerprint({
      kind: 'crash',
      where: 'src/orders.ts:12:5',
      message: 'Order 17 for user 0f8fad5b-d9cb-469f-a165-70867728950e failed',
    })
    const second = fingerprint({
      kind: 'crash',
      where: 'src/orders.ts:14:9',
      message: 'Order 912 for user 7c9e6679-7425-40de-944b-e07fc1f90ae7 failed',
    })

    expect(first).toBe(second)
  })

  it('разный вид, место или текст — разный отпечаток', () => {
    const base = { kind: 'crash' as const, where: 'src/a.ts', message: 'boom' }

    expect(fingerprint(base)).not.toBe(fingerprint({ ...base, kind: 'tool_error' }))
    expect(fingerprint(base)).not.toBe(fingerprint({ ...base, where: 'src/b.ts' }))
    expect(fingerprint(base)).not.toBe(fingerprint({ ...base, message: 'bang' }))
  })
})

describe('whereFromStack', () => {
  it('берёт первую строку следа внутри кода приложения', () => {
    const stack = [
      'TypeError: boom',
      '    at node:internal/process/task_queues:95:5',
      '    at handler (/srv/app/node_modules/framework/index.js:10:3)',
      '    at chargeCard (/srv/app/src/payments/charge.ts:21:11)',
      '    at main (/srv/app/src/main.ts:3:1)',
    ].join('\n')

    expect(whereFromStack(stack, '/srv/app')).toBe('src/payments/charge.ts:21:11 chargeCard')
  })

  it('без кода приложения в следе — пустая строка', () => {
    expect(whereFromStack('Error: x\n    at node:internal/foo:1:1', '/srv/app')).toBe('')
  })
})

describe('newEventId', () => {
  it('ULID: 26 символов Crockford, растёт со временем', () => {
    const early = newEventId(1_700_000_000_000)
    const late = newEventId(1_700_000_000_001)

    expect(early).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/)
    expect(late > early).toBe(true)
    expect(newEventId()).not.toBe(newEventId())
  })
})

describe('createIncidentEvent', () => {
  it('заполняет поля и считает отпечаток', () => {
    const event = createIncidentEvent({
      appName: 'patient',
      kind: 'model_error',
      where: 'patient-fake-model',
      message: 'provider returned 503',
      context: { processName: 'web', model: 'patient-fake-model' },
      occurredAt: new Date('2026-10-26T10:00:00Z'),
    })

    expect(event.eventId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/)
    expect(event.fingerprint).toBe(
      fingerprint({ kind: 'model_error', where: 'patient-fake-model', message: 'provider returned 503' }),
    )
    expect(event.stack).toBe('')
    expect(event.occurredAt).toBe('2026-10-26T10:00:00.000Z')
  })

  it('обрезает message до 2000, stack до 8000, context до 4 КБ', () => {
    expect(INCIDENT_LIMITS).toMatchObject({ message: 2000, stack: 8000, contextBytes: 4096 })

    const event = createIncidentEvent({
      appName: 'patient',
      kind: 'crash',
      where: 'src/a.ts',
      message: 'm'.repeat(5000),
      stack: 's'.repeat(20_000),
      context: { processName: 'web', release: 'abc', note: 'x'.repeat(10_000), extra: 'y'.repeat(10_000) },
    })

    expect(event.message.length).toBeLessThanOrEqual(2000)
    expect(event.stack.length).toBeLessThanOrEqual(8000)
    expect(Buffer.byteLength(JSON.stringify(event.context))).toBeLessThanOrEqual(4096)
    expect(event.context.processName).toBe('web')
    expect(event.context.release).toBe('abc')
  })

  it('вычищает секреты из текста, следа и контекста до обрезки', () => {
    const secret = ['sk', 'live', 'a'.repeat(32)].join('-')
    const event = createIncidentEvent({
      appName: 'patient',
      kind: 'crash',
      where: 'src/a.ts',
      message: `bad key ${secret} for owner@example.com`,
      stack: `Error: ${secret}`,
      context: { chatId: 'c1', note: `key=${secret}` },
    })

    const serialized = JSON.stringify(event)
    expect(serialized).not.toContain(secret)
    expect(serialized).not.toContain('owner@example.com')
  })

  it('принимает дополнительную вычистку приложения', () => {
    const event = createIncidentEvent(
      { appName: 'patient', kind: 'manual', where: 'x', message: 'client Ivanov' },
      { redact: (text) => text.replaceAll('Ivanov', '[имя]') },
    )

    expect(event.message).toBe('client [имя]')
  })

  it('обрезает отрывок плохого ответа до 500 и ограничивает уверенность', () => {
    const event = createIncidentEvent({
      appName: 'patient',
      kind: 'bad_answer',
      where: 'bot',
      message: 'bot invented a price',
      badAnswer: {
        conversationId: 'conv-1',
        messageIndex: 3,
        category: 'invented_fact',
        excerpt: 'e'.repeat(2000),
        explanation: 'цена выдумана',
        confidence: 1.7,
      },
    })

    expect(event.badAnswer?.excerpt.length).toBeLessThanOrEqual(500)
    expect(event.badAnswer?.confidence).toBe(1)
  })
})
