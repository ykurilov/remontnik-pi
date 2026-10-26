import type { AgentPost } from './agent-post.js'
import type { BridgeConfig } from './bridge-config.js'
import type { BridgeStateStore } from './bridge-state.js'
import type { DoctorClient } from './doctor-client.js'
import { reportLetter, type DoctorReport } from './task-text.js'

// Отчёты врача → агент приложения (R13). Курсор у моста сдвигается до письма: номер отчёта дважды не уходит.
// Письмо не ушло — курсор возвращается, отчёт уйдёт при следующем заборе.

export const REPORTS_PAGE = 50

export type BridgeLog = (entry: Record<string, string | number | boolean | undefined>) => void

function isReport(value: unknown): value is DoctorReport {
  if (value === null || typeof value !== 'object') return false
  const report = value as Record<string, unknown>
  return (
    Number.isSafeInteger(report.reportId) &&
    (report.reportId as number) > 0 &&
    (report.caseId === undefined || report.caseId === null || Number.isSafeInteger(report.caseId)) &&
    typeof report.type === 'string' &&
    /^[a-z_]{1,40}$/.test(report.type) &&
    typeof report.short === 'string' &&
    typeof report.full === 'string'
  )
}

export class ReportRelay {
  private readonly inFlight = new Map<string, Promise<void>>()

  constructor(
    private readonly deps: {
      config: BridgeConfig
      state: BridgeStateStore
      post: AgentPost
      doctor: (app: string) => DoctorClient
      log: BridgeLog
    },
  ) {}

  /** Забрать и переслать новые отчёты приложения. Одновременно — один забор на приложение. */
  pull(app: string): Promise<void> {
    const running = this.inFlight.get(app)
    if (running) return running
    const work = this.pullNow(app)
      .catch((error: unknown) => this.deps.log({ event: 'reports_failed', app, reason: errorText(error) }))
      .finally(() => this.inFlight.delete(app))
    this.inFlight.set(app, work)
    return work
  }

  private async pullNow(app: string): Promise<void> {
    const entry = this.deps.config.apps.get(app)
    if (!entry) return
    const { state, post, log } = this.deps
    const doctor = this.deps.doctor(app)

    for (;;) {
      const agentState = await post.state(entry.agentId)
      if (agentState === 'missing' || agentState === 'not_ready') return

      const cursor = state.reportCursor(app)
      const answer = await doctor.get(`/v1/reports?after=${cursor}&limit=${REPORTS_PAGE}`)
      const reports = (answer.body as { reports?: unknown } | null)?.reports
      if (answer.status !== 200 || !Array.isArray(reports)) {
        log({ event: 'reports_failed', app, status: answer.status })
        return
      }
      const fresh = reports
        .filter(isReport)
        .filter((report) => report.reportId > cursor)
        .sort((a, b) => a.reportId - b.reportId)
      if (fresh.length === 0) return

      let delivered = cursor
      for (const report of fresh) {
        const before = state.reportCursor(app)
        state.setReportCursor(app, report.reportId)
        let outcome
        try {
          outcome = await post.deliver(entry.agentId, reportLetter(app, report))
        } catch (error) {
          state.setReportCursor(app, before)
          log({ event: 'report_not_sent', app, reportId: report.reportId, reason: errorText(error) })
          break
        }
        if (outcome !== 'sent') {
          state.setReportCursor(app, before)
          log({ event: 'report_not_sent', app, reportId: report.reportId, reason: outcome })
          break
        }
        delivered = report.reportId
        log({ event: 'report_sent', app, reportId: report.reportId })
      }

      if (delivered > cursor) {
        const ack = await doctor.post('/v1/reports/ack', { upTo: delivered })
        if (ack.status !== 200) log({ event: 'reports_ack_failed', app, status: ack.status })
      }
      if (delivered !== fresh.at(-1)!.reportId || reports.length < REPORTS_PAGE) return
    }
  }
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
