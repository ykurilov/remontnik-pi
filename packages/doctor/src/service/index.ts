import { createTelegramClient } from '@ykurilov/remontnik-core/telegram'
import type { IncidentEvent } from '@ykurilov/remontnik-core/incident'
import type { ReportInfo, Storage } from '@earendil-works/pi-durable'
import { createCaseBook, type CaseBook } from '../case-book/index.js'
import { startIntakeServer, createIntakeHandler, type IntakeServer } from '../intake/index.js'
import { createReports, type Reports } from '../reports/index.js'
import { openDoctorHarness } from './harness.js'

// Каркас врача: хранилище pi-durable, приём событий, книга случаев, отчёты и Telegram.
// Отказ хранилища закрывает Harness; тогда врач шлёт тревогу напрямую и выходит с кодом 1 — его перезапустит systemd.

export interface DoctorServiceOptions {
  stateDir: string
  sharedSecret: string
  listen: { host: string; port: number }
  telegram: { botToken: string; chatId: string; apiBaseUrl?: string; proxyToken?: string }
  exit?: (code: number) => void
  log?: (line: string) => void
  /** Для проверок: подменить хранилище. */
  wrapStorage?: (storage: Storage) => Storage
  now?: () => number
}

export interface DoctorService {
  url: string
  caseBook: CaseBook
  reports: Reports
  /** Отчёты pi-durable о сбоях, не роняющих вызов: припаркованная или упавшая задача и т. п. */
  handleHarnessReport(error: unknown, info: ReportInfo): void
  close(): Promise<void>
}

const REPORT_PUMP_INTERVAL_MS = 5_000
const TASK_REPORTS: Partial<Record<ReportInfo['type'], string>> = {
  task_parked: 'остановлена после повторных сбоев',
  task_faulted: 'упала',
  migration_failed: 'не перенесена на новую версию',
  task_outdated: 'не может продолжиться: её код сменился',
}

function describeError(error: unknown): string {
  const parts: string[] = []
  let current: unknown = error
  for (let depth = 0; current !== undefined && current !== null && depth < 4; depth += 1) {
    const message = current instanceof Error ? current.message : String(current)
    if (!parts.includes(message)) parts.push(message)
    current = current instanceof Error ? current.cause : undefined
  }
  return parts.join(' ← ')
}

export async function startDoctorService(options: DoctorServiceOptions): Promise<DoctorService> {
  const log = options.log ?? ((line: string) => console.error(line))
  const exit = options.exit ?? ((code: number) => process.exit(code))
  const now = options.now ?? Date.now
  const telegram = createTelegramClient({
    botToken: options.telegram.botToken,
    ...(options.telegram.apiBaseUrl === undefined ? {} : { apiBaseUrl: options.telegram.apiBaseUrl }),
    ...(options.telegram.proxyToken === undefined ? {} : { proxyToken: options.telegram.proxyToken }),
  })
  let harnessState: 'open' | 'failed' | 'closed' = 'open'
  let closing = false
  let reportsRef: Reports | null = null

  const sendDirect = async (text: string) => {
    try {
      await telegram.sendMessage(options.telegram.chatId, text)
    } catch (error) {
      log(`[врач] Telegram недоступен: ${describeError(error)}`)
    }
  }

  const pump = () => {
    if (!reportsRef || harnessState !== 'open') return
    reportsRef.pump().catch((error: unknown) => log(`[врач] отчёты не отправлены: ${describeError(error)}`))
  }

  function handleHarnessReport(error: unknown, info: ReportInfo): void {
    log(`[врач] pi-durable: ${info.type}: ${describeError(error)}`)
    const what = TASK_REPORTS[info.type]
    if (!what || !('task' in info) || !info.task) return
    const short = `Врач: задача ${info.task.kind} (${info.task.id}) ${what}: ${describeError(error)}`
    if (!reportsRef || harnessState !== 'open') {
      void sendDirect(short)
      return
    }
    reportsRef
      .add({ type: 'doctor_problem', short, telegram: 'pending' })
      .then(pump, () => sendDirect(short))
  }

  const opened = await openDoctorHarness({
    stateDir: options.stateDir,
    onReport: (error, info) => handleHarnessReport(error, info),
    ...(options.wrapStorage ? { wrapStorage: options.wrapStorage } : {}),
    ...(options.now ? { now: options.now } : {}),
  })
  opened.harness.resume()

  const caseBook = createCaseBook(opened.records)
  const reports = createReports({
    store: opened.records,
    telegram: { client: telegram, chatId: options.telegram.chatId },
    now,
    onSendError: (error, report) => log(`[врач] отчёт ${report.reportId} не ушёл в Telegram: ${describeError(error)}`),
  })
  reportsRef = reports

  void opened.closed.then(async (end) => {
    if (end.reason !== 'failed') {
      harnessState = 'closed'
      return
    }
    harnessState = 'failed'
    if (closing) return
    const text = `Врач остановился: хранилище отказало (${describeError(end.error)}). Перезапускаюсь.`
    log(`[врач] ${text}`)
    await sendDirect(text)
    exit(1)
  })

  async function receiveEvents(events: IncidentEvent[]): Promise<{ accepted: string[] }> {
    const { accepted, newCases } = await caseBook.recordEvents(events)
    for (const opened of newCases) {
      // Владелец уже получил тревогу от сторожа; этот отчёт — для журнала и Paseo.
      const report = await reports.add({
        type: 'case_received',
        caseId: opened.caseId,
        short: `Случай ${opened.caseId}: ${opened.kind} в ${opened.where || 'неизвестном месте'} — ${opened.message}`,
        telegram: 'not_needed',
      })
      await caseBook.linkReport(opened.caseId, report.reportId)
    }
    return { accepted }
  }

  let intake: IntakeServer
  try {
    intake = await startIntakeServer({
      handler: createIntakeHandler({
        secret: options.sharedSecret,
        receiveEvents,
        health: () => ({ ok: harnessState === 'open', harness: harnessState, autoDeploy: 'on' }),
      }),
      host: options.listen.host,
      port: options.listen.port,
      onError: (error) => log(`[врач] сбой приёма событий: ${describeError(error)}`),
    })
  } catch (error) {
    await opened.close().catch(() => {})
    throw error
  }

  const pumpTimer = setInterval(pump, REPORT_PUMP_INTERVAL_MS)
  pumpTimer.unref()
  pump()

  return {
    url: intake.url,
    caseBook,
    reports,
    handleHarnessReport,
    async close() {
      closing = true
      clearInterval(pumpTimer)
      await intake.close()
      if (harnessState === 'open') await opened.close().catch((error: unknown) => log(`[врач] Harness не закрылся: ${describeError(error)}`))
    },
  }
}
