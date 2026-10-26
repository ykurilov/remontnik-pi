import type { RecordTransaction } from '../records/index.js'
import { REPORT_SCREENSHOTS_LIMIT } from '../reports/index.js'

// Что браузер врача накопил по случаю: снимки экрана, которые ещё не ушли в отчёт, и открытое ожидание человека
// (капча, код) — чтобы повтор команды на той же проверке не слал второй отчёт.

export const CASE_BROWSER_COLLECTION = 'case-browser'

export interface CaseBrowser {
  pendingShots: string[]
  /** Отчёт `needs_human` уже отправлен; снимается, когда браузер снова слушается врача. */
  humanWait?: { reportId: number; since: number }
}

const emptyCaseBrowser = (): CaseBrowser => ({ pendingShots: [] })

export function caseBrowserIn(records: RecordTransaction, caseId: number): Promise<CaseBrowser> {
  return records.doc<CaseBrowser>(CASE_BROWSER_COLLECTION, String(caseId), emptyCaseBrowser())
}

export async function addCaseScreenshotIn(records: RecordTransaction, caseId: number, path: string): Promise<void> {
  const state = await caseBrowserIn(records, caseId)
  state.pendingShots = [...state.pendingShots, path].slice(-REPORT_SCREENSHOTS_LIMIT)
}

/** Снимки, ещё не попавшие в отчёт: отдаёт и забывает — следующий отчёт их не повторит. */
export async function takeCaseScreenshotsIn(records: RecordTransaction, caseId: number): Promise<string[]> {
  const state = await caseBrowserIn(records, caseId)
  const shots = state.pendingShots
  if (shots.length > 0) state.pendingShots = []
  return shots
}
