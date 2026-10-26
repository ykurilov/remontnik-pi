import { signRequest } from '@ykurilov/remontnik-core/signed-http'
import { STOP_DEPLOYS_CALLBACK } from '@ykurilov/remontnik-core/telegram'

// Кнопка стоп-крана под отчётами врача. Бот тревог принадлежит приложению, поэтому нажатие приходит к нему,
// а приложение отдаёт его сюда. Сторож проверяет, что нажали в чате тревог, и шлёт врачу подписанный общим
// секретом `POST /v1/control/deploys` `{ action: "stop" }`. Снова пустить выкатки кнопкой нельзя: это только
// секретом владельца (`remontnik-doctor deploys resume`). Обработчик не бросает: ошибка — текст ответа и строка в журнал.

const CONTROL_PATH = '/v1/control/deploys'
const REQUEST_TIMEOUT_MS = 10_000
const BY_MAX_LENGTH = 100

export const STOP_BUTTON_TEXTS = Object.freeze({
  stopped: 'Автовыкатка остановлена. Снова включить — командой remontnik-doctor deploys resume с секретом владельца.',
  wrongChat: 'Эта кнопка работает только в чате тревог.',
  failed: 'Не получилось остановить: врач не ответил. Остановите из консоли: remontnik-doctor deploys stop.',
})

/** Нужное из `callback_query` Bot API. */
export interface StopButtonQuery {
  data?: string
  from?: { id?: number; username?: string }
  message?: { chat?: { id?: number | string } }
}

export interface StopButtonOptions {
  doctor: { url: string; secret: string }
  alertChatId(): Promise<string | null>
  fetch: typeof fetch
  now: () => number
  onError(what: string, error?: unknown): void
}

/** `null` — кнопка не наша, приложение разбирает её само; строка — текст для `answerCallbackQuery`. */
export type StopButtonHandler = (query: unknown) => Promise<string | null>

function presser(query: StopButtonQuery): string {
  const who = query.from?.username ? `@${query.from.username}` : String(query.from?.id ?? 'неизвестно')
  return `telegram:${who}`.slice(0, BY_MAX_LENGTH)
}

export function createStopButtonHandler(options: StopButtonOptions): StopButtonHandler {
  const url = `${options.doctor.url.replace(/\/+$/, '')}${CONTROL_PATH}`

  return async (raw) => {
    if (typeof raw !== 'object' || raw === null) return null
    const query = raw as StopButtonQuery
    if (query.data !== STOP_DEPLOYS_CALLBACK) return null
    try {
      const alertChat = await options.alertChatId()
      const pressedIn = query.message?.chat?.id
      if (alertChat === null || pressedIn === undefined || String(pressedIn) !== alertChat) return STOP_BUTTON_TEXTS.wrongChat
      const body = JSON.stringify({ action: 'stop', by: presser(query) })
      const response = await options.fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...signRequest({ method: 'POST', target: CONTROL_PATH, body, secret: options.doctor.secret, now: options.now() }),
        },
        body,
        redirect: 'manual',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
      if (!response.ok) throw new Error(`врач ответил ${response.status}`)
      return STOP_BUTTON_TEXTS.stopped
    } catch (error) {
      options.onError('кнопка стоп-крана не сработала', error)
      return STOP_BUTTON_TEXTS.failed
    }
  }
}
