// Предел запросов с одного адреса за окно. Память ограничена: устаревшие адреса выметаются, а когда новых
// адресов больше, чем мест, новый адрес получает отказ — старые счётчики не вытесняются и не обнуляются.

export interface RateLimitSettings {
  /** Сколько запросов с одного адреса за окно. */
  limit: number
  windowMs: number
  /** Сколько адресов помнить сразу. */
  maxClients?: number
}

export const DEFAULT_CONTROL_RATE_LIMIT: RateLimitSettings = { limit: 60, windowMs: 60_000 }

export function createRateLimiter(settings: RateLimitSettings): (client: string, now?: number) => boolean {
  const maxClients = settings.maxClients ?? 10_000
  /** Адрес → начало окна и счёт; порядок вставки — порядок начала окон. */
  const windows = new Map<string, { startedAt: number; count: number }>()

  return (client, now = Date.now()) => {
    for (const [old, window] of windows) {
      if (window.startedAt + settings.windowMs > now) break
      windows.delete(old)
    }
    const window = windows.get(client)
    if (window) {
      window.count += 1
      return window.count <= settings.limit
    }
    if (windows.size >= maxClients) return false
    windows.set(client, { startedAt: now, count: 1 })
    return settings.limit >= 1
  }
}
