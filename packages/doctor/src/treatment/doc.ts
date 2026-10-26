import { defineDoc } from '@earendil-works/pi-durable'
import type { IncidentKind } from '@ykurilov/remontnik-core/incident'

// Документ лечения в разговоре модели-врача. Задача пишет в него верстак и сведения о случае,
// инструменты `finish_*` — диагноз и итог правки. Окружение выполнения строится по нему же.

export type Diagnosis = {
  found: boolean
  cause: string
  evidence: string[]
  confidence: 'low' | 'medium' | 'high'
  fixPlan?: string
}

export type FixSummary = {
  summary: string
  testsAdded: string[]
  notes?: string
}

export type TreatmentCaseInfo = {
  caseId: number
  appName: string
  kind: IncidentKind
  where: string
  message: string
  stack: string
  events: number
}

export type TreatmentDocState = {
  workbench: {
    root: string
    closedPaths: string[]
    bashTimeoutSeconds: number
    maxTimeoutSeconds: number
  }
  case: TreatmentCaseInfo
  diagnosis?: Diagnosis
  fix?: FixSummary
}

export const TreatmentDoc = defineDoc<TreatmentDocState>({
  kind: 'remontnik.treatment',
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  // Пустой документ: задача заполняет его до первого запроса модели.
  initial: () => ({}) as TreatmentDocState,
  checkpointWhen: () => true,
})
