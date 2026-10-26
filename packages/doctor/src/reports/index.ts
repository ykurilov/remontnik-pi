import { truncateText } from '@ykurilov/remontnik-core/incident'
import type { TelegramClient } from '@ykurilov/remontnik-core/telegram'
import { copyRecord, type RecordStore } from '../records/index.js'

// Отчёты врача: номера по порядку (курсор для Paseo) и очередь сообщений в Telegram с повторами.

export const REPORT_RETRY_DELAYS_MS = Object.freeze([5_000, 30_000, 120_000, 600_000]) as readonly number[]
export const REPORT_SHORT_LIMIT = 1000

export type ReportType =
  | 'case_received'
  | 'cause_found'
  | 'fix_ready'
  | 'deployed'
  | 'rolled_back'
  | 'not_helped'
  | 'needs_human'
  | 'no_cause_found'
  | 'budget_reached'
  | 'stand_broken'
  | 'doctor_problem'
  | 'handed_off'
  | 'paseo_done'
  | 'reclaimed'

/**
 * `not_needed` — отчёт только для журнала и Paseo: о сбое владелец уже узнал от сторожа,
 * второе сообщение о том же было бы лишним.
 */
export type ReportTelegram =
  | { state: 'pending'; attempts: number; nextAttemptAt: number }
  | { state: 'sent'; attempts: number; messageId: number }
  | { state: 'failed'; attempts: number }
  | { state: 'not_needed'; attempts: number }

export interface Report {
  reportId: number
  caseId?: number
  type: ReportType
  short: string
  full: string
  telegram: ReportTelegram
  createdAt: string
}

export interface AddReportInput {
  type: ReportType
  caseId?: number
  short: string
  full?: string
  telegram: 'pending' | 'not_needed'
}

export interface Reports {
  add(input: AddReportInput): Promise<Report>
  get(reportId: number): Promise<Report | undefined>
  list(query: { after: number; limit: number }): Promise<Report[]>
  /** Отправляет в Telegram отчёты, чья попытка подошла. Без настроенного Telegram ничего не делает. */
  pump(): Promise<void>
  /** Когда подойдёт ближайшая попытка; `null` — ждать нечего. */
  nextAttemptAt(): Promise<number | null>
}

export interface CreateReportsOptions {
  store: RecordStore
  telegram?: { client: TelegramClient; chatId: string }
  now?: () => number
  /** Сбой отправки: для журнала врача. */
  onSendError?: (error: unknown, report: Report) => void
}

interface ReportIndex {
  nextReportId: number
  /** Номера отчётов, ждущих отправки в Telegram. */
  pending: number[]
}

const INDEX = { collection: 'report-index', key: 'main' } as const
const emptyIndex = (): ReportIndex => ({ nextReportId: 1, pending: [] })

function retryDelay(attempts: number): number {
  return REPORT_RETRY_DELAYS_MS[Math.min(attempts, REPORT_RETRY_DELAYS_MS.length) - 1] ?? 5_000
}

export function createReports(options: CreateReportsOptions): Reports {
  const { store } = options
  const now = options.now ?? Date.now
  const reportKey = (reportId: number) => String(reportId)
  let pumping: Promise<void> | null = null

  async function pendingReports(): Promise<Report[]> {
    const index = await store.read<ReportIndex>(INDEX.collection, INDEX.key)
    const reports: Report[] = []
    for (const reportId of index?.pending ?? []) {
      const report = await store.read<Report>('report', reportKey(reportId))
      if (report?.telegram.state === 'pending') reports.push(report)
    }
    return reports
  }

  async function settle(reportId: number, telegram: ReportTelegram): Promise<void> {
    await store.transaction(async (tx) => {
      const report = await tx.doc<Report>('report', reportKey(reportId), {} as Report)
      report.telegram = telegram
      if (telegram.state !== 'pending') {
        const index = await tx.doc<ReportIndex>(INDEX.collection, INDEX.key, emptyIndex())
        const position = index.pending.indexOf(reportId)
        if (position >= 0) index.pending.splice(position, 1)
      }
    })
  }

  async function pumpOnce(): Promise<void> {
    const telegram = options.telegram
    if (!telegram) return
    for (const report of await pendingReports()) {
      if (report.telegram.state !== 'pending' || report.telegram.nextAttemptAt > now()) continue
      const attempts = report.telegram.attempts + 1
      try {
        const { messageId } = await telegram.client.sendMessage(telegram.chatId, report.short)
        await settle(report.reportId, { state: 'sent', attempts, messageId })
      } catch (error) {
        options.onSendError?.(error, report)
        await settle(report.reportId, { state: 'pending', attempts, nextAttemptAt: now() + retryDelay(attempts) })
      }
    }
  }

  return {
    add(input) {
      return store.transaction(async (tx) => {
        const index = await tx.doc<ReportIndex>(INDEX.collection, INDEX.key, emptyIndex())
        const reportId = index.nextReportId
        index.nextReportId += 1
        const report: Report = {
          reportId,
          ...(input.caseId === undefined ? {} : { caseId: input.caseId }),
          type: input.type,
          short: truncateText(input.short, REPORT_SHORT_LIMIT),
          full: input.full ?? input.short,
          telegram: input.telegram === 'pending' ? { state: 'pending', attempts: 0, nextAttemptAt: 0 } : { state: 'not_needed', attempts: 0 },
          createdAt: new Date(now()).toISOString(),
        }
        if (input.telegram === 'pending') index.pending.push(reportId)
        return copyRecord(await tx.doc<Report>('report', reportKey(reportId), report))
      })
    },

    get: (reportId) => store.read<Report>('report', reportKey(reportId)),

    async list({ after, limit }) {
      const index = await store.read<ReportIndex>(INDEX.collection, INDEX.key)
      const last = (index?.nextReportId ?? 1) - 1
      const reports: Report[] = []
      for (let reportId = Math.max(1, after + 1); reportId <= last && reports.length < limit; reportId += 1) {
        const report = await store.read<Report>('report', reportKey(reportId))
        if (report) reports.push(report)
      }
      return reports
    },

    async pump() {
      // Один проход за раз: параллельный вызов дождётся текущего, а не отправит то же второй раз.
      while (pumping) await pumping
      pumping = pumpOnce()
      try {
        await pumping
      } finally {
        pumping = null
      }
    },

    async nextAttemptAt() {
      if (!options.telegram) return null
      const times = (await pendingReports()).flatMap((report) => (report.telegram.state === 'pending' ? [report.telegram.nextAttemptAt] : []))
      return times.length === 0 ? null : Math.min(...times)
    },
  }
}
