import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { createModels } from '@earendil-works/pi-ai/models'
import {
  createRegistry,
  defineDocFamily,
  Harness,
  type JsonObject,
  type ReportInfo,
  type SessionDocFamilyToken,
  type SessionEnd,
  type Storage,
} from '@earendil-works/pi-durable'
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node'
import type { RecordStore } from '../records/index.js'

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
}

function familyOf(collection: string): RecordFamily {
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
}

export interface DoctorHarness {
  harness: Harness
  records: RecordStore
  /** Settles, когда Session закрылась: штатно или из-за отказа хранилища. */
  closed: Promise<SessionEnd>
  close(): Promise<void>
}

export function recordStoreOver(harness: Harness): RecordStore {
  return {
    transaction(change) {
      return harness.commit(
        (tx) =>
          change({
            async doc(collection, key, initial) {
              return (await tx.doc(familyOf(collection), key, initial as unknown as JsonObject)) as unknown as typeof initial
            },
          }),
        BACKGROUND_CONTEXT,
      )
    },
    async read(collection, key) {
      const value = await harness.snapshot(familyOf(collection), key, BACKGROUND_CONTEXT)
      return value === undefined ? undefined : (copy(value) as never)
    },
  }
}

/** Открывает Harness врача над `stateDir/doctor.sqlite`. */
export async function openDoctorHarness(options: OpenDoctorHarnessOptions): Promise<DoctorHarness> {
  mkdirSync(options.stateDir, { recursive: true })
  const storage = await openNodeSqliteStorage(join(options.stateDir, 'doctor.sqlite'))
  const harness = await Harness.open(
    options.wrapStorage ? options.wrapStorage(storage) : storage,
    {
      models: createModels(),
      registry: createRegistry(),
      onReport: options.onReport,
      ...(options.now ? { now: options.now } : {}),
    },
    BACKGROUND_CONTEXT,
  )
  return {
    harness,
    records: recordStoreOver(harness),
    closed: harness.closed,
    close: () => harness.close(BACKGROUND_CONTEXT),
  }
}
