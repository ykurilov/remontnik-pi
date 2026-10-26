import type { AgentPost } from './agent-post.js'
import type { BridgeConfig } from './bridge-config.js'
import type { BridgeStateStore } from './bridge-state.js'
import { DoctorAnswerTooLarge, type DoctorClient } from './doctor-client.js'
import { reportLetter, skippedReportLetter, type DoctorReport } from './task-text.js'

// Отчёты врача → агент приложения (R13). Курсор у моста сдвигается до письма: номер отчёта дважды не уходит.
// Письмо не ушло — курсор возвращается, отчёт уйдёт при следующем заборе. Курсор не записался — письма нет.
// Отчёт с номером дальше `MAX_CURSOR_JUMP` от курсора не принимается: один кривой номер не уводит курсор в бесконечность.
// Отчёт с разумным номером, но негодным содержимым (слишком большой текст) пропускается: курсор идёт дальше, агенту уходит короткое письмо.

export const REPORTS_PAGE = 50
export const MAX_CURSOR_JUMP = 100_000
/** За один забор страниц не больше этого: лента, которая не кончается, не держит мост вечно. */
const MAX_PAGES_PER_PULL = 200
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

  /** Страница ленты после курсора; `'too_large'` — ответ врача длиннее предела моста. */
  private async page(app: string, cursor: number, limit = REPORTS_PAGE): Promise<{ reports: unknown[]; acked: unknown } | 'too_large' | null> {
    let answer
    try {
      answer = await this.deps.doctor(app).get(`/v1/reports?after=${cursor}&limit=${limit}`)
    } catch (error) {
      if (error instanceof DoctorAnswerTooLarge) return 'too_large'
      throw error
    }
    const body = answer.body as { reports?: unknown; acked?: unknown } | null
    if (answer.status !== 200 || !Array.isArray(body?.reports)) {
      this.deps.log({ event: 'reports_failed', app, status: answer.status })
      return null
    }
    return { reports: body.reports, acked: body.acked }
  }

  /**
   * После испорченного файла состояния курсор берётся из подтверждения врача: он помнит, до какого номера Paseo уже получил отчёты.
   * Врач без этого поля (старый) — запасной путь: дойти до конца ленты, ничего не пересылая.
   */
  private async restoreCursor(app: string): Promise<void> {
    const first = await this.page(app, 0, 1)
    if (first === null || first === 'too_large') return
    if (Number.isSafeInteger(first.acked) && (first.acked as number) >= 0) {
      this.deps.state.setReportCursor(app, first.acked as number)
      this.deps.log({ event: 'report_cursor_restored', app, cursor: first.acked as number })
      return
    }
    await this.skipToEnd(app)
  }

  private async skipToEnd(app: string): Promise<void> {
    let cursor = 0
    let skipped = 0
    for (let pages = 0; pages < MAX_PAGES_PER_PULL; pages += 1) {
      const page = await this.page(app, cursor)
      if (page === null || page === 'too_large') return
      const ids = page.reports.map(reportIdOf).filter((id): id is number => id !== undefined && id > cursor && id <= cursor + MAX_CURSOR_JUMP)
      if (ids.length === 0) break
      skipped += ids.length
      cursor = Math.max(...ids)
    }
    this.deps.state.setReportCursor(app, cursor)
    this.deps.log({ event: 'reports_skipped_after_corrupt_state', app, skipped, cursor })
  }

  /** Что переслать с этой страницы: годные отчёты и номера тех, которых мост принять не может. */
  private plan(app: string, reports: unknown[], cursor: number): { id: number; letter: string; skipped: boolean }[] {
    const items = new Map<number, { id: number; letter: string; skipped: boolean }>()
    for (const report of reports) {
      const id = reportIdOf(report)
      if (id === undefined || id <= cursor || id > cursor + MAX_CURSOR_JUMP) continue
      if (isReport(report, cursor)) items.set(id, { id, letter: reportLetter(app, report), skipped: false })
      else items.set(id, { id, letter: skippedReportLetter(app, id), skipped: true })
    }
    const rejected = reports.length - items.size
    if (rejected > 0) this.deps.log({ event: 'reports_rejected', app, count: rejected })
    return [...items.values()].sort((a, b) => a.id - b.id)
  }

  private async pullNow(app: string): Promise<void> {
    const entry = this.deps.config.apps.get(app)
    if (!entry) return
    const { state, post, log } = this.deps

    if (state.cursorLost(app)) await this.restoreCursor(app)
    if (state.cursorLost(app)) return

    for (let pages = 0; pages < MAX_PAGES_PER_PULL; pages += 1) {
      const agentState = await post.state(entry.agentId)
      if (agentState === 'missing' || agentState === 'not_ready') return

      const cursor = state.reportCursor(app)
      let page = await this.page(app, cursor)
      // Страница не влезла в предел ответа: просим по одному. Одиночный отчёт, который всё равно не влезает, пропускается.
      if (page === 'too_large') page = await this.page(app, cursor, 1)
      if (page === null) return
      const items = page === 'too_large' ? [{ id: cursor + 1, letter: skippedReportLetter(app, cursor + 1), skipped: true }] : this.plan(app, page.reports, cursor)
      if (items.length === 0) return

      let processed = cursor
      let stopped = false
      for (const item of items) {
        const before = state.reportCursor(app)
        state.setReportCursor(app, item.id)
        let outcome
        try {
          outcome = await post.deliver(entry.agentId, item.letter)
        } catch (error) {
          state.setReportCursor(app, before)
          log({ event: 'report_not_sent', app, reportId: item.id, reason: errorText(error) })
          stopped = true
          break
        }
        if (outcome !== 'sent') {
          state.setReportCursor(app, before)
          log({ event: 'report_not_sent', app, reportId: item.id, reason: outcome })
          stopped = true
          break
        }
        processed = item.id
        log({ event: item.skipped ? 'report_skipped' : 'report_sent', app, reportId: item.id })
      }

      if (processed > cursor) {
        const ack = await this.deps.doctor(app).post('/v1/reports/ack', { upTo: processed })
        if (ack.status !== 200) log({ event: 'reports_ack_failed', app, status: ack.status })
      }
      if (stopped || processed === cursor) return
    }
  }
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
