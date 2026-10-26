import type { RecordTransaction } from '../records/index.js'
import { openDoctorHarness } from '../service/harness.js'

/** Записи врача до его запуска: подложить учёт расходов или выкаток, какими их оставила бы прошлая работа. */
export async function seedDoctorRecords(stateDir: string, change: (tx: RecordTransaction) => Promise<void>): Promise<void> {
  const opened = await openDoctorHarness({ stateDir, onReport: () => {} })
  try {
    await opened.records.transaction(change)
  } finally {
    await opened.close()
  }
}
