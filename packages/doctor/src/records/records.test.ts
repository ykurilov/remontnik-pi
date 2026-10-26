import { describe, expect, it } from 'vitest'
import { createMemoryRecordStore } from './index.js'

describe('хранилище записей в памяти', () => {
  it('запись видна после транзакции, неудачная транзакция не оставляет следов', async () => {
    const store = createMemoryRecordStore()

    await store.transaction(async (tx) => {
      const counter = await tx.doc('counter', 'main', { value: 0 })
      counter.value += 1
    })
    await expect(
      store.transaction(async (tx) => {
        const counter = await tx.doc('counter', 'main', { value: 0 })
        counter.value += 10
        throw new Error('stop')
      }),
    ).rejects.toThrow('stop')

    expect(await store.read('counter', 'main')).toEqual({ value: 1 })
    expect(await store.read('counter', 'other')).toBeUndefined()
  })

  it('чтение отдаёт копию: правка снаружи не меняет хранилище', async () => {
    const store = createMemoryRecordStore()
    await store.transaction(async (tx) => {
      await tx.doc('item', '1', { list: [1] })
    })

    const copy = await store.read<{ list: number[] }>('item', '1')
    copy?.list.push(2)

    expect(await store.read('item', '1')).toEqual({ list: [1] })
  })
})
