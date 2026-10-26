import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { openDoctorHarness } from './harness.js'

describe('записи врача на документах pi-durable', () => {
  it('транзакция атомарна, записи переживают переоткрытие хранилища', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'remontnik-records-'))
    const first = await openDoctorHarness({ stateDir, onReport: () => {} })
    await first.records.transaction(async (tx) => {
      const index = await tx.doc('case-index', 'main', { nextCaseId: 1, open: {} as Record<string, number> })
      index.nextCaseId += 1
      index.open.abc = 1
      const opened = await tx.doc('case', '1', { caseId: 1, linked: [] as string[] })
      opened.linked.push('e1')
    })
    await expect(
      first.records.transaction(async (tx) => {
        const index = await tx.doc('case-index', 'main', { nextCaseId: 1, open: {} as Record<string, number> })
        index.nextCaseId = 100
        throw new Error('stop')
      }),
    ).rejects.toThrow('stop')
    await first.close()

    const second = await openDoctorHarness({ stateDir, onReport: () => {} })

    expect(await second.records.read('case-index', 'main')).toEqual({ nextCaseId: 2, open: { abc: 1 } })
    expect(await second.records.read('case', '1')).toEqual({ caseId: 1, linked: ['e1'] })
    expect(await second.records.read('case', '2')).toBeUndefined()
    await second.close()
  })

  it('удалённый документ пропадает и после переоткрытия; его можно создать заново', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'remontnik-records-'))
    const first = await openDoctorHarness({ stateDir, onReport: () => {} })
    await first.records.transaction(async (tx) => {
      await tx.doc('error-hour', 'patient/2026-10-15T10', { minutes: {} })
    })
    await first.records.transaction((tx) => tx.retire('error-hour', 'patient/2026-10-15T10'))
    expect(await first.records.read('error-hour', 'patient/2026-10-15T10')).toBeUndefined()
    await first.close()

    const second = await openDoctorHarness({ stateDir, onReport: () => {} })
    expect(await second.records.read('error-hour', 'patient/2026-10-15T10')).toBeUndefined()
    await second.records.transaction(async (tx) => {
      await tx.doc('error-hour', 'patient/2026-10-15T10', { minutes: { '1': 1 } })
    })
    expect(await second.records.read('error-hour', 'patient/2026-10-15T10')).toEqual({ minutes: { '1': 1 } })
    await second.close()
  })

  it('незнакомая коллекция — ошибка, а не тихая потеря', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'remontnik-records-'))
    const opened = await openDoctorHarness({ stateDir, onReport: () => {} })

    await expect(opened.records.read('unknown', '1')).rejects.toThrow(/unknown/)
    await opened.close()
  })
})
