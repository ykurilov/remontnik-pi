import type { IncidentEvent, IncidentKind } from '@ykurilov/remontnik-core/incident'
import { copyRecord, type RecordStore } from '../records/index.js'

// Книга случаев: события склеиваются по отпечатку в один открытый случай.

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
  /** Отпечаток → номер открытого случая. */
  open: Record<string, number>
  recentEventIds: string[]
}

export interface RecordEventsResult {
  accepted: string[]
  newCases: Case[]
}

export interface CaseBook {
  recordEvents(events: readonly IncidentEvent[]): Promise<RecordEventsResult>
  getCase(caseId: number): Promise<Case | undefined>
  openCaseFor(fingerprint: string): Promise<Case | undefined>
  setState(caseId: number, state: CaseState): Promise<Case>
  linkReport(caseId: number, reportId: number): Promise<void>
}

const INDEX = { collection: 'case-index', key: 'main' } as const
const emptyIndex = (): CaseIndex => ({ nextCaseId: 1, open: {}, recentEventIds: [] })

export function createCaseBook(store: RecordStore): CaseBook {
  const caseKey = (caseId: number) => String(caseId)

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
    async recordEvents(events) {
      for (const event of events) {
        if (Number.isNaN(Date.parse(event.occurredAt))) throw new Error(`событие ${event.eventId}: неверное время ${event.occurredAt}`)
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

          const openId = index.open[event.fingerprint]
          if (openId !== undefined) {
            const opened = await tx.doc<Case>('case', caseKey(openId), {} as Case)
            opened.events += 1
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
          index.open[event.fingerprint] = caseId
          const fresh: Case = {
            caseId,
            fingerprint: event.fingerprint,
            kind: event.kind,
            where: event.where,
            message: event.message,
            stack: event.stack,
            events: 1,
            firstSeenAt: event.occurredAt,
            lastSeenAt: event.occurredAt,
            linkedEventIds: [event.eventId],
            state: 'received',
            reportIds: [],
          }
          created.push(await tx.doc<Case>('case', caseKey(caseId), fresh))
        }
        const overflow = index.recentEventIds.length - RECENT_EVENT_IDS_LIMIT
        if (overflow > 0) index.recentEventIds.splice(0, overflow)
        return { accepted, newCases: created.map((item) => copyRecord(item)) }
      })
    },

    getCase: (caseId) => store.read<Case>('case', caseKey(caseId)),

    async openCaseFor(fingerprint) {
      const index = await store.read<CaseIndex>(INDEX.collection, INDEX.key)
      const caseId = index?.open[fingerprint]
      return caseId === undefined ? undefined : store.read<Case>('case', caseKey(caseId))
    },

    setState: (caseId, state) =>
      updateCase(
        caseId,
        (opened) => {
          opened.state = state
        },
        (index, opened) => {
          if (CLOSED_CASE_STATES.includes(state) && index.open[opened.fingerprint] === caseId) delete index.open[opened.fingerprint]
        },
      ),

    async linkReport(caseId, reportId) {
      await updateCase(caseId, (opened) => {
        if (!opened.reportIds.includes(reportId)) opened.reportIds.push(reportId)
      })
    },
  }
}
