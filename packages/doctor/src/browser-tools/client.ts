// Клиент службы браузера (contracts/browser-api.md): `POST /v1/<команда>` с ключом врача.
// Любая беда связи — служба не отвечает, ключ не подошёл, ответ не JSON — это `unavailable`: врач лечит без браузера.

export type BrowserAnswer = { ok: true; [field: string]: unknown } | { ok: false; code: string; message: string }

/** Подресурсы, которые замок браузера закрыл после входа: строки-подсказки, что вписать в extraOrigins. */
export function blockedOf(answer: BrowserAnswer): string[] {
  const blocked = answer.ok ? answer.blocked : undefined
  return Array.isArray(blocked) ? blocked.filter((line): line is string => typeof line === 'string') : []
}

export interface BrowserClient {
  /** `signal` — врач закрывается: запрос обрывается сразу, а не по тайм-ауту, и вызов бросает причину отмены. */
  call(command: string, input: Record<string, unknown>, signal?: AbortSignal): Promise<BrowserAnswer>
}

/** Сколько ждать ответа службы: переход на медленную страницу и снимок укладываются. */
const CALL_TIMEOUT_MS = 60_000

const unavailable = (message: string): BrowserAnswer => ({ ok: false, code: 'unavailable', message: `браузер недоступен: ${message}` })

export function createBrowserClient(options: { url: string; token: string; timeoutMs?: number }): BrowserClient {
  const base = options.url.replace(/\/+$/, '')
  return {
    async call(command, input, signal) {
      let response: Response
      try {
        response = await fetch(`${base}/v1/${command}`, {
          method: 'POST',
          headers: { authorization: `Bearer ${options.token}`, 'content-type': 'application/json' },
          body: JSON.stringify(input),
          signal: AbortSignal.any([AbortSignal.timeout(options.timeoutMs ?? CALL_TIMEOUT_MS), ...(signal ? [signal] : [])]),
        })
      } catch (error) {
        // Отмена — не беда службы: вызов не завершён, инструмент повторится после перезапуска врача.
        if (signal?.aborted) throw signal.reason
        return unavailable('служба не отвечает')
      }
      if (response.status === 401 || response.status === 429) return unavailable('служба не приняла ключ врача')
      const body: unknown = await response.json().catch(() => undefined)
      signal?.throwIfAborted()
      if (!body || typeof body !== 'object' || typeof (body as { ok?: unknown }).ok !== 'boolean') return unavailable(`ответ службы не разобран (HTTP ${response.status})`)
      const answer = body as BrowserAnswer
      if (!answer.ok && response.status >= 500) return unavailable(answer.message)
      return answer
    },
  }
}

/** Клиент по окружению врача; без адреса или ключа службы браузера у врача нет. */
export function browserClientFromEnv(env: Readonly<Record<string, string | undefined>>): BrowserClient | undefined {
  const url = env.REMONTNIK_BROWSER_URL?.trim()
  const token = env.REMONTNIK_BROWSER_TOKEN?.trim()
  return url && token ? createBrowserClient({ url, token }) : undefined
}
