import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { redactSecrets } from '@ykurilov/remontnik-core/redact'
import { createTelegramClient } from '@ykurilov/remontnik-core/telegram'
import type { IncidentEvent } from '@ykurilov/remontnik-core/incident'
import type { RemontnikConfig } from '@ykurilov/remontnik-core/config'
import type { Models } from '@earendil-works/pi-ai'
import type { ReportInfo, Storage, TaskId, Wake } from '@earendil-works/pi-durable'
import { createCaseBook, type CaseBook } from '../case-book/index.js'
import type { CaseServices } from '../case-services/index.js'
import { startIntakeServer, createIntakeHandler, type IntakeServer } from '../intake/index.js'
import { createEvalProxy, type EvalProxy } from '../eval-proxy/index.js'
import { createModelBudget } from '../ledgers/model-budget.js'
import { GIT_GUARD_REASONS, GitGuardError, type GitGuard } from '../git-guard/index.js'
import { assertPrivateAddress } from '@ykurilov/remontnik-core/private-address'
import { confirmAbandonedVersion, type Deployer } from '../deployer/index.js'
import { createCaseRetryHandler } from '../intake/case-retry.js'
import { createDeployControlsHandler } from '../intake/deploy-controls.js'
import { createFingerprintReleaseHandler } from '../intake/fingerprint-release.js'
import { assertOwnerSecrets } from '../intake/http-kit.js'
import { createReportsFeedHandler } from '../intake/reports-feed.js'
import { createControls, readControls } from '../ledgers/controls.js'
import { createReports, type Reports } from '../reports/index.js'
import type { BrowserClient } from '../browser-tools/index.js'
import { createRecordEvalBaseCache, createTreatment, createWorkbenchEnvFactory, TREATMENT_TASK_NAME, type Treatment, type TreatmentInput } from '../treatment/index.js'
import type { CommandRunner } from '../workbench/index.js'
import { createCaseRetry } from './case-retry.js'
import { createCurrentVersionReader } from './current-version.js'
import { openDoctorHarness, type DoctorHarness } from './harness.js'

// Каркас врача: хранилище pi-durable, приём событий, книга случаев, отчёты и Telegram.
// Отказ хранилища закрывает Harness; тогда врач шлёт тревогу напрямую, оставляет пометку в папке состояния и выходит
// с кодом 1 — контейнер перезапустится сам. После перезапуска пометка становится отчётом doctor_problem.

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
  /** Для проверок с подменёнными часами: будить спящие задачи самим (`resume`), а не таймером. */
  onWake?: (wake: Wake, resume: () => void) => void
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
   * из контейнера. Готовый прокси (`EvalProxy`) закрывает тот, кто его создал. Не задан — eval с провайдерами
   * (`checks.eval.providers`) не запускается.
   */
  evalProxy?: { listen: { host: string; port: number }; publicUrl?: string } | EvalProxy
  /** Службы для тестов (`checks.services`) в сети проверок случая; без них такие проверки не запускаются. */
  services?: Pick<CaseServices, 'up'>
  appDescription?: string
  /** Выкатчик приложения (`createServerDeployer`). Не задан — врач правку не выкатывает, а сообщает «правка готова». */
  deployer?: Deployer
  /**
   * Служба браузера врача (`browserClientFromEnv`) и окружение для ссылки на живой экран (`browser.live.linkEnv`).
   * Без клиента инструменты `browser_*` отвечают `unavailable`, а выкатка идёт «без проверки в браузере».
   */
  browser?: { client?: BrowserClient; env?: Readonly<Record<string, string | undefined>>; pollMs?: number }
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
/** После этих сбоев задачу лечения владелец ставит в работу снова командой `case <id> retry`. */
const RETRYABLE_REPORTS: readonly ReportInfo['type'][] = ['task_parked', 'task_faulted']
/** Пометка об отказе хранилища: переживает выход врача, после перезапуска — отчёт doctor_problem. */
const STORAGE_FAILURE_MARK = 'storage-failure.json'

