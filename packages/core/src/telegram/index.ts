import { redactSecrets } from '../redact/index.js'
import { truncateText } from '../incident/index.js'

export const TELEGRAM_MESSAGE_LIMIT = 4096
export const DEFAULT_TELEGRAM_API_BASE_URL = 'https://api.telegram.org'

/** `callback_data` кнопки стоп-крана: её ставит врач под отчётами, нажатие разбирает сторож в приложении. */
export const STOP_DEPLOYS_CALLBACK = 'remontnik:stop'

/** Кнопка «Остановить автовыкатку» для `replyMarkup`. */
export function stopDeploysKeyboard(): { inline_keyboard: { text: string; callback_data: string }[][] } {
  return { inline_keyboard: [[{ text: 'Остановить автовыкатку', callback_data: STOP_DEPLOYS_CALLBACK }]] }
}

export interface TelegramOptions {
  botToken: string
  /** Адрес Bot API или прокси перед ним. */
  apiBaseUrl?: string
  /** Ключ прокси, уходит заголовком `X-Proxy-Token`. */
  proxyToken?: string
  timeoutMs?: number
  fetch?: typeof fetch
}

export interface SendMessageOptions {
  /** Кнопки под сообщением, как в Bot API (`reply_markup`). */
  replyMarkup?: unknown
  disableNotification?: boolean
}

export interface TelegramClient {
  sendMessage(chatId: string, text: string, options?: SendMessageOptions): Promise<{ messageId: number }>
}

/** Ошибка отправки. Токен бота и ключ прокси из текста вырезаны. */
export class TelegramError extends Error {
  readonly status: number | null
  readonly retryAfterSec: number | null

  constructor(message: string, status: number | null = null, retryAfterSec: number | null = null) {
    super(message)
    this.name = 'TelegramError'
    this.status = status
    this.retryAfterSec = retryAfterSec
  }
}

/** Текст не длиннее предела Telegram, с пометкой об обрезке. */
export function truncateForTelegram(text: string, limit: number = TELEGRAM_MESSAGE_LIMIT): string {
  return truncateText(text, limit)
}

export function createTelegramClient(options: TelegramOptions): TelegramClient {
  const fetchImpl = options.fetch ?? fetch
  const baseUrl = (options.apiBaseUrl ?? DEFAULT_TELEGRAM_API_BASE_URL).replace(/\/+$/, '')
  const knownSecrets = [options.botToken, options.botToken.split(':')[1] ?? '', options.proxyToken ?? '']
  const clean = (text: string): string => redactSecrets(text, { knownSecrets })

  return {
    async sendMessage(chatId, text, sendOptions = {}) {
      const headers: Record<string, string> = { 'content-type': 'application/json' }
      if (options.proxyToken) headers['x-proxy-token'] = options.proxyToken
      const body: Record<string, unknown> = {
        chat_id: chatId,
        text: truncateForTelegram(text),
        disable_web_page_preview: true,
      }
      if (sendOptions.replyMarkup !== undefined) body.reply_markup = sendOptions.replyMarkup
      if (sendOptions.disableNotification) body.disable_notification = true

      let response: Response
      try {
        response = await fetchImpl(`${baseUrl}/bot${options.botToken}/sendMessage`, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(options.timeoutMs ?? 15_000),
        })
      } catch (error) {
        throw new TelegramError(`Telegram недоступен: ${clean(error instanceof Error ? error.message : String(error))}`)
      }

      const payload = (await response.json().catch(() => null)) as {
        ok?: boolean
        description?: string
        parameters?: { retry_after?: number }
        result?: { message_id?: number }
      } | null
      if (!response.ok || !payload?.ok || typeof payload.result?.message_id !== 'number') {
        throw new TelegramError(
          `Telegram отклонил сообщение: ${response.status} ${clean(payload?.description ?? '')}`.trim(),
          response.status,
          payload?.parameters?.retry_after ?? null,
        )
      }
      return { messageId: payload.result.message_id }
    },
  }
}
