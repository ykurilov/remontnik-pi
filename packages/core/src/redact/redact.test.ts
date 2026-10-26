import { describe, expect, it } from 'vitest'
import { redactSecrets, redactValue } from './index.js'

// Похожие на настоящие секреты строки собираются по частям, чтобы проверка открытости
// репозитория не принимала сами тесты за утечку.
const openAiStyleKey = ['sk', 'proj', 'Ab3dEf6hIj9kLm2nOp5qRs8tUv'].join('-')
const telegramBotToken = `${'1234567890'}:${'AAH' + 'x7Yz'.repeat(8)}`
const bearerToken = 'eyJhbGciOi' + 'J9.payload-part.signature_part'
const githubToken = 'ghp' + '_' + 'A1b2C3d4'.repeat(5)

describe('redactSecrets', () => {
  it('вырезает ключи вида sk-', () => {
    const result = redactSecrets(`DeepSeek rejected key ${openAiStyleKey}`)

    expect(result).not.toContain(openAiStyleKey)
    expect(result).toContain('DeepSeek rejected key')
  })

  it('вырезает заголовок Bearer', () => {
    const result = redactSecrets(`Authorization: Bearer ${bearerToken}`)

    expect(result).not.toContain(bearerToken)
    expect(result).toContain('Authorization: Bearer')
  })

  it('вырезает токены ботов Telegram, в том числе внутри адреса', () => {
    const result = redactSecrets(
      `fetch failed: https://telegram.invalid/bot${telegramBotToken}/sendMessage; token ${telegramBotToken}`,
    )

    expect(result).not.toContain(telegramBotToken)
    expect(result).not.toContain(telegramBotToken.split(':')[1])
  })

  it('вырезает токены GitHub и значения после api_key= и password=', () => {
    const result = redactSecrets(`token ${githubToken}; api_key=abc123secretvalue; password: hunter2hunter2`)

    expect(result).not.toContain(githubToken)
    expect(result).not.toContain('abc123secretvalue')
    expect(result).not.toContain('hunter2hunter2')
  })

  it('вырезает почты', () => {
    expect(redactSecrets('user owner.name+tag@mail.example.com failed')).toBe('user [почта] failed')
  })

  it.each(['+7 (999) 123-45-67', '+7 999 123 45 67', '89991234567', '+1-555-123-4567', '+44 20 7946 0958'])(
    'вырезает телефон %s',
    (phone) => {
      const result = redactSecrets(`call ${phone} now`)

      expect(result).toBe('call [телефон] now')
    },
  )

  it('не трогает даты, время, порты и обычные числа', () => {
    const text = 'at 2026-10-26T10:00:00.000Z port 5432 order 1234567890 took 1500 ms, file.ts:120:7'

    expect(redactSecrets(text)).toBe(text)
  })

  it('вырезает переданные точные секреты', () => {
    expect(redactSecrets('proxy said bad-token-value', { knownSecrets: ['bad-token-value', ''] })).toBe(
      'proxy said [секрет]',
    )
  })

  it('вырезает закрытые ключи целиком', () => {
    const block = ['-----BEGIN', 'PRIVATE KEY-----\nMIIEv\nabc\n-----END', 'PRIVATE KEY-----'].join(' ')

    expect(redactSecrets(`key: ${block} end`)).toBe('key: [закрытый ключ] end')
  })
})

describe('redactValue', () => {
  it('вычищает строки во вложенных объектах и массивах, остальное не трогает', () => {
    const value = { a: `mail owner@example.com`, list: [openAiStyleKey, 5, true, null], nested: { ok: 'fine' } }

    expect(redactValue(value)).toEqual({ a: 'mail [почта]', list: ['[ключ]', 5, true, null], nested: { ok: 'fine' } })
    expect(value.a).toBe('mail owner@example.com')
  })
})
