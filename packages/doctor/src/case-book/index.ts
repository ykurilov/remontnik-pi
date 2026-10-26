import type { IncidentEvent, IncidentKind } from '@ykurilov/remontnik-core/incident'
import { copyRecord, type RecordStore, type RecordTransaction } from '../records/index.js'
import { countErrorIn, seedErrorHourIndex } from './error-hours.js'

// Книга случаев: события склеиваются по приложению и отпечатку в один открытый случай.

export const CASE_LINKED_EVENTS_LIMIT = 50
/** Сколько последних номеров событий помнить, чтобы повторная доставка не считалась дважды. */
const RECENT_EVENT_IDS_LIMIT = 5000

export type CaseState =
  | 'received'
  | 'triage'
  | 'diagnosing'
  | 'fixing'
  | 'verifying'
  | 'gated'
  | 'deploying'
  | 'observing'
  | 'healed'
  | 'report_only'
  | 'rolled_back'
  | 'needs_human'
  | 'not_helped'
  | 'no_cause_found'
  | 'deferred_budget'
  | 'stand_broken'
  | 'handoff_check'
  | 'handed_off'
  | 'paseo_working'
  | 'healed_by_paseo'
  | 'reclaimed'

/** После этих состояний новый сбой с тем же отпечатком открывает новый случай. */
export const CLOSED_CASE_STATES: readonly CaseState[] = ['healed', 'healed_by_paseo']

export interface Case {
  caseId: number
  appName: string
  /** Процесс приложения, где сбой случился впервые (веб, фоновый работник), если сторож его назвал. */
  processName?: string
  fingerprint: string
  kind: IncidentKind
  where: string
  message: string
  stack: string
  events: number
  firstSeenAt: string
  lastSeenAt: string
  linkedEventIds: string[]
  state: CaseState
  treatmentTaskId?: string
  reportIds: number[]
}

interface CaseIndex {
  nextCaseId: number
  /** Приложение и отпечаток (см. openKey) → номер открытого случая. */
  open: Record<string, number>
  recentEventIds: string[]
}

export interface RecordEventsResult {
  accepted: string[]
  newCases: Case[]
}

export interface RecordEventsOptions {
  /** Вызывается для каждого нового случая внутри той же транзакции: сбой откатывает всю пачку. */
  onNewCase?(tx: RecordTransaction, opened: Case): Promise<void>
}

export interface CaseBook {
  recordEvents(events: readonly IncidentEvent[], options?: RecordEventsOptions): Promise<RecordEventsResult>
  getCase(caseId: number): Promise<Case | undefined>
  openCaseFor(fingerprint: string, appName: string): Promise<Case | undefined>
  setState(caseId: number, state: CaseState): Promise<Case>
  linkReport(caseId: number, reportId: number): Promise<void>
}

const INDEX = { collection: 'case-index', key: 'main' } as const
const emptyIndex = (): CaseIndex => ({ nextCaseId: 1, open: {}, recentEventIds: [] })
const openKey = (appName: string, fingerprint: string) => `${appName}\u0000${fingerprint}`

/** Сколько появлений несёт событие: сторож склеивает повторы при переполненной очереди. */
function occurrences(event: IncidentEvent): number {
  const repeats = event.context.repeats
  return 1 + (typeof repeats === 'number' && Number.isInteger(repeats) && repeats > 0 ? repeats : 0)
}

export interface CaseBookOptions {
  /** Часы врача: время записи событий. */
  now?: () => number
}

