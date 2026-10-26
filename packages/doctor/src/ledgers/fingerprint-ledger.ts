import type { DeployFacts } from '../deploy-gate/index.js'
import type { RecordStore, RecordTransaction } from '../records/index.js'
import { spendDayKey } from './spend-ledger.js'

// Защита от циклов «правка → откат → правка» (FR-032, data-model: FingerprintLedger), документ `remontnik.ledger`.
// Автовыкатки считаются по отпечатку и по приложению за сутки в поясе приложения. Откат правки помечает отпечаток
// «нужен человек»: автоматических выкаток по нему нет, пока владелец не снимет пометку командой `fingerprint <fp> release`.
// Выкатка только вызывает запись: `recordAutoDeployIn` перед выкаткой, `recordRollbackIn` после отката — в своих
// транзакциях, повтор той же выкатки (фаза после перезапуска) не считается второй попыткой.

export const LEDGER = { collection: 'ledger', key: 'main' } as const

export interface FingerprintRecord {
  /** Автовыкатки за последние сутки (старые убираются). */
  autoDeploys: { at: string; deploymentId: number }[]
  rolledBackAt?: string
  needsHuman: boolean
  releasedBy?: string
  releasedAt?: string
}

export interface FingerprintLedger {
  fingerprints: Record<string, FingerprintRecord>
  /** Автовыкатки приложения за сутки `day` по всем отпечаткам. */
  deploysToday: { day: string; count: number }
}

export interface DeployAttemptLimits {
  autoDeploysPerFingerprintPerDay: number
  autoDeploysPerDay: number
}

const DAY_MS = 24 * 3_600_000

export const emptyFingerprintLedger = (): FingerprintLedger => ({ fingerprints: {}, deploysToday: { day: '', count: 0 } })

function ledgerIn(tx: RecordTransaction): Promise<FingerprintLedger> {
  return tx.doc<FingerprintLedger>(LEDGER.collection, LEDGER.key, emptyFingerprintLedger())
}

function recordFor(ledger: FingerprintLedger, fingerprint: string): FingerprintRecord {
  const found = Object.hasOwn(ledger.fingerprints, fingerprint) ? ledger.fingerprints[fingerprint] : undefined
  return found ?? (ledger.fingerprints[fingerprint] = { autoDeploys: [], needsHuman: false })
}

/** Факты попыток для решения о выкатке (`DeployFacts.attempts`). */
export function deployAttemptsOf(
  ledger: FingerprintLedger | undefined,
  input: { fingerprint: string; now: number; timeZone: string; limits: DeployAttemptLimits },
): DeployFacts['attempts'] {
  const today = spendDayKey(input.now, input.timeZone)
  const found = ledger && Object.hasOwn(ledger.fingerprints, input.fingerprint) ? ledger.fingerprints[input.fingerprint] : undefined
  return {
    autoDeploysForFingerprint: (found?.autoDeploys ?? []).filter((deploy) => spendDayKey(Date.parse(deploy.at), input.timeZone) === today).length,
    maxPerFingerprintPerDay: input.limits.autoDeploysPerFingerprintPerDay,
    autoDeploysToday: ledger?.deploysToday.day === today ? ledger.deploysToday.count : 0,
    maxPerDay: input.limits.autoDeploysPerDay,
    needsHumanAfterRollback: found?.needsHuman ?? false,
  }
}

export async function readDeployAttempts(
  store: Pick<RecordStore, 'read'>,
  input: { fingerprint: string; now: number; timeZone: string; limits: DeployAttemptLimits },
): Promise<DeployFacts['attempts']> {
  return deployAttemptsOf(await store.read<FingerprintLedger>(LEDGER.collection, LEDGER.key), input)
}

/** Автовыкатка по отпечатку началась. Повтор той же выкатки ничего не меняет. */
export async function recordAutoDeployIn(
  tx: RecordTransaction,
  input: { fingerprint: string; deploymentId: number; at: number; timeZone: string },
): Promise<void> {
  const ledger = await ledgerIn(tx)
  const record = recordFor(ledger, input.fingerprint)
  if (record.autoDeploys.some((deploy) => deploy.deploymentId === input.deploymentId)) return
  // Сутки в любом поясе короче двух: всё старше уже не нужно ни одному счёту.
  record.autoDeploys = record.autoDeploys.filter((deploy) => input.at - Date.parse(deploy.at) < 2 * DAY_MS)
  record.autoDeploys.push({ at: new Date(input.at).toISOString(), deploymentId: input.deploymentId })
  const day = spendDayKey(input.at, input.timeZone)
  ledger.deploysToday = ledger.deploysToday.day === day ? { day, count: ledger.deploysToday.count + 1 } : { day, count: 1 }
}

/** Правку по отпечатку откатили: дальше по нему только отчёты, пока человек не снимет пометку. */
export async function recordRollbackIn(tx: RecordTransaction, input: { fingerprint: string; deploymentId: number; at: number }): Promise<void> {
  const record = recordFor(await ledgerIn(tx), input.fingerprint)
  record.needsHuman = true
  record.rolledBackAt = new Date(input.at).toISOString()
}

/** Снять «нужен человек» (команда владельца). Незнакомый отпечаток не создаётся. */
export function releaseFingerprint(store: RecordStore, input: { fingerprint: string; by: string; at: number }): Promise<{ found: boolean; needsHuman: boolean }> {
  const { by } = input
  return store.transaction(async (tx) => {
    const ledger = await ledgerIn(tx)
    if (!Object.hasOwn(ledger.fingerprints, input.fingerprint)) return { found: false, needsHuman: false }
    const record = ledger.fingerprints[input.fingerprint]!
    record.needsHuman = false
    record.releasedBy = by
    record.releasedAt = new Date(input.at).toISOString()
    return { found: true, needsHuman: false }
  })
}
