import type { DeployFacts } from '../deploy-gate/index.js'
import type { RecordStore, RecordTransaction } from '../records/index.js'
import { spendDayKey } from './spend-ledger.js'

// Защита от циклов «правка → откат → правка» (FR-032, data-model: FingerprintLedger), документ `remontnik.ledger`.
// Автовыкатки считаются по отпечатку и по приложению за сутки в поясе приложения. Откат правки помечает отпечаток
// «нужен человек»: автоматических выкаток по нему нет, пока владелец не снимет пометку командой `fingerprint <fp> release`.
// Выкатка спрашивает допуск `admitAutoDeployIn`: проверка пределов и запись попытки — одной транзакцией, поэтому два
// случая разом не проходят оба на последнем свободном месте. `recordRollbackIn` — после отката. Повтор той же выкатки
// (фаза после перезапуска) допускается и не считается второй попыткой. Выкатка не началась — `refundAutoDeployIn`
// возвращает допуск.

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

/** Запись отпечатка из черновика учёта: новый объект после вставки в черновик — уже не он, правки шли бы мимо. */
function recordFor(ledger: FingerprintLedger, fingerprint: string): FingerprintRecord {
  if (!Object.hasOwn(ledger.fingerprints, fingerprint)) ledger.fingerprints[fingerprint] = { autoDeploys: [], needsHuman: false }
  return ledger.fingerprints[fingerprint]!
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

export type AutoDeployRefusal = 'attempts_exhausted' | 'needs_human_after_rollback'
export type AutoDeployAdmission = { admitted: true } | { admitted: false; reasons: AutoDeployRefusal[] }

/**
 * Допуск автовыкатки по отпечатку: те же правила, что у решения о выкатке, и запись попытки при допуске.
 * Отказ ничего не пишет. Повтор той же выкатки допускается без второй записи.
 */
export async function admitAutoDeployIn(
  tx: RecordTransaction,
  input: { fingerprint: string; deploymentId: number; at: number; timeZone: string; limits: DeployAttemptLimits },
): Promise<AutoDeployAdmission> {
  const ledger = await ledgerIn(tx)
  const known = Object.hasOwn(ledger.fingerprints, input.fingerprint) ? ledger.fingerprints[input.fingerprint] : undefined
  if (known?.autoDeploys.some((deploy) => deploy.deploymentId === input.deploymentId)) return { admitted: true }
  const attempts = deployAttemptsOf(ledger, { fingerprint: input.fingerprint, now: input.at, timeZone: input.timeZone, limits: input.limits })
  const reasons: AutoDeployRefusal[] = []
  if (attempts.autoDeploysForFingerprint >= attempts.maxPerFingerprintPerDay || attempts.autoDeploysToday >= attempts.maxPerDay) reasons.push('attempts_exhausted')
  if (attempts.needsHumanAfterRollback) reasons.push('needs_human_after_rollback')
  if (reasons.length > 0) return { admitted: false, reasons }
  const record = recordFor(ledger, input.fingerprint)
  // Сутки в любом поясе короче двух: всё старше уже не нужно ни одному счёту.
  record.autoDeploys = record.autoDeploys.filter((deploy) => input.at - Date.parse(deploy.at) < 2 * DAY_MS)
  record.autoDeploys.push({ at: new Date(input.at).toISOString(), deploymentId: input.deploymentId })
  const day = spendDayKey(input.at, input.timeZone)
  ledger.deploysToday = ledger.deploysToday.day === day ? { day, count: ledger.deploysToday.count + 1 } : { day, count: 1 }
  return { admitted: true }
}

/**
 * Выкатка не началась (`refused`: рабочая версия не тронута) — допуск возвращается: попытка по отпечатку и место дня
 * снова свободны. Возврат уже возвращённой выкатки ничего не меняет, поэтому повтор фиксации после перезапуска безопасен.
 */
export async function refundAutoDeployIn(tx: RecordTransaction, input: { fingerprint: string; deploymentId: number; timeZone: string }): Promise<void> {
  const ledger = await ledgerIn(tx)
  if (!Object.hasOwn(ledger.fingerprints, input.fingerprint)) return
  const record = ledger.fingerprints[input.fingerprint]!
  const admitted = record.autoDeploys.find((deploy) => deploy.deploymentId === input.deploymentId)
  if (!admitted) return
  record.autoDeploys = record.autoDeploys.filter((deploy) => deploy.deploymentId !== input.deploymentId)
  const day = spendDayKey(Date.parse(admitted.at), input.timeZone)
  if (ledger.deploysToday.day === day && ledger.deploysToday.count > 0) ledger.deploysToday = { day, count: ledger.deploysToday.count - 1 }
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