export function createCaseBook(store: RecordStore, options: CaseBookOptions = {}): CaseBook {
  const now = options.now ?? Date.now
  const caseKey = (caseId: number) => String(caseId)
  /** Приложения, чьи старые часы ошибок уже внесены в список (`seedErrorHourIndex`). */
  const seededApps = new Set<string>()

  async function updateCase(caseId: number, change: (opened: Case) => void, onIndex?: (index: CaseIndex, opened: Case) => void) {
    return store.transaction(async (tx) => {
      // Читать внутри транзакции можно только через tx: пустой документ значит «случая нет», и откат его уберёт.
      const opened = await tx.doc<Case>('case', caseKey(caseId), {} as Case)
      if (opened.caseId !== caseId) throw new Error(`случая ${caseId} нет`)
      change(opened)
      if (onIndex) onIndex(await tx.doc<CaseIndex>(INDEX.collection, INDEX.key, emptyIndex()), opened)
      return copyRecord(opened)
    })
  }

  return {
    async recordEvents(events, options = {}) {
      for (const event of events) {
        if (Number.isNaN(Date.parse(event.occurredAt))) throw new Error(`событие ${event.eventId}: неверное время ${event.occurredAt}`)
      }
      // Опорное время учёта часов — время записи, а не время событий: его пишет сторож, и часы у него бывают неверные.
      const recordedAt = new Date(now())
      for (const event of events) {
        if (seededApps.has(event.appName)) continue
        await seedErrorHourIndex(store, event.appName, recordedAt)
        seededApps.add(event.appName)
      }
      return store.transaction(async (tx) => {
        const index = await tx.doc<CaseIndex>(INDEX.collection, INDEX.key, emptyIndex())
        const recent = new Set(index.recentEventIds)
        const accepted: string[] = []
        const created: Case[] = []
        for (const event of events) {
          accepted.push(event.eventId)
          if (recent.has(event.eventId)) continue
          recent.add(event.eventId)
          index.recentEventIds.push(event.eventId)
          await countErrorIn(tx, event, occurrences(event), recordedAt)

          const key = openKey(event.appName, event.fingerprint)
          const openId = index.open[key]
          if (openId !== undefined) {
            const opened = await tx.doc<Case>('case', caseKey(openId), {} as Case)
            opened.events += occurrences(event)
            if (Date.parse(event.occurredAt) > Date.parse(opened.lastSeenAt)) opened.lastSeenAt = event.occurredAt
            if (Date.parse(event.occurredAt) < Date.parse(opened.firstSeenAt)) opened.firstSeenAt = event.occurredAt
            opened.linkedEventIds.push(event.eventId)
            if (opened.linkedEventIds.length > CASE_LINKED_EVENTS_LIMIT) {
              opened.linkedEventIds.splice(0, opened.linkedEventIds.length - CASE_LINKED_EVENTS_LIMIT)
            }
            continue
          }

          const caseId = index.nextCaseId
          index.nextCaseId += 1
          index.open[key] = caseId
          const processName = event.context.processName
          const fresh: Case = {
            caseId,
            appName: event.appName,
            ...(typeof processName === 'string' && processName !== '' ? { processName } : {}),
            fingerprint: event.fingerprint,
            kind: event.kind,
            where: event.where,
            message: event.message,
            stack: event.stack,
            events: occurrences(event),
            firstSeenAt: event.occurredAt,
            lastSeenAt: event.occurredAt,
            linkedEventIds: [event.eventId],
            state: 'received',
            reportIds: [],
          }
          const draft = await tx.doc<Case>('case', caseKey(caseId), fresh)
          if (options.onNewCase) await options.onNewCase(tx, draft)
          created.push(draft)
        }
        const overflow = index.recentEventIds.length - RECENT_EVENT_IDS_LIMIT
        if (overflow > 0) index.recentEventIds.splice(0, overflow)
        return { accepted, newCases: created.map((item) => copyRecord(item)) }
      })
    },

    getCase: (caseId) => store.read<Case>('case', caseKey(caseId)),

    async openCaseFor(fingerprint, appName) {
      const index = await store.read<CaseIndex>(INDEX.collection, INDEX.key)
      const caseId = index?.open[openKey(appName, fingerprint)]
      return caseId === undefined ? undefined : store.read<Case>('case', caseKey(caseId))
    },

    setState: (caseId, state) =>
      updateCase(
        caseId,
        (opened) => {
          opened.state = state
        },
        (index, opened) => {
          const key = openKey(opened.appName, opened.fingerprint)
          if (CLOSED_CASE_STATES.includes(state) && index.open[key] === caseId) delete index.open[key]
        },
      ),

    async linkReport(caseId, reportId) {
      await updateCase(caseId, (opened) => {
        if (!opened.reportIds.includes(reportId)) opened.reportIds.push(reportId)
      })
    },
  }
}
