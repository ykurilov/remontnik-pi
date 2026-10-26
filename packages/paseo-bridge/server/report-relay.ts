import type { AgentPost } from './agent-post.js'
import type { BridgeConfig } from './bridge-config.js'
import type { BridgeStateStore } from './bridge-state.js'
import type { DoctorClient } from './doctor-client.js'
import { reportLetter, type DoctorReport } from './task-text.js'

// Отчёты врача → агент приложения (R13). Курсор у моста сдвигается до письма: номер отчёта дважды не уходит.
// Письмо не ушло — курсор возвращается, отчёт уйдёт при следующем заборе. Курсор не записался — письма нет.
// Отчёт с номером дальше `MAX_CURSOR_JUMP` от курсора не принимается: один кривой номер не уводит курсор в бесконечность.

export const REPORTS_PAGE = 50
export const MAX_CURSOR_JUMP = 100_000
const MAX_REPORT_TEXT = 64 * 1024

export type BridgeLog = (entry: Record<string, string | number | boolean | undefined>) => void

function isReport(value: unknown, cursor: number): value is DoctorReport {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const report = value as Record<string, unknown>
  const { reportId, caseId, type, short, full, createdAt } = report
  return (
    Number.isSafeInteger(reportId) &&
    (reportId as number) > cursor &&
    (reportId as number) <= cursor + MAX_CURSOR_JUMP &&
    (caseId === undefined || (Number.isSafeInteger(caseId) && (caseId as number) > 0)) &&
    typeof type === 'string' &&
    /^[a-z_]{1,40}$/.test(type) &&
    typeof short === 'string' &&
    short.length <= MAX_REPORT_TEXT &&
    typeof full === 'string' &&
    full.length <= MAX_REPORT_TEXT &&
    (createdAt === undefined || typeof createdAt === 'string')
  )
}

function reportIdOf(value: unknown): number | undefined {
  const id = (value as { reportId?: unknown } | null)?.reportId
  return Number.isSafeInteger(id) ? (id as number) : undefined
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

  private async page(app: string, cursor: number): Promise<unknown[] | null> {
    const answer = await this.deps.doctor(app).get(`/v1/reports?after=${cursor}&limit=${REPORTS_PAGE}`)
    const reports = (answer.body as { reports?: unknown } | null)?.reports
    if (answer.status !== 200 || !Array.isArray(reports)) {
      this.deps.log({ event: 'reports_failed', app, status: answer.status })
      return null
    }
    return reports
  }

  /** После испорченного файла состояния: дойти до конца ленты врача, ничего не пересылая. */
  private async skipToEnd(app: string): Promise<void> {
    let cursor = 0
    let skipped = 0
    for (;;) {
      const reports = await this.page(app, cursor)
      if (!reports) return
      const ids = reports.map(reportIdOf).filter((id): id is number => id !== undefined && id > cursor && id <= cursor + MAX_CURSOR_JUMP)
      if (ids.length === 0) break
      skipped += ids.length
      cursor = Math.max(...ids)
      if (reports.length < REPORTS_PAGE) break
    }
    this.deps.state.setReportCursor(app, cursor)
    this.deps.log({ event: 'reports_skipped_after_corrupt_state', app, skipped, cursor })
  }

  private async pullNow(app: string): Promise<void> {
    const entry = this.deps.config.apps.get(app)
    if (!entry) return
    const { state, post, log } = this.deps

    if (state.cursorLost(app)) await this.skipToEnd(app)
    if (state.cursorLost(app)) return

    for (;;) {
      const agentState = await post.state(entry.agentId)
      if (agentState === 'missing' || agentState === 'not_ready') return

      const cursor = state.reportCursor(app)
      const reports = await this.page(app, cursor)
      if (!reports) return
      const fresh = reports.filter((report): report is DoctorReport => isReport(report, cursor)).sort((a, b) => a.reportId - b.reportId)
      if (fresh.length < reports.length) log({ event: 'reports_rejected', app, count: reports.length - fresh.length })
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
        const ack = await this.deps.doctor(app).post('/v1/reports/ack', { upTo: delivered })
        if (ack.status !== 200) log({ event: 'reports_ack_failed', app, status: ack.status })
      }
      if (delivered !== fresh.at(-1)!.reportId || reports.length < REPORTS_PAGE) return
    }
  }
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
