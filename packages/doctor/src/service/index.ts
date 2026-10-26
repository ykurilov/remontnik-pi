import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { createTelegramClient } from '@ykurilov/remontnik-core/telegram'
import type { IncidentEvent } from '@ykurilov/remontnik-core/incident'
import type { RemontnikConfig } from '@ykurilov/remontnik-core/config'
import type { Models } from '@earendil-works/pi-ai'
import type { ReportInfo, Storage } from '@earendil-works/pi-durable'
import { createCaseBook, type CaseBook } from '../case-book/index.js'
import { startIntakeServer, createIntakeHandler, type IntakeServer } from '../intake/index.js'
import { createEvalProxy, type EvalProxy } from '../eval-proxy/index.js'
import { createModelBudget } from '../ledgers/model-budget.js'
import type { GitGuard } from '../git-guard/index.js'
import { assertPrivateAddress } from '@ykurilov/remontnik-core/private-address'
import { confirmAbandonedVersion } from '../deployer/index.js'
import { createDeployControlsHandler } from '../intake/deploy-controls.js'
import { createFingerprintReleaseHandler } from '../intake/fingerprint-release.js'
import { assertOwnerSecrets } from '../intake/http-kit.js'
import { createReportsFeedHandler } from '../intake/reports-feed.js'
import { createControls } from '../ledgers/controls.js'
import { createReports, type Reports } from '../reports/index.js'
import { createRecordEvalBaseCache, createTreatment, createWorkbenchEnvFactory, type Treatment } from '../treatment/index.js'
import type { CommandRunner } from '../workbench/index.js'
import { createCurrentVersionReader } from './current-version.js'
import { openDoctorHarness } from './harness.js'

// Каркас врача: хранилище pi-durable, приём событий, книга случаев, отчёты и Telegram.
// Отказ хранилища закрывает Harness; тогда врач шлёт тревогу напрямую и выходит с кодом 1 — его перезапустит systemd.

export interface DoctorServiceOptions {
  stateDir: string
  sharedSecret: string
  /** Секрет владельца: только им можно снова пустить выкатки после стоп-крана и снять «нужен человек» по отпечатку. Не задан — по HTTP нельзя. */
  controlSecret?: string
  listen: { host: string; port: number }
  telegram: { botToken: string; chatId: string; apiBaseUrl?: string; proxyToken?: string }
  /** Лента отчётов (R13). Не задана — адресов `/v1/reports*` нет. */
  reportsFeed?: {
    /** Ключ владельца: лента на основном адресе врача и команды `reports pull|ack`. */
    token?: string
    /** Мост Paseo: отдельный адрес только в частной сети, подпись секретом моста. `appName` — имя приложения этого врача. */
    bridge?: { listen: { host: string; port: number }; secret: string; appName: string }
  }
  exit?: (code: number) => void
  log?: (line: string) => void
  /** Для проверок: подменить хранилище. */
  wrapStorage?: (storage: Storage) => Storage
  now?: () => number
  /** Лечение случаев; без него врач только принимает случаи и сообщает о них. */
  treatment?: DoctorTreatmentOptions
}

export interface DoctorTreatmentOptions {
  guard: GitGuard
  /** Настройка приложения из основной ветки. */
  loadConfig(): Promise<RemontnikConfig>
  worktreesDir: string
  models: Models
  model: { provider: string; modelId: string }
  /** Где идут команды модели: контейнер (`createDockerRunner`). Без него врач не лечит. */
  runner?: CommandRunner
  /** Где идут проверки; по умолчанию — тот же, что у модели. */
  checksRunner?: CommandRunner
  /** Только для тестов: разрешить исполнитель без изоляции (`createLocalRunner`). */
  allowUnisolatedRunner?: boolean
  /** Коммит рабочей версии; по умолчанию — команда `deploy.commands.current` в основной копии репозитория. */
  currentVersion?: (config: RemontnikConfig) => Promise<string | undefined>
  /** Окружение, из которого eval берёт свои переменные, а прокси — ключи модели; по умолчанию — окружение врача. */
  evalEnv?: Readonly<Record<string, string | undefined>>
  /**
   * Прокси модели для eval (`eval-proxy`): слушает там, где его видит внутренняя сеть проверок, `publicUrl` — его адрес
   * из контейнера. Не задан — eval с провайдерами (`checks.eval.providers`) не запускается.
   */
  evalProxy?: { listen: { host: string; port: number }; publicUrl?: string }
  appDescription?: string
}

