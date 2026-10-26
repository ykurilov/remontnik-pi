// Места для чтения тел на путях управления. Подпись проверяется только по телу, поэтому до конца чтения не видно,
// чей это запрос. Медленные тела держат соединения: число одновременных чтений с одного адреса и всего ограничено.
// Новый запрос сверх предела вытесняет самое медленное чтение: меньше всего байт в миллисекунду с начала. Не
// вытесняется чтение, у которого тело уже пришло целиком, и молодое: команде владельца дают время дойти, даже если
// за ней идёт поток новых медленных тел с того же адреса (за обратным прокси у всех один адрес). Вытеснять некого —
// отказ получает новый запрос.

export interface BodyReadSlotSettings {
  /** Сколько тел с одного адреса читается одновременно. */
  perAddress: number
  /** Сколько тел читается одновременно со всех адресов. */
  total: number
  /** Сколько мс чтение не вытесняется: за это время обычное тело успевает прийти. */
  graceMs: number
}

export const DEFAULT_CONTROL_BODY_READS: BodyReadSlotSettings = { perAddress: 8, total: 128, graceMs: 2_000 }

/** Чтение тела, как его видит место: сколько байт пришло по соединению, пришло ли тело целиком, как его оборвать. */
export interface BodyRead {
  bytesRead(): number
  complete(): boolean
  evict(): void
}

interface Slot {
  address: string
  read: BodyRead
  startedAt: number
  startBytes: number
}

/** `enter` занимает место и возвращает освобождение; `null` — мест нет и вытеснить некого. */
export function createBodyReadSlots(settings: BodyReadSlotSettings, now: () => number = Date.now): (address: string, read: BodyRead) => (() => void) | null {
  const slots = new Set<Slot>()
  const speed = (slot: Slot, at: number) => (slot.read.bytesRead() - slot.startBytes) / Math.max(1, at - slot.startedAt)
  /** Освобождает место самого медленного из вытесняемых; `false` — вытеснить некого. */
  const evictSlowest = (matches: (slot: Slot) => boolean): boolean => {
    const at = now()
    let slowest: Slot | undefined
    for (const slot of slots) {
      if (!matches(slot) || slot.read.complete() || at - slot.startedAt < settings.graceMs) continue
      // При равной скорости — более старое: порядок Set — порядок начала чтения.
      if (!slowest || speed(slot, at) < speed(slowest, at)) slowest = slot
    }
    if (!slowest) return false
    slots.delete(slowest)
    slowest.read.evict()
    return true
  }

  return (address, read) => {
    const fromAddress = [...slots].filter((slot) => slot.address === address).length
    if (fromAddress >= settings.perAddress && !evictSlowest((slot) => slot.address === address)) return null
    if (slots.size >= settings.total && !evictSlowest(() => true)) return null
    const slot: Slot = { address, read, startedAt: now(), startBytes: read.bytesRead() }
    slots.add(slot)
    return () => slots.delete(slot)
  }
}
