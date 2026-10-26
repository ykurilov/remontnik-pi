import { signRequest } from '@ykurilov/remontnik-core/signed-http'
import type { HandoffTaskBody } from './task-text.js'

// Вызовы врача к мосту Paseo (contracts/paseo-bridge.md): подписанные запросы секретом моста этого приложения.
// По перенаправлениям врач не ходит: иначе подпись ушла бы на чужой адрес. Любой сбой — «мост недоступен»:
// врач тогда лечит сам, причина ошибки в отчёт не идёт.

export const BRIDGE_HEALTH_TIMEOUT_MS = 3_000
const BRIDGE_TIMEOUT_MS = 10_000
const BRIDGE_MAX_ANSWER_BYTES = 64 * 1024

export interface PaseoBridgeClient {
  /** Мост жив и агент приложения на месте (свободен или занят). */
  health(): Promise<boolean>
  /** Мост поставил задачу в очередь агенту. */
  sendTask(task: HandoffTaskBody): Promise<boolean>
  /** Мост принял отмену (или задачи у него уже нет). */
  cancel(taskId: string, reason: string): Promise<boolean>
}

export interface PaseoBridgeClientOptions {
  url: string
  secret: string
  appName: string
  fetch?: typeof fetch
  healthTimeoutMs?: number
  timeoutMs?: number
}

export function createPaseoBridgeClient(options: PaseoBridgeClientOptions): PaseoBridgeClient {
  if (options.secret === '') throw new Error('[remontnik] секрет моста пуст')
  const fetchImpl = options.fetch ?? fetch
  const base = options.url.replace(/\/+$/, '')

  async function call(method: 'GET' | 'POST', target: string, payload: unknown, timeoutMs: number): Promise<{ status: number; body: unknown } | null> {
    const body = method === 'POST' ? JSON.stringify(payload) : ''
    try {
      const response = await fetchImpl(`${base}${target}`, {
        method,
        headers: { 'content-type': 'application/json', ...signRequest({ method, target, body, secret: options.secret }) },
        ...(method === 'POST' ? { body } : {}),
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
      })
      const text = await response.text()
      if (Buffer.byteLength(text) > BRIDGE_MAX_ANSWER_BYTES) return null
      let parsed: unknown = null
      try {
        parsed = text === '' ? null : JSON.parse(text)
      } catch {
        parsed = null
      }
      return { status: response.status, body: parsed }
    } catch {
      return null
    }
  }

  const field = (body: unknown, name: string): unknown =>
    body !== null && typeof body === 'object' ? (body as Record<string, unknown>)[name] : undefined

  return {
    async health() {
      const answer = await call('GET', `/health?app=${encodeURIComponent(options.appName)}`, undefined, options.healthTimeoutMs ?? BRIDGE_HEALTH_TIMEOUT_MS)
      const agent = field(answer?.body, 'agent')
      return answer?.status === 200 && field(answer.body, 'paseo') === 'up' && (agent === 'idle' || agent === 'running')
    },
    async sendTask(task) {
      const answer = await call('POST', '/v1/tasks', task, options.timeoutMs ?? BRIDGE_TIMEOUT_MS)
      return answer?.status === 200 && field(answer.body, 'queued') === true
    },
    async cancel(taskId, reason) {
      const answer = await call('POST', `/v1/tasks/${encodeURIComponent(taskId)}/cancel`, { app: options.appName, taskId, reason }, options.timeoutMs ?? BRIDGE_TIMEOUT_MS)
      // 404: у моста этой задачи нет (не дошла или мост потерял состояние) — отменять нечего.
      return answer !== null && (answer.status === 200 || answer.status === 404)
    },
  }
}