export interface DoctorService {
  url: string
  /** Адрес для моста Paseo; `null` — не включён. */
  bridgeUrl: string | null
  caseBook: CaseBook
  reports: Reports
  /** Отчёты pi-durable о сбоях, не роняющих вызов: припаркованная или упавшая задача и т. п. */
  handleHarnessReport(error: unknown, info: ReportInfo): void
  /** То же, что приём по сети: события сторожа → случаи, отчёты и лечение. */
  receiveEvents(events: IncidentEvent[]): Promise<{ accepted: string[] }>
  close(): Promise<void>
}

const REPORT_PUMP_INTERVAL_MS = 5_000
const TASK_REPORTS: Partial<Record<ReportInfo['type'], string>> = {
  task_parked: 'остановлена после повторных сбоев',
  task_faulted: 'упала',
  migration_failed: 'не перенесена на новую версию',
  task_outdated: 'не может продолжиться: её код сменился',
}

/** Модель и проверки идут только в контейнере; локальный исполнитель — лишь по явному разрешению тестов. */
function isolatedRunners(options: DoctorTreatmentOptions): { runner: CommandRunner; checksRunner: CommandRunner } {
  const { runner } = options
  const checksRunner = options.checksRunner ?? runner
  if (!runner || !checksRunner) throw new Error('врач лечит только в контейнере: задайте treatment.runner (createDockerRunner)')
  for (const candidate of [runner, checksRunner]) {
    if (candidate.isolation !== 'container' && options.allowUnisolatedRunner !== true) {
      throw new Error('исполнитель без изоляции: врач лечит только в контейнере (createDockerRunner); локальный — только для тестов')
    }
  }
  return { runner, checksRunner }
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
  // До открытия хранилища: настройка с публичным адресом для моста не должна даже начать работу.
  if (options.reportsFeed?.bridge) assertPrivateAddress(options.reportsFeed.bridge.listen.host, 'адрес приёма для моста Paseo')
  // До открытия хранилища: равные секреты — приложение получило бы права владельца.
  assertOwnerSecrets({ secret: options.sharedSecret, controlSecret: options.controlSecret })
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

  const treatmentOptions = options.treatment
  const runners = treatmentOptions ? isolatedRunners(treatmentOptions) : undefined
  // Свой у каждого запуска: брони модели и eval мёртвого запуска врача закрываются при следующих.
  const boot = randomUUID()
  const modelBudget = treatmentOptions
    ? createModelBudget({ models: treatmentOptions.models, boot, now, report: (error) => log(`[врач] учёт расходов модели: ${describeError(error)}`), log: (line) => log(`[врач] ${line}`) })
    : undefined
  const opened = await openDoctorHarness({
    stateDir: options.stateDir,
    onReport: (error, info) => handleHarnessReport(error, info),
    ...(options.wrapStorage ? { wrapStorage: options.wrapStorage } : {}),
    ...(options.now ? { now: options.now } : {}),
    ...(modelBudget && runners ? { models: modelBudget.models, env: createWorkbenchEnvFactory({ runner: runners.runner }) } : {}),
  })

  const caseBook = createCaseBook(opened.records, { now })
  const reports = createReports({
    store: opened.records,
    telegram: { client: telegram, chatId: options.telegram.chatId },
    now,
    onSendError: (error, report) => log(`[врач] отчёт ${report.reportId} не ушёл в Telegram: ${describeError(error)}`),
  })
  reportsRef = reports

  let evalProxy: EvalProxy | undefined
  if (treatmentOptions?.evalProxy) {
    try {
      evalProxy = await createEvalProxy(treatmentOptions.evalProxy)
    } catch (error) {
      await opened.close().catch(() => {})
      throw error
    }
  }

  let treatment: Treatment | undefined
  if (treatmentOptions && runners && modelBudget) {
    modelBudget.attach({ records: opened.records, loadConfig: treatmentOptions.loadConfig })
    treatment = createTreatment({
      reports,
      guard: treatmentOptions.guard,
      loadConfig: treatmentOptions.loadConfig,
      currentVersion: treatmentOptions.currentVersion ?? createCurrentVersionReader(treatmentOptions.guard.repoDir),
      model: treatmentOptions.model,
      workbenchRunner: runners.runner,
      checksRunner: runners.checksRunner,
      worktreesDir: treatmentOptions.worktreesDir,
      checksDir: join(options.stateDir, 'checks'),
      evalEnv: treatmentOptions.evalEnv ?? process.env,
      ...(evalProxy ? { evalProxy } : {}),
      evalBaseCache: createRecordEvalBaseCache(opened.records),
      ...(treatmentOptions.appDescription ? { appDescription: treatmentOptions.appDescription } : {}),
      modelBudget,
      boot,
      onReport: pump,
      now,
    })
    // До resume(): прерванные перезапуском задачи лечения продолжаются со своих чекпойнтов.
    opened.registry.install(treatment.extension)
  }
  opened.harness.resume()

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
    // Случай и отчёт о нём — одна транзакция: не бывает случая без отчёта для Paseo.
    const { accepted } = await caseBook.recordEvents(events, {
      async onNewCase(tx, opened) {
        // Владелец уже получил тревогу от сторожа; этот отчёт — для журнала и Paseo.
        const report = await reports.addIn(tx, {
          type: 'case_received',
          caseId: opened.caseId,
          short: `Случай ${opened.caseId} (${opened.appName}): ${opened.kind} в ${opened.where || 'неизвестном месте'} — ${opened.message}`,
          telegram: 'not_needed',
        })
        opened.reportIds.push(report.reportId)
        await treatment?.startIn(tx, opened)
      },
    })
    return { accepted }
  }

  const feed = options.reportsFeed
  const controls = createControls(opened.records)
  let intake: IntakeServer
  try {
    intake = await startIntakeServer({
      handler: createIntakeHandler({
        secret: options.sharedSecret,
        receiveEvents,
        health: async () => ({
          ok: harnessState === 'open',
          harness: harnessState,
          // Хранилище отказало — состояние стоп-крана неизвестно, но /health всё равно отвечает.
          autoDeploy: await controls.read().then((read) => read.autoDeploy, () => 'unknown'),
        }),
        deployControls: createDeployControlsHandler({
          controls,
          secret: options.sharedSecret,
          ...(options.controlSecret ? { controlSecret: options.controlSecret } : {}),
          confirmVersion: (version) => confirmAbandonedVersion(opened.records, version),
        }),
        fingerprintRelease: createFingerprintReleaseHandler({
          records: opened.records,
          secret: options.sharedSecret,
          ...(options.controlSecret ? { controlSecret: options.controlSecret } : {}),
        }),
        ...(feed?.token ? { reportsFeed: createReportsFeedHandler({ reports, access: { kind: 'token', token: feed.token } }) } : {}),
      }),
      host: options.listen.host,
      port: options.listen.port,
      onError: (error) => log(`[врач] сбой приёма событий: ${describeError(error)}`),
    })
  } catch (error) {
    await evalProxy?.close()
    await opened.close().catch(() => {})
    throw error
  }

  let bridgeIntake: IntakeServer | null = null
  if (feed?.bridge) {
    try {
      bridgeIntake = await startIntakeServer({
        handler: createReportsFeedHandler({ reports, access: { kind: 'bridge', secret: feed.bridge.secret, appName: feed.bridge.appName } }),
        host: feed.bridge.listen.host,
        port: feed.bridge.listen.port,
        onError: (error) => log(`[врач] сбой адреса для моста: ${describeError(error)}`),
      })
    } catch (error) {
      await intake.close()
      await evalProxy?.close()
      await opened.close().catch(() => {})
      throw error
    }
  }

  const pumpTimer = setInterval(pump, REPORT_PUMP_INTERVAL_MS)
  pumpTimer.unref()
  pump()

  return {
    url: intake.url,
    bridgeUrl: bridgeIntake?.url ?? null,
    caseBook,
    reports,
    handleHarnessReport,
    receiveEvents,
    async close() {
      closing = true
      clearInterval(pumpTimer)
      await intake.close()
      await bridgeIntake?.close()
      if (harnessState === 'open') await opened.close().catch((error: unknown) => log(`[врач] Harness не закрылся: ${describeError(error)}`))
      await evalProxy?.close()
    },
  }
}
