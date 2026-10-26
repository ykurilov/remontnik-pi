// Записи врача: именованные коллекции JSON-документов и атомарные транзакции над ними.
// Книга случаев и отчёты пишут только через этот узкий слой. Настоящая реализация —
// документы pi-durable в `service/harness.ts`; здесь — она же в памяти, для проверок.

export type RecordValue = Record<string, unknown>

export interface RecordTransaction {
  /** Документ коллекции; если его нет — создаётся из `initial`. Правки объекта записываются при успехе транзакции. */
  doc<T extends object>(collection: string, key: string, initial: T): Promise<T>
}

export interface RecordStore {
  /** Всё или ничего: исключение внутри откатывает все правки. */
  transaction<R>(change: (tx: RecordTransaction) => Promise<R>): Promise<R>
  /** Копия документа или `undefined`, если его нет. */
  read<T extends object>(collection: string, key: string): Promise<T | undefined>
}

/** Глубокая копия JSON-значения: годится и для черновиков-обёрток хранилища. */
export function copyRecord<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

export function createMemoryRecordStore(): RecordStore {
  const documents = new Map<string, unknown>()
  const id = (collection: string, key: string) => `${collection}\u0000${key}`
  let line: Promise<unknown> = Promise.resolve()

  return {
    transaction(change) {
      const run = async () => {
        const touched = new Map<string, unknown>()
        const tx: RecordTransaction = {
          async doc(collection, key, initial) {
            const address = id(collection, key)
            if (!touched.has(address)) touched.set(address, copyRecord(documents.get(address) ?? initial))
            return touched.get(address) as typeof initial
          },
        }
        const result = await change(tx)
        for (const [address, value] of touched) documents.set(address, copyRecord(value))
        return result
      }
      const next = line.then(run, run)
      line = next.catch(() => {})
      return next
    },
    async read(collection, key) {
      const value = documents.get(id(collection, key))
      return value === undefined ? undefined : copyRecord(value as never)
    },
  }
}
