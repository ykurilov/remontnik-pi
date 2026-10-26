import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { createModels } from '@earendil-works/pi-ai/models'
import type { Models } from '@earendil-works/pi-ai'
import {
  createRegistry,
  defineDocFamily,
  Harness,
  type HarnessOptions,
  type HarnessSettings,
  type JsonObject,
  type Registry,
  type ReportInfo,
  type SessionDocFamilyToken,
  type SessionEnd,
  type Storage,
  type Tx,
} from '@earendil-works/pi-durable'
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node'
import type { RecordStore, RecordTransaction } from '../records/index.js'

// Единственное место, где записи врача касаются pi-durable: коллекции записей — семейства документов Session,
// транзакция — `harness.commit()`. Остальной врач видит только RecordStore.

type RecordFamily = SessionDocFamilyToken<JsonObject, JsonObject>

function recordFamily(kind: string): RecordFamily {
  return defineDocFamily<JsonObject, JsonObject>({
    kind,
    version: 1,
    scope: 'session',
    family: true,
    initial: (seed) => seed,
    // Полная копия раз в 32 правки: чтение не перебирает длинную цепочку изменений.
    checkpointWhen: (_value, _ops, info) => info.deltasSinceBase >= 32,
  })
}

const RECORD_FAMILIES: Readonly<Record<string, RecordFamily>> = {
  case: recordFamily('remontnik.case'),
  'case-index': recordFamily('remontnik.case-index'),
  report: recordFamily('remontnik.report'),
  'report-index': recordFamily('remontnik.report-index'),
  /** Итоги eval основы по паре (коммит, сценарий). */
  'eval-base': recordFamily('remontnik.eval-base'),
  /** Дневной расход врача на модель и eval (ключ — день). */
  spend: recordFamily('remontnik.spend'),
  /** Сколько расхода модели по случаю уже записано в дни. */
  'spend-case': recordFamily('remontnik.spend-case'),
  /** Случаи, которые ждут eval: остаток дня делится между ними. */
  'eval-queue': recordFamily('remontnik.eval-queue'),
  /** Учёт выкаток по отпечатку: пределы в сутки и «нужен человек» после отката. */
  ledger: recordFamily('remontnik.ledger'),
}

/** Семейство документов коллекции записей: для чтения из задач pi-durable (`runtime.snapshot`). */
export function recordFamilyOf(collection: string): RecordFamily {
  const family = Object.hasOwn(RECORD_FAMILIES, collection) ? RECORD_FAMILIES[collection] : undefined
  if (!family) throw new Error(`незнакомая коллекция записей: ${collection}`)
  return family
}

function copy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

export interface OpenDoctorHarnessOptions {
  stateDir: string
  onReport: (error: unknown, info: ReportInfo) => void
  /** Для проверок: подменить хранилище, например чтобы оно отказало. */
  wrapStorage?: (storage: Storage) => Storage
  now?: () => number
  /** Модели для лечения; без них — пустой набор. */
  models?: Models
  /** Окружение выполнения инструментов модели (верстак). */
  env?: HarnessOptions['env']
}

export interface DoctorHarness {
  harness: Harness
  /** Расширения ставятся до `harness.resume()`: иначе задачи лечения после перезапуска ждут своё определение. */
  registry: Registry
  records: RecordStore
  /** Settles, когда Session закрылась: штатно или из-за отказа хранилища. */
  closed: Promise<SessionEnd>
  close(): Promise<void>
}

const durableTransactions = new WeakMap<RecordTransaction, Tx>()

/** Записи врача внутри транзакции pi-durable: случай, отчёт и чекпойнт задачи — одной фиксацией. */
export function recordTransactionOver(tx: Tx): RecordTransaction {
  const records: RecordTransaction = {
    async doc(collection, key, initial) {
      return (await tx.doc(recordFamilyOf(collection), key, initial as unknown as JsonObject)) as unknown as typeof initial
    },
  }
  durableTransactions.set(records, tx)
  return records
}

/** Транзакция pi-durable под транзакцией записей; `undefined` — записи не на pi-durable (память в тестах). */
export function durableTxOf(records: RecordTransaction): Tx | undefined {
  return durableTransactions.get(records)
}

export function recordStoreOver(harness: Harness): RecordStore {
  return {
    transaction(change) {
      return harness.commit((tx) => change(recordTransactionOver(tx)), BACKGROUND_CONTEXT)
    },
    async read(collection, key) {
      const value = await harness.snapshot(recordFamilyOf(collection), key, BACKGROUND_CONTEXT)
      return value === undefined ? undefined : (copy(value) as never)
    },
  }
}

/**
 * Инструменты модели-врача идут по очереди, а не все вызовы хода разом. Иначе команда в верстаке могла бы подменить
 * часть пути символьной ссылкой между проверкой пути файловым инструментом и самой записью. Команда держит верстак
 * до конца: контейнер гаснет вместе с ней, фоновые процессы в нём не переживают вызов.
 */
export const DOCTOR_HARNESS_SETTINGS = { toolExecution: 'sequential' } as const satisfies HarnessSettings

/** Открывает Harness врача над `stateDir/doctor.sqlite`. */
export async function openDoctorHarness(options: OpenDoctorHarnessOptions): Promise<DoctorHarness> {
  mkdirSync(options.stateDir, { recursive: true })
  const storage = await openNodeSqliteStorage(join(options.stateDir, 'doctor.sqlite'))
  const registry = createRegistry()
  const harness = await Harness.open(
    options.wrapStorage ? options.wrapStorage(storage) : storage,
    {
      models: options.models ?? createModels(),
      registry,
      settings: DOCTOR_HARNESS_SETTINGS,
      onReport: options.onReport,
      ...(options.env ? { env: options.env } : {}),
      ...(options.now ? { now: options.now } : {}),
    },
    BACKGROUND_CONTEXT,
  )
  return {
    harness,
    registry,
    records: recordStoreOver(harness),
    closed: harness.closed,
    close: () => harness.close(BACKGROUND_CONTEXT),
  }
}
