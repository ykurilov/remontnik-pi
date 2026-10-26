// Отказы замка с последнего действия. Страница может отказываться тысячами, поэтому одинаковые отказы сливаются
// в одну запись со счётчиком, разных записей не больше предела, а журнал службы получает только первую запись
// каждого отказа и одну — о переполнении.
import type { BlockedRequest } from '../guard/index.js'

export const BLOCKED_ENTRIES_LIMIT = 50

export interface BlockedJournal {
  record(request: BlockedRequest): void
  /** Отказы с прошлого вызова: повторы — с `(×N)` в причине, сверх предела — одна итоговая запись. */
  take(): BlockedRequest[]
}

export function createBlockedJournal(onFirst: (request: BlockedRequest) => void, onOverflow: () => void, limit = BLOCKED_ENTRIES_LIMIT): BlockedJournal {
  let entries = new Map<string, { request: BlockedRequest; count: number }>()
  let dropped = 0
  return {
    record(request) {
      const key = `${request.code}\n${request.reason}`
      const entry = entries.get(key)
      if (entry) {
        entry.count += 1
        return
      }
      if (entries.size < limit) {
        entries.set(key, { request, count: 1 })
        onFirst(request)
        return
      }
      if (dropped === 0) onOverflow()
      dropped += 1
    },
    take() {
      const taken = [...entries.values()].map(({ request, count }) => (count > 1 ? { ...request, reason: `${request.reason} (×${count})` } : request))
      if (dropped > 0) taken.push({ code: taken[0]!.code, reason: `ещё ${dropped} отказов не записаны: больше ${limit} разных` })
      entries = new Map()
      dropped = 0
      return taken
    },
  }
}
