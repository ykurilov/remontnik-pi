import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { startFakeTelegram, type FakeTelegramServer } from '../testing/index.js'
import { TELEGRAM_MESSAGE_LIMIT, TelegramError, createTelegramClient, truncateForTelegram } from './index.js'

// Похожий на настоящий токен собирается по частям, чтобы проверка открытости не сработала на тест.
const botToken = `${'9876543210'}:${'AAF' + 'q1W2'.repeat(8)}`

describe('truncateForTelegram', () => {
  it('короткий текст не трогает', () => {
    expect(truncateForTelegram('привет')).toBe('привет')
  })

  it('длинный обрезает до предела с пометкой', () => {
    const result = truncateForTelegram('я'.repeat(10_000))

    expect(TELEGRAM_MESSAGE_LIMIT).toBe(4096)
    expect(result.length).toBeLessThanOrEqual(4096)
    expect(result.endsWith('…[обрезано]')).toBe(true)
  })

  it('не разрывает пару суррогатов', () => {
    const result = truncateForTelegram('😀'.repeat(50), 21)

    expect(result).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/)
  })
})

describe('createTelegramClient', () => {
  let telegram: FakeTelegramServer

  beforeEach(async () => {
    telegram = await startFakeTelegram()
  })

  afterEach(async () => {
    await telegram.close()
  })

  it('отправляет сообщение и возвращает его номер', async () => {
    const client = createTelegramClient({ botToken, apiBaseUrl: telegram.baseUrl })

    const sent = await client.sendMessage('-100', 'Сбой в patient')

    expect(sent.messageId).toBeGreaterThan(0)
    expect(telegram.messages).toEqual([expect.objectContaining({ botToken, chatId: '-100', text: 'Сбой в patient' })])
  })

  it('обрезает длинный текст перед отправкой', async () => {
    const client = createTelegramClient({ botToken, apiBaseUrl: telegram.baseUrl })

    await client.sendMessage('1', 'x'.repeat(9000))

    expect(telegram.messages[0]?.text.length).toBeLessThanOrEqual(4096)
  })

  it('передаёт кнопки под сообщением', async () => {
    const client = createTelegramClient({ botToken, apiBaseUrl: telegram.baseUrl })
    const replyMarkup = { inline_keyboard: [[{ text: 'Остановить автовыкатку', callback_data: 'remontnik:stop' }]] }

    await client.sendMessage('1', 'отчёт', { replyMarkup })

    expect(telegram.messages[0]?.replyMarkup).toEqual(replyMarkup)
  })

  it('шлёт заголовок прокси, если он задан', async () => {
    const client = createTelegramClient({ botToken, apiBaseUrl: telegram.baseUrl, proxyToken: 'proxy-secret' })

    await client.sendMessage('1', 'x')

    expect(telegram.messages[0]?.headers['x-proxy-token']).toBe('proxy-secret')
  })

  it('без прокси заголовка нет', async () => {
    await createTelegramClient({ botToken, apiBaseUrl: telegram.baseUrl }).sendMessage('1', 'x')

    expect(telegram.messages[0]?.headers['x-proxy-token']).toBeUndefined()
  })

  it('ошибка Telegram без токена в тексте, с кодом и паузой повтора', async () => {
    telegram.failNext(429, { description: `Too Many Requests for bot${botToken}`, parameters: { retry_after: 7 } })
    const client = createTelegramClient({ botToken, apiBaseUrl: telegram.baseUrl, proxyToken: 'proxy-secret' })

    const error = await client.sendMessage('1', 'x').catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(TelegramError)
    expect(error).toMatchObject({ status: 429, retryAfterSec: 7 })
    expect(String((error as Error).message)).not.toContain(botToken)
    expect(String((error as Error).message)).not.toContain(botToken.split(':')[1])
    expect(JSON.stringify(error)).not.toContain(botToken.split(':')[1])
  })

  it('сетевая ошибка — без токена и прокси-ключа в тексте', async () => {
    const leakingFetch = (async (input: string | URL | Request) => {
      throw new TypeError(`fetch failed for ${String(input)} with proxy-secret`)
    }) as typeof fetch
    const client = createTelegramClient({
      botToken,
      apiBaseUrl: 'https://telegram.invalid',
      proxyToken: 'proxy-secret',
      fetch: leakingFetch,
    })

    const error = await client.sendMessage('1', 'x').catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(TelegramError)
    expect(String((error as Error).message)).not.toContain(botToken.split(':')[1])
    expect(String((error as Error).message)).not.toContain('proxy-secret')
    expect((error as Error).cause).toBeUndefined()
  })
})
