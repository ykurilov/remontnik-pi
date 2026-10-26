// Места для чтения тел на путях управления. Подпись проверяется только по телу, поэтому до конца чтения не видно,
// чей это запрос. Медленные тела держат соединения: число одновременных чтений с одного адреса и всего ограничено.
// Новый запрос сверх предела не получает отказ, а вытесняет самое старое чтение: команда владельца читается
// за миллисекунды и самой старой почти не бывает, а висящие медленные тела вытесняются первыми.

export interface BodyReadSlotSettings {
  /** Сколько тел с одного адреса читается одновременно. */
  perAddress: number
  /** Сколько тел читается одновременно со всех адресов. */
  total: number
}

export const DEFAULT_CONTROL_BODY_READS: BodyReadSlotSettings = { perAddress: 8, total: 128 }

interface Slot {
  address: string
  evict(): void
}

/** `enter` занимает место и возвращает освобождение; вытесненное чтение получает `evict` (обрыв соединения). */
export function createBodyReadSlots(settings: BodyReadSlotSettings): (address: string, evict: () => void) => () => void {
  /** Порядок вставки — порядок начала чтения: первый — самый старый. */
  const slots = new Set<Slot>()
  const release = (slot: Slot) => slots.delete(slot)
  const evictOldest = (matches: (slot: Slot) => boolean) => {
    for (const slot of slots) {
      if (!matches(slot)) continue
      release(slot)
      slot.evict()
      return
    }
  }

  return (address, evict) => {
    const fromAddress = [...slots].filter((slot) => slot.address === address).length
    if (fromAddress >= settings.perAddress) evictOldest((slot) => slot.address === address)
    if (slots.size >= settings.total) evictOldest(() => true)
    const slot: Slot = { address, evict }
    slots.add(slot)
    return () => release(slot)
  }
}
