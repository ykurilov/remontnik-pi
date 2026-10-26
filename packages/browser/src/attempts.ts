// Ограничение подбора ключа: неудачные попытки считаются отдельно по адресу клиента,
// поэтому чужие ошибки из той же сети не закрывают вход владельцу или врачу.

export interface AttemptLimiter {
  blocked(client: string): boolean
  fail(client: string): void
  /** Сколько адресов сейчас помним — для проверки, что память не растёт. */
  size(): number
}

export function createAttemptLimiter(options: { limit: number; windowMs: number; now?: () => number }): AttemptLimiter {
  const { limit, windowMs } = options
  const now = options.now ?? Date.now
  const failures = new Map<string, number[]>()

  const recent = (client: string) => {
    const since = now() - windowMs
    const times = (failures.get(client) ?? []).filter((time) => time > since)
    if (times.length === 0) failures.delete(client)
    else failures.set(client, times)
    return times
  }

  return {
    blocked: (client) => recent(client).length >= limit,
    fail(client) {
      for (const known of [...failures.keys()]) recent(known)
      failures.set(client, [...recent(client), now()])
    },
    size: () => failures.size,
  }
}
