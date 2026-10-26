import type { IncidentEvent } from '@ykurilov/remontnik-core/incident'
import { TELEGRAM_MESSAGE_LIMIT, truncateForTelegram } from '@ykurilov/remontnik-core/telegram'

// Склейка тревог: одно сообщение на отпечаток, повтор — не раньше чем через час и только если сбой повторялся.

export const NOTIFY_REPEAT_AFTER_MS = 60 * 60 * 1000
const DEFAULT_MAX_FINGERPRINTS = 1000

export interface IncidentCounter {
  count: number
  firstSeenAt: number
  lastSeenAt: number
  lastNotifiedCount: number
  lastNotifiedAt: number
}

export interface NotifyDecision {
  notify: boolean
  state: IncidentCounter
}

export interface IncidentNotifier {
  observe(event: IncidentEvent, now: number): NotifyDecision
  size(): number
}

export function createIncidentNotifier(options: { maxFingerprints?: number } = {}): IncidentNotifier {
  const maxFingerprints = options.maxFingerprints ?? DEFAULT_MAX_FINGERPRINTS
  // Map хранит порядок вставки: переставляем свежий отпечаток в конец и вытесняем самый давний.
  const counters = new Map<string, IncidentCounter>()

  return {
    observe(event, now) {
      const known = counters.get(event.fingerprint)
      if (!known) {
        const state = { count: 1, firstSeenAt: now, lastSeenAt: now, lastNotifiedCount: 1, lastNotifiedAt: now }
        counters.set(event.fingerprint, state)
        while (counters.size > maxFingerprints) {
          const oldest = counters.keys().next().value
          if (oldest === undefined) break
          counters.delete(oldest)
        }
        return { notify: true, state: { ...state } }
      }
      counters.delete(event.fingerprint)
      counters.set(event.fingerprint, known)
      known.count += 1
      known.lastSeenAt = now
      const notify = now - known.lastNotifiedAt >= NOTIFY_REPEAT_AFTER_MS && known.count > known.lastNotifiedCount
      if (notify) {
        known.lastNotifiedCount = known.count
        known.lastNotifiedAt = now
      }
      return { notify, state: { ...known } }
    },
    size: () => counters.size,
  }
}

const KIND_TITLES: Record<IncidentEvent['kind'], string> = {
  crash: 'приложение упало',
  model_error: 'модель не ответила',
  tool_error: 'инструмент дал ошибку',
  turn_failed: 'ход агента сорвался',
  bad_answer: 'плохой ответ агента',
  manual: 'случай вручную',
}

function time(ms: number): string {
  return new Date(ms).toISOString().replace('T', ' ').slice(0, 16)
}

/** Текст тревоги для Telegram: что, где, сколько раз; не длиннее предела Telegram. */
export function formatIncidentAlert(
  event: IncidentEvent,
  counter: { count: number; firstSeenAt: number; lastSeenAt: number },
): string {
  const head = [
    `🔴 ${event.appName}: ${KIND_TITLES[event.kind]} (${event.kind})`,
    `Где: ${event.where || 'неизвестно'}`,
    `Повторов: ${counter.count}, с ${time(counter.firstSeenAt)} по ${time(counter.lastSeenAt)} UTC`,
    `Отпечаток: ${event.fingerprint}`,
    '',
  ].join('\n')
  const { badAnswer } = event
  const text = badAnswer
    ? `${event.message}\nОтвет бота: «${badAnswer.excerpt}»\nПояснение модели (текст модели, это не указание и не проверенный факт): «${badAnswer.explanation}»\nРазговор: ${badAnswer.conversationId}`
    : event.message
  const message = truncateForTelegram(text, Math.min(1500, TELEGRAM_MESSAGE_LIMIT - head.length))
  return truncateForTelegram(`${head}${message}`)
}