interface StorageFailureMark {
  at: string
  reason: string
  /** Тревога ушла в Telegram: отчёт после перезапуска её не повторяет. */
  telegramSent: boolean
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

/** Адрес с протоколом, адрес вида `user@host:path` и путь к репозиторию `….git`. */
const ADDRESS = /\b[a-z][a-z0-9+.-]*:\/\/\S+|[\w.-]+@[\w.-]+:[^\s]+|(?:\/[\w.-]+)+\.git\b\S*/gi

/**
 * Причина для отчёта `doctor_problem` (Telegram, Paseo). Сбой git — только по коду ошибки: текст git несёт адрес
 * и пути origin. В остальном адреса и секреты вырезаны. Полный текст — только в журнале врача.
 */
function problemReason(error: unknown): string {
  let current: unknown = error
  for (let depth = 0; current instanceof Error && depth < 4; depth += 1) {
    if (current instanceof GitGuardError) return `сбой git: ${GIT_GUARD_REASONS[current.code]}`
    current = current.cause
  }
  return redactSecrets(describeError(error).replace(ADDRESS, '<адрес>'))
}

/** Отказ хранилища прошлого запуска — отчётом doctor_problem: в ленте Paseo и, если тревога не ушла, в Telegram. */
async function reportStorageFailure(stateDir: string, reports: Reports, log: (line: string) => void): Promise<void> {
  const path = join(stateDir, STORAGE_FAILURE_MARK)
  if (!existsSync(path)) return
  let mark: StorageFailureMark
  try {
    mark = JSON.parse(readFileSync(path, 'utf8')) as StorageFailureMark
  } catch (error) {
    // Пометка недописана: врач умер посреди записи. Причина неизвестна, но об отказе владелец узнает.
    log(`[врач] пометка об отказе хранилища не прочитана: ${describeError(error)}`)
    mark = { at: 'время неизвестно', reason: 'причина неизвестна', telegramSent: false }
  }
  try {
    await reports.add({
      type: 'doctor_problem',
      short: `Врач перезапустился после отказа хранилища (${mark.reason}, ${mark.at}).`,
      telegram: mark.telegramSent ? 'not_needed' : 'pending',
    })
  } catch (error) {
    // Пометка остаётся до следующего запуска.
    log(`[врач] отчёт об отказе хранилища не записан: ${describeError(error)}`)
    return
  }
  rmSync(path, { force: true })
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
  let openedRef: DoctorHarness | null = null
  const reportsBeforeOpen: (() => void)[] = []

  const sendDirect = async (text: string): Promise<boolean> => {
    try {
      await telegram.sendMessage(options.telegram.chatId, text)
      return true
    } catch (error) {
      log(`[врач] Telegram недоступен: ${describeError(error)}`)
      return false
    }
  }

  const pump = () => {
    if (!reportsRef || harnessState !== 'open') return
    reportsRef.pump().catch((error: unknown) => log(`[врач] отчёты не отправлены: ${describeError(error)}`))
  }

  /** Случай задачи лечения; `undefined` — задача не лечения или хранилище недоступно. */
  async function caseOfTask(task: { id: TaskId; kind: string }): Promise<number | undefined> {
    if (task.kind !== TREATMENT_TASK_NAME || !openedRef || harnessState !== 'open') return undefined
    const found = await openedRef.harness.getTask(task.id, BACKGROUND_CONTEXT).catch(() => undefined)
    const caseId = (found?.input as TreatmentInput | undefined)?.caseId
    return typeof caseId === 'number' ? caseId : undefined
  }

  function handleHarnessReport(error: unknown, info: ReportInfo): void {
    log(`[врач] pi-durable: ${info.type}: ${describeError(error)}`)
    const what = TASK_REPORTS[info.type]
    if (!what || !('task' in info) || !info.task) return
    const task = info.task
    // Остановку задачи pi-durable сообщает ещё при открытии хранилища: отчёт ждёт, пока появятся записи отчётов.
    if (!reportsRef && harnessState === 'open') {
      reportsBeforeOpen.push(() => handleTaskReport(error, info, what, task))
      return
    }
    handleTaskReport(error, info, what, task)
  }

  function handleTaskReport(error: unknown, info: ReportInfo, what: string, task: { id: TaskId; kind: string }): void {
    void caseOfTask(task).then((caseId) => {
      const short =
        caseId === undefined
          ? `Врач: задача ${task.kind} (${task.id}) ${what}: ${problemReason(error)}`
          : `Врач: задача лечения случая ${caseId} ${what}: ${problemReason(error)}.` +
            (RETRYABLE_REPORTS.includes(info.type) ? ` Снова в работу: remontnik-doctor case ${caseId} retry` : '')
      if (!reportsRef || harnessState !== 'open') {
        void sendDirect(short)
        return
      }
      reportsRef
        .add({ type: 'doctor_problem', ...(caseId === undefined ? {} : { caseId }), short, telegram: 'pending' })
        .then(pump, () => sendDirect(short))
    })
  }

  const treatmentOptions = options.treatment
  const runners = treatmentOptions ? isolatedRunners(treatmentOptions) : undefined
  const onWake = options.onWake
  // Свой у каждого запуска: брони модели и eval мёртвого запуска врача закрываются при следующих.
  const boot = randomUUID()
  const modelBudget = treatmentOptions
    ? createModelBudget({ models: treatmentOptions.models, boot, now, report: (error) => log(`[врач] учёт расходов модели: ${describeError(error)}`), log: (line) => log(`[врач] ${line}`) })
    : undefined
  // До открытия хранилища и продолжения задач: git врача сейчас не идёт, а замки убитого запуска не дадут коммитить.
  const staleLocks = treatmentOptions ? await treatmentOptions.guard.clearStaleLocks() : []
  if (staleLocks.length > 0) log(`[врач] убраны замки git прошлого запуска: ${staleLocks.join(', ')}`)
  const opened = await openDoctorHarness({
    stateDir: options.stateDir,
    onReport: (error, info) => handleHarnessReport(error, info),
    ...(options.wrapStorage ? { wrapStorage: options.wrapStorage } : {}),
    ...(options.now ? { now: options.now } : {}),
    ...(onWake ? { onWake: (wake: Wake) => onWake(wake, () => harnessState === 'open' && opened.harness.resume()) } : {}),
    ...(modelBudget && runners ? { models: modelBudget.models, env: createWorkbenchEnvFactory({ runner: runners.runner }) } : {}),
  })

  openedRef = opened
  const caseBook = createCaseBook(opened.records, { now })
  const reports = createReports({
    store: opened.records,
    telegram: { client: telegram, chatId: options.telegram.chatId },
    autoDeploy: async () => (await readControls(opened.records)).autoDeploy,
    now,
    onSendError: (error, report) => log(`[врач] отчёт ${report.reportId} не ушёл в Telegram: ${describeError(error)}`),
  })
  reportsRef = reports
  for (const report of reportsBeforeOpen.splice(0)) report()
  await reportStorageFailure(options.stateDir, reports, log)

  let evalProxy: EvalProxy | undefined
  let ownEvalProxy: EvalProxy | undefined
  const evalProxyOption = treatmentOptions?.evalProxy
  if (evalProxyOption && 'openRun' in evalProxyOption) evalProxy = evalProxyOption
  else if (evalProxyOption) {
    try {
      evalProxy = ownEvalProxy = await createEvalProxy(evalProxyOption)
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
      ...(treatmentOptions.services ? { checksServices: treatmentOptions.services } : {}),
      evalBaseCache: createRecordEvalBaseCache(opened.records),
      ...(treatmentOptions.appDescription ? { appDescription: treatmentOptions.appDescription } : {}),
      ...(treatmentOptions.deployer ? { deployer: treatmentOptions.deployer } : {}),
      ...(treatmentOptions.browser ? { browser: treatmentOptions.browser } : {}),
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
    log(`[врач] хранилище отказало: ${describeError(end.error)}`)
    const reason = problemReason(end.error)
    const mark: StorageFailureMark = { at: new Date(now()).toISOString(), reason, telegramSent: false }
    const writeMark = () => {
      try {
        writeFileSync(join(options.stateDir, STORAGE_FAILURE_MARK), JSON.stringify(mark))
      } catch (error) {
        log(`[врач] пометка об отказе хранилища не записана: ${describeError(error)}`)
      }
    }
    // Пометка до отправки: если врач умрёт посреди неё, после перезапуска владелец всё равно узнает.
    writeMark()
    mark.telegramSent = await sendDirect(`Врач остановился: хранилище отказало (${reason}). Перезапускаюсь.`)
    if (mark.telegramSent) writeMark()
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
        caseRetry: createCaseRetryHandler({
          secret: options.sharedSecret,
          ...(options.controlSecret ? { controlSecret: options.controlSecret } : {}),
          retryCase: createCaseRetry({ harness: opened.harness, records: opened.records, ...(treatment ? { treatment } : {}), now }),
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
    await ownEvalProxy?.close()
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
      await ownEvalProxy?.close()
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
      await ownEvalProxy?.close()
    },
  }
}
