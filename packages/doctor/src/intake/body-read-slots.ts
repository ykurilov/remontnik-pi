// Места для чтения чужих тел на путях управления. Подпись тела видна только после чтения, поэтому медленные тела
// держат соединения: число одновременных чтений с одного адреса и всего ограничено. Новый запрос сверх предела
// вытесняет самое старое чтение, которое идёт дольше `graceMs` и ещё не дочитано; вытеснять некого — отказ получает
// новый запрос. Скорость чтения не мерится: её подделывает пачка байт в начале. Команды владельца сюда не попадают —
// их заголовки подписаны отдельно, и врач читает их тела мимо общих мест.

export interface BodyReadSlotSettings {
  /** Сколько тел с одного адреса читается одновременно. */
  perAddress: number
  /** Сколько тел читается одновременно со всех адресов. */
  total: number
  /** Сколько мс чтение не вытесняется: за это время обычное тело успевает прийти. */
  graceMs: number
}

export const DEFAULT_CONTROL_BODY_READS: BodyReadSlotSettings = { perAddress: 8, total: 128, graceMs: 2_000 }

/** Чтение тела, как его видит место: пришло ли тело целиком и как его оборвать. */
export interface BodyRead {
  complete(): boolean
  evict(): void
}

interface Slot {
  address: string
  read: BodyRead
  startedAt: number
}

/** `enter` занимает место и возвращает освобождение; `null` — мест нет и вытеснить некого. */
export function createBodyReadSlots(settings: BodyReadSlotSettings, now: () => number = Date.now): (address: string, read: BodyRead) => (() => void) | null {
  const slots = new Set<Slot>()
  /** Освобождает место самого старого из вытесняемых; `false` — вытеснить некого. Порядок Set — порядок начала чтения. */
  const evictOldest = (matches: (slot: Slot) => boolean): boolean => {
    const at = now()
    for (const slot of slots) {
      if (at - slot.startedAt < settings.graceMs) return false
      if (!matches(slot) || slot.read.complete()) continue
      slots.delete(slot)
      slot.read.evict()
      return true
    }
    return false
  }

  return (address, read) => {
    const fromAddress = [...slots].filter((slot) => slot.address === address).length
    if (fromAddress >= settings.perAddress && !evictOldest((slot) => slot.address === address)) return null
    if (slots.size >= settings.total && !evictOldest(() => true)) return null
    const slot: Slot = { address, read, startedAt: now() }
    slots.add(slot)
    return () => slots.delete(slot)
  }
}
