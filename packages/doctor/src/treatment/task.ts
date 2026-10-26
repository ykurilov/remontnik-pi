import { join } from 'node:path'
import type { JsonValue } from '@earendil-works/chord'
import type { Context } from '@earendil-works/chord/context'
import {
  configure,
  defineExtension,
  defineTask,
  GenerationTask,
  hook,
  UsageDoc,
  type ConversationId,
  type DocumentReader,
  type Extension,
  type TaskRuntime,
  type UsageState,
} from '@earendil-works/pi-durable'
import type { RemontnikConfig } from '@ykurilov/remontnik-core/config'
import { redactSecrets, redactValue } from '@ykurilov/remontnik-core/redact'
import type { Case, CaseState } from '../case-book/index.js'
import { createChecks, selectEvalScenarios, type ChecksResult, type EvalBaseCache } from '../checks/index.js'
import type { EvalProxy, EvalSpend } from '../eval-proxy/index.js'
import { decideDeploy, type GateDecision } from '../deploy-gate/index.js'
import { GitGuardError, slugify, type GitGuard } from '../git-guard/index.js'
import { diagnoseMessage, fixMessage, resumeMessage } from '../model/case-messages.js'
import { buildRepoMap, buildSystemPrompt } from '../model/system-prompt.js'
import { matchesAnyMask } from '../path-mask/index.js'
import type { RecordStore, RecordTransaction } from '../records/index.js'
import type { ReportType, Reports } from '../reports/index.js'
import { budgetDeferredReport } from '../reports/budget-texts.js'
import { agentChatSdkReport, agentChatSdkTask, gateReport } from '../reports/gate-texts.js'
import { causeFoundReport, fixReadyReport, needsHumanReport, noCauseFoundReport, standBrokenReport, type ReportText } from '../reports/texts.js'
import { durableTxOf, recordFamilyOf, recordTransactionOver } from '../service/harness.js'
import { createWorkbench, SpoiledCopyError, type CommandRunner } from '../workbench/index.js'
import { TreatmentDoc, type Diagnosis, type FixSummary, type TreatmentDocState } from './doc.js'
import { agentChatSdkPackage, closingOf, deployFactsOf, fixCanBeChecked, inspectFix, noDeployControls, type DeployControls, type FixInspection } from './gate.js'
import { deployAttemptsOf, LEDGER, type FingerprintLedger } from '../ledgers/fingerprint-ledger.js'
import {
  emptySpendDay,
  evalSpentUsd,
  joinEvalQueueIn,
  leaveEvalQueueIn,
  modelDayTotalUsd,
  modelBlock,
  modelSpentUsd,
  nextDayStartMs,
  recordEvalObserved,
  reserveEvalIn,
  settleEvalWithProxyFact,
  spendDayKey,
  type CaseSpend,
  type EvalReservation,
  type ModelBlock,
  type SpendDay,
} from '../ledgers/spend-ledger.js'
import { doctorToolGuard, doctorTools } from './tools.js'

// Задача лечения `remontnik.treatment` (R1). Фазы — чекпойнты pi-durable: перезапуск врача продолжает
// с последней сохранённой фазы, а фаза после перезапуска выполняется заново с начала, поэтому каждая
// идемпотентна: копия переиспользуется, запрос модели находится по `requestId`, итог модели лежит в документе.
//
//   triage → diagnosing → fixing → verifying → gated → (этап 6: выкатка)
//
// Основа — рабочая версия (`deploy.commands.current`); неизвестна — последний коммит основной ветки, и отчёт это говорит.
// Выкатывать или нет, решает только фаза `gated` (`decideDeploy` по фактам из `gate.ts`). Правка, которая задевает
// защищённые пути (тесты, eval, зависимости, сборку, Ремонтника) или похожа на подделку проверки, идёт в `gated`
// без проверок и не отправляется. Причина в Agent Chat SDK — правки нет, отчёт с задачей для агента SDK.
// Подменённая копия (git-замок: `escape`) — попытка выхода из верстака: случай останавливается.
// Расход модели и eval пишется в дневной учёт (`ledgers/spend-ledger.ts`) по ходу работы. Кончился дневной бюджет —
// случай `deferred_budget`: задача спит до начала следующих суток и продолжает тот же этап (модели — просьба продолжить).
// Запрос модели сверх потолка держит `budgetHook` до остановки разговора.
// Плохой ответ бота (`bad_answer`) лечится так же: выдержка разговора идёт модели вычищенной и помеченной как данные,
// правку проверяет eval по карте `evalScope`; карта не даёт сценариев — eval «не запускался», и выкатки нет.
//
// Модель работает в отдельном разговоре, которым владеет задача: системный промпт и набор инструментов
// постоянны для основы, сведения о случае — в сообщениях.

export type TreatmentInput = { caseId: number }

type Treating = {
  conversationId: ConversationId
  baseCommit: string
  /** Основа — рабочая версия; `false` — основная ветка, какая версия работает, неизвестно. */
  baseRunning: boolean
  branch: string
  worktreePath: string
  /** Потолок расходов модели на случай. */
  limitUsd: number
  /** Сколько раз случай откладывался до следующих суток. */
  resumes?: number
}

export type TreatmentState =
  | { phase: 'triage' }
  | ({ phase: 'diagnosing' } & Treating)
  | ({ phase: 'fixing'; diagnosis: Diagnosis } & Treating)
  | ({ phase: 'verifying' } & Fixed & Treating)
  | ({ phase: 'gated'; checks?: ChecksResult; pushed: boolean } & Fixed & Treating)

/** Закоммиченная правка и осмотр её диффа. */
type Fixed = { diagnosis: Diagnosis; fix: FixSummary; fixCommit: string; changedPaths: string[]; inspection: FixInspection }

export type TreatmentOutcome = 'fix_ready' | 'cause_found' | 'no_cause_found' | 'stand_broken' | 'needs_human'

export type TreatmentResult = {
  outcome: TreatmentOutcome
  /** Почему нужен человек. */
  why?: 'escape' | 'spoiled' | 'agent_chat_sdk' | 'gate'
  reportId: number
  /** Решение фазы `gated`. */
  gate?: GateDecision
  /** Пакет Agent Chat SDK, в котором причина. */
  sdkPackage?: string
  branch?: string
  fixCommit?: string
  changedPaths?: string[]
  checks?: ChecksResult
}

export interface TreatmentDeps {
  reports: Pick<Reports, 'addIn'>
  guard: GitGuard
  /** Настройка приложения из основной ветки. */
  loadConfig(): Promise<RemontnikConfig>
  /** Коммит рабочей версии (`deploy.commands.current`); `undefined` — узнать не удалось. */
  currentVersion(config: RemontnikConfig): Promise<string | undefined>
  model: { provider: string; modelId: string }
  /** Исполнитель команд модели: знает, испорчена ли копия неубитой командой. */
  workbenchRunner: Pick<CommandRunner, 'spoiled'>
  /** Исполнитель проверок (тесты, eval). */
  checksRunner: CommandRunner
  worktreesDir: string
  /** Папка для итогов eval. */
  checksDir: string
  /** Окружение врача: несекретные переменные eval и ключи провайдеров модели (их видит только прокси). */
  evalEnv: Readonly<Record<string, string | undefined>>
  /** Прокси модели для eval; без него eval с провайдерами не запускается. */
  evalProxy?: Pick<EvalProxy, 'openRun'>
  evalBaseCache: EvalBaseCache
  /** Стоп-кран и перенос на свежий main. Нет — выкатки ещё нет (`noDeployControls`). Попытки — из учёта по отпечатку. */
  deployControls?: DeployControls
  appDescription?: string
  /** Как часто сверять расход модели с потолком. */
  budgetPollMs: number
  /** Новый отчёт записан: пора отправлять. */
  onReport(): void
  now(): number
}

export interface Treatment {
  extension: Extension
  /** Внутри транзакции нового случая: разговор случая и задача лечения появляются вместе со случаем. */
  startIn(tx: RecordTransaction, opened: Case): Promise<void>
}

type Runtime = TaskRuntime<TreatmentInput, TreatmentState, TreatmentResult, object>
type ConverseStatus = 'answered' | 'failed' | ModelBlock
type Stage = 'diagnose' | 'fix'
type Base = { commit: string; running: boolean }

const BASE_UNKNOWN_NOTE = 'Заметка: основа — main, рабочая версия неизвестна.'
const COMMIT_SHA = /^[0-9a-f]{7,64}$/i
/** Остаток eval на сегодня держат чужие брони: через сколько спросить снова. */
const EVAL_WAIT_MS = 60_000
/** Как часто удерживаемый запрос проверяет, не отпустил ли потолок. */
const BUDGET_HOLD_RECHECK_MS = 1_000

function spentUsd(usage: UsageState | undefined): number {
  if (!usage) return 0
  return [...Object.values(usage.models), ...Object.values(usage.tools)].reduce((sum, item) => sum + (item.cost?.total ?? 0), 0)
}

/** Потолок расходов модели на случай. */
function caseLimitUsdOf(config: RemontnikConfig): number {
  return config.limits.diagnoseUsdPerCase ?? config.limits.modelUsdPerDay
}

function caseKey(caseId: number): string {
  return String(caseId)
}

async function caseIn(records: RecordTransaction, caseId: number): Promise<Case> {
  const opened = await records.doc<Case>('case', caseKey(caseId), {} as Case)
  if (opened.caseId !== caseId) throw new Error(`случая ${caseId} нет`)
  return opened
}

function commitMessage(caseId: number, fix: FixSummary, diagnosis: Diagnosis): string {
  const title = `Ремонтник: случай ${caseId} — ${fix.summary}`.split('\n')[0]!.slice(0, 100)
  return `${title}\n\nПричина: ${diagnosis.cause}\n`
}

export function createTreatment(deps: TreatmentDeps): Treatment {
  async function readCase(runtime: Runtime, caseId: number, context: Context): Promise<Case> {
    const found = (await runtime.snapshot(recordFamilyOf('case'), caseKey(caseId), context)) as unknown as Case | undefined
    if (!found || found.caseId !== caseId) throw new Error(`случая ${caseId} нет`)
    return found
  }

  async function treatmentDoc(runtime: Runtime, conversationId: ConversationId, context: Context): Promise<TreatmentDocState> {
    const state = await runtime.snapshot(TreatmentDoc, conversationId, context)
    if (!state?.case) throw new Error('документ лечения пуст')
    return state
  }

  /** Ключи eval: их значения вырезаются из всего, что уходит наружу или модели. */
  function knownSecretsOf(config: RemontnikConfig): string[] {
    const evalNames = [...(config.checks.eval?.env ?? []), ...(config.checks.eval?.providers ?? []).map((provider) => provider.keyEnv)]
    return evalNames.flatMap((name) => deps.evalEnv[name] ?? [])
  }

  /** Ключи eval и всё похожее на секреты вырезается из отчёта: он уходит в Telegram и Paseo. */
  async function redactedReport(text: ReportText, baseRunning: boolean): Promise<ReportText> {
    const knownSecrets = knownSecretsOf(await deps.loadConfig())
    return {
      short: redactSecrets(text.short, { knownSecrets }),
      full: redactSecrets(baseRunning ? text.full : `${text.full}\n${BASE_UNKNOWN_NOTE}`, { knownSecrets }),
    }
  }

  /** Отчёт, состояние случая и итог задачи — одной фиксацией. */
  async function finish(
    runtime: Runtime,
    caseId: number,
    state: CaseState,
    type: ReportType,
    text: ReportText,
    result: Omit<TreatmentResult, 'reportId'>,
    context: Context,
    baseRunning = true,
  ): Promise<void> {
    const { short, full } = await redactedReport(text, baseRunning)
    await runtime.commit(async (tx) => {
      const records = recordTransactionOver(tx)
      const opened = await caseIn(records, caseId)
      opened.state = state
      const report = await deps.reports.addIn(records, { type, caseId, short, full, telegram: 'pending' })
      opened.reportIds.push(report.reportId)
      return { status: 'terminal', outcome: { status: 'completed', result: { ...result, reportId: report.reportId } } }
    }, context)
    deps.onReport()
  }

  /**
   * Дневной бюджет кончился: случай `deferred_budget`, отчёт и сон задачи до начала следующих суток — одной фиксацией.
   * Проснувшись, задача продолжает тот же этап.
   */
  async function deferToNextDay(runtime: Runtime, caseId: number, checkpoint: Extract<TreatmentState, Treating>, what: 'model' | 'eval', context: Context): Promise<void> {
    const config = await deps.loadConfig()
    const now = deps.now()
    const resumeAt = nextDayStartMs(now, config.app.timeZone)
    const day = (await runtime.snapshot(recordFamilyOf('spend'), spendDayKey(now, config.app.timeZone), context)) as unknown as SpendDay | undefined
    const doc = await treatmentDoc(runtime, checkpoint.conversationId, context)
    const text = budgetDeferredReport({
      case: doc.case,
      what,
      spentUsd: what === 'model' ? modelSpentUsd(day) : evalSpentUsd(day),
      limitUsd: what === 'model' ? config.limits.modelUsdPerDay : config.limits.evalUsdPerDay,
      resumeAt,
      timeZone: config.app.timeZone,
    })
    const { short, full } = await redactedReport(text, checkpoint.baseRunning)
    await runtime.commit(async (tx) => {
      const records = recordTransactionOver(tx)
      const opened = await caseIn(records, caseId)
      opened.state = 'deferred_budget'
      const report = await deps.reports.addIn(records, { type: 'budget_reached', caseId, short, full, telegram: 'pending' })
      opened.reportIds.push(report.reportId)
      // Отложенный случай сегодня eval не ждёт: его доля остатка дня не бережётся.
      await leaveEvalQueueIn(records, caseKey(caseId))
      return { status: 'sleeping', until: resumeAt, checkpoint: { ...checkpoint, resumes: (checkpoint.resumes ?? 0) + 1 } }
    }, context)
    deps.onReport()
  }

  /** Задача проснулась после переноса: случай снова в работе на своём этапе. */
  async function backFromDeferral(runtime: Runtime, caseId: number, state: CaseState, context: Context): Promise<void> {
    if ((await readCase(runtime, caseId, context)).state !== 'deferred_budget') return
    await runtime.commit(async (tx) => {
      ;(await caseIn(recordTransactionOver(tx), caseId)).state = state
      return undefined
    }, context)
  }

  /**
   * Можно ли разговору случая ещё один запрос к модели: потолок случая и дневной с запасом, вместе с расходом,
   * который разговор уже сделал, но в день ещё не записал. Читает только записанное — годится и для хука.
   */
  async function modelBlockOf(reader: DocumentReader, conversationId: ConversationId, caseId: number, context: Context): Promise<ModelBlock | undefined> {
    const config = await deps.loadConfig()
    const day = (await reader.snapshot(recordFamilyOf('spend'), spendDayKey(deps.now(), config.app.timeZone), context)) as unknown as SpendDay | undefined
    const recorded = (await reader.snapshot(recordFamilyOf('spend-case'), caseKey(caseId), context)) as unknown as CaseSpend | undefined
    const caseUsd = spentUsd(await reader.snapshot(UsageDoc, conversationId, context))
    return modelBlock({ caseUsd, caseLimitUsd: caseLimitUsdOf(config), dayUsd: modelDayTotalUsd(day, recorded, caseUsd), limits: config.limits })
  }

  /** Разбудить сверку расходов разговора: хук увидел запрос сверх потолка. */
  const budgetWatchers = new Map<ConversationId, () => void>()

  /**
   * Записывает расход модели по случаю в дневной учёт (приращением к уже записанному) и возвращает расход модели за день.
   */
  async function recordModelSpend(runtime: Runtime, caseId: number, caseTotalUsd: number, timeZone: string, context: Context): Promise<number> {
    let dayTotal = 0
    await runtime.commit(async (tx) => {
      const records = recordTransactionOver(tx)
      const day = await records.doc<SpendDay>('spend', spendDayKey(deps.now(), timeZone), emptySpendDay())
      const recorded = await records.doc<CaseSpend>('spend-case', caseKey(caseId), { recordedModelUsd: 0 })
      const delta = caseTotalUsd - recorded.recordedModelUsd
      if (delta > 0) {
        day.model[caseKey(caseId)] = (day.model[caseKey(caseId)] ?? 0) + delta
        recorded.recordedModelUsd = caseTotalUsd
      }
      dayTotal = modelSpentUsd(day)
      return undefined
    }, context)
    return dayTotal
  }

  /**
   * Один этап работы модели. Пока она работает, расход пишется в дневной учёт и сверяется с потолками
   * случая и дня; превысила — разговор прерывается. После перезапуска тот же `requestId` находит тот же запрос.
   * После переноса на следующие сутки этап продолжается просьбой продолжить, новым запросом.
   */
  async function converse(
    runtime: Runtime,
    treating: Treating,
    caseId: number,
    stage: Stage,
    content: string,
    context: Context,
  ): Promise<{ status: ConverseStatus; spentUsd: number }> {
    const config = await deps.loadConfig()
    const spent = async () => spentUsd(await runtime.snapshot(UsageDoc, treating.conversationId, context))
    const overLimit = async (): Promise<ModelBlock | undefined> => {
      await recordModelSpend(runtime, caseId, await spent(), config.app.timeZone, context)
      return modelBlockOf(runtime, treating.conversationId, caseId, context)
    }
    const handle = await runtime.conversation(treating.conversationId, context)
    if (!handle) throw new Error('разговор модели пропал')
    const before = await overLimit()
    if (before) {
      // Запрос, оставшийся от перезапуска, ждёт в хуке: снимаем его, чтобы он не ушёл, когда потолок отпустит.
      await handle.abort(context)
      return { status: before, spentUsd: await spent() }
    }
    const resumes = treating.resumes ?? 0
    const asked = (await runtime.memo<boolean>(`asked:${stage}`, context)) === true
    await runtime.memo(`asked:${stage}`, true, context)
    const request =
      asked && resumes > 0 ? { requestId: `${stage}:${caseId}:resume-${resumes}`, content: resumeMessage() } : { requestId: `${stage}:${caseId}`, content }
    const submission = await handle.submit({ type: 'input', ...request }, context)

    let settled = false
    let stopped: ModelBlock | undefined
    const watcher = (async () => {
      while (!settled && !runtime.signal.aborted) {
        await new Promise<void>((resolve) => {
          const disarm = runtime.setTimer(resolve, deps.budgetPollMs)
          budgetWatchers.set(treating.conversationId, () => {
            disarm()
            resolve()
          })
        })
        if (settled || runtime.signal.aborted) return
        stopped = await overLimit()
        if (stopped) {
          await handle.abort(context)
          return
        }
      }
    })().catch((error: unknown) => runtime.report(error))
    try {
      const record = await submission.wait(context)
      settled = true
      budgetWatchers.get(treating.conversationId)?.()
      await watcher
      const total = await spent()
      await recordModelSpend(runtime, caseId, total, config.app.timeZone, context)
      if (stopped) return { status: stopped, spentUsd: total }
      return { status: record.status === 'done' ? 'answered' : 'failed', spentUsd: total }
    } finally {
      settled = true
      budgetWatchers.get(treating.conversationId)?.()
      budgetWatchers.delete(treating.conversationId)
    }
  }

  /** Основа лечения: рабочая версия, если её удалось узнать и она есть в origin; иначе — основная ветка. */
  async function chooseBase(config: RemontnikConfig): Promise<Base> {
    const version = await deps.currentVersion(config).catch(() => undefined)
    if (version && COMMIT_SHA.test(version)) {
      const commit = await deps.guard.resolve(version).catch(() => undefined)
      if (commit) return { commit, running: true }
    }
    return { commit: await deps.guard.resolve(`origin/${config.repo.mainBranch}`), running: false }
  }

  /**
   * Бронь eval: доля случая, не больше остатка дня, поровну с другими ждущими (`reserveEvalIn`).
   * Брони прогонов, прерванных перезапуском, закрываются фактом прокси.
   */
  async function reserveEval(runtime: Runtime, caseId: number, config: RemontnikConfig, context: Context) {
    const dayKey = spendDayKey(deps.now(), config.app.timeZone)
    let reserved: Awaited<ReturnType<typeof reserveEvalIn>> = { admission: { kind: 'wait' } }
    await runtime.commit(async (tx) => {
      reserved = await reserveEvalIn(recordTransactionOver(tx), { dayKey, caseKey: caseKey(caseId), now: deps.now(), limits: config.limits })
      return undefined
    }, context)
    return { day: dayKey, ...reserved }
  }

  async function updateReservation(runtime: Runtime, reservation: { day: string; id: string }, context: Context, change: (item: EvalReservation) => void): Promise<void> {
    await runtime.commit(async (tx) => {
      const item = (await recordTransactionOver(tx).doc<SpendDay>('spend', reservation.day, emptySpendDay())).eval[reservation.id]
      if (item) change(item)
      return undefined
    }, context)
  }

  /**
   * Расход eval по прокси — в бронь по ходу, записи по очереди. Прокси ждёт записи: бронь запроса попадает
   * в журнал до отправки к поставщику, а не удалась запись — запрос не уходит.
   */
  function evalSpendRecorder(runtime: Runtime, reservation: { day: string; id: string }, context: Context) {
    let latest: EvalSpend | undefined
    let chain = Promise.resolve()
    return {
      latest: () => latest,
      record(spend: EvalSpend): Promise<void> {
        latest = spend
        const write = chain.then(() => updateReservation(runtime, reservation, context, (item) => recordEvalObserved(item, spend)))
        chain = write.catch((error: unknown) => runtime.report(error))
        return write
      },
      flush: () => chain,
    }
  }

  /**
   * Верстаку больше нельзя верить: git-замок нашёл подменённую копию (`escape`) или команду не удалось убить
   * (`SpoiledCopyError`). Лечение останавливается, нужен человек. Остальные ошибки летят дальше.
   */
  async function stopOnBrokenWorkbench(runtime: Runtime, caseId: number, treating: Treating, context: Context, work: () => Promise<void>): Promise<void> {
    try {
      await work()
    } catch (error) {
      const reason =
        error instanceof GitGuardError && error.code === 'escape'
          ? ({ kind: 'escape', detail: error.message } as const)
          : error instanceof SpoiledCopyError
            ? ({ kind: 'spoiled', detail: error.message } as const)
            : undefined
      if (!reason) throw error
      const doc = await treatmentDoc(runtime, treating.conversationId, context)
      const text = needsHumanReport({ case: doc.case, ...(doc.diagnosis ? { diagnosis: doc.diagnosis } : {}), reason })
      await finish(runtime, caseId, 'needs_human', 'needs_human', text, { outcome: 'needs_human', why: reason.kind }, context, treating.baseRunning)
    }
  }

  function assertWorkbenchIntact(treating: Treating): void {
    if (deps.workbenchRunner.spoiled(treating.worktreePath)) throw new SpoiledCopyError(treating.worktreePath)
  }

  const task = defineTask<TreatmentInput, TreatmentState, TreatmentResult>({
    name: 'remontnik.treatment',
    version: 1,
    initial: () => ({ phase: 'triage' }),
    phases: {
      triage: async (task, runtime, context) => {
        const { caseId } = task.input
        const sick = await readCase(runtime, caseId, context)
        const config = await deps.loadConfig()
        await deps.guard.fetch()
        const base = (await runtime.memo<Base>('base', context)) ?? (await runtime.memo<Base>('base', await chooseBase(config), context))
        const baseCommit = base.commit
        const workbench = await createWorkbench({
          guard: deps.guard,
          worktreesDir: deps.worktreesDir,
          caseId,
          slug: slugify(sick.message),
          baseCommit,
          closedPaths: config.closedPaths,
        })
        const bashTimeoutSeconds = Math.max(1, Math.ceil(config.workbench.bashTimeoutMs / 1000))
        const instructions = buildSystemPrompt({
          appName: config.app.name,
          ...(deps.appDescription ? { appDescription: deps.appDescription } : {}),
          repoMap: buildRepoMap(await deps.guard.listFiles(baseCommit), { closedPaths: config.closedPaths }),
          closedPaths: config.closedPaths,
          bashTimeoutSeconds,
          base: base.running ? 'running' : 'main',
        })
        const limitUsd = caseLimitUsdOf(config)

        await runtime.commit(async (tx) => {
          const existing = (await tx.scanConversations({ ownerTaskId: task.id }, 1)).items[0]
          const conversationId = existing?.id ?? (await tx.createConversation({ ownership: { kind: 'task', taskId: task.id } })).id
          await configure(tx, conversationId, { model: deps.model, extensions: [extension], instructions, cwd: workbench.path })
          const doc = await tx.doc(TreatmentDoc, conversationId)
          doc.workbench = { root: workbench.path, closedPaths: [...config.closedPaths], bashTimeoutSeconds, maxTimeoutSeconds: bashTimeoutSeconds }
          doc.case = {
            caseId,
            appName: sick.appName,
            kind: sick.kind,
            where: sick.where,
            message: sick.message,
            stack: sick.stack,
            events: sick.events,
            // Выдержка пришла из разговора с пользователем: вычищается ещё раз, сторож приложения мог вычистить хуже.
            ...(sick.badAnswer ? { badAnswer: redactValue(sick.badAnswer, { knownSecrets: knownSecretsOf(config) }) } : {}),
          }
          ;(await caseIn(recordTransactionOver(tx), caseId)).state = 'diagnosing'
          return {
            status: 'running',
            checkpoint: {
              phase: 'diagnosing',
              conversationId,
              baseCommit,
              baseRunning: base.running,
              branch: workbench.branch,
              worktreePath: workbench.path,
              limitUsd,
            },
          }
        }, context)
      },

      diagnosing: async (task, runtime, context) => {
        const { caseId } = task.input
        const treating = task.state.checkpoint
        await backFromDeferral(runtime, caseId, 'diagnosing', context)
        let doc = await treatmentDoc(runtime, treating.conversationId, context)
        let run: { status: ConverseStatus; spentUsd: number } | undefined
        if (!doc.diagnosis) {
          run = await converse(runtime, treating, caseId, 'diagnose', diagnoseMessage(doc.case), context)
          doc = await treatmentDoc(runtime, treating.conversationId, context)
        }
        const diagnosis = doc.diagnosis
        if (!diagnosis && run?.status === 'day_budget') return deferToNextDay(runtime, caseId, treating, 'model', context)
        if (!diagnosis?.found) {
          const reason = run?.status === 'budget' ? run.status : diagnosis ? 'not_found' : 'no_answer'
          const spent = run?.spentUsd ?? spentUsd(await runtime.snapshot(UsageDoc, treating.conversationId, context))
          const text = noCauseFoundReport({ case: doc.case, reason, spentUsd: spent, limitUsd: treating.limitUsd, ...(diagnosis ? { diagnosis } : {}) })
          await finish(runtime, caseId, 'no_cause_found', 'no_cause_found', text, { outcome: 'no_cause_found' }, context, treating.baseRunning)
          return
        }
        const sdkPackage = agentChatSdkPackage(diagnosis)
        if (sdkPackage) {
          const text = agentChatSdkReport({ case: doc.case, stack: doc.case.stack, diagnosis, packageName: sdkPackage })
          await finish(runtime, caseId, 'report_only', 'needs_human', text, { outcome: 'needs_human', why: 'agent_chat_sdk', sdkPackage }, context, treating.baseRunning)
          return
        }
        await runtime.commit(async (tx) => {
          ;(await caseIn(recordTransactionOver(tx), caseId)).state = 'fixing'
          return { status: 'running', checkpoint: { ...treating, phase: 'fixing', diagnosis } }
        }, context)
      },

      fixing: async (task, runtime, context) => {
        const { caseId } = task.input
        const { diagnosis, phase: _phase, ...treating } = task.state.checkpoint
        await backFromDeferral(runtime, caseId, 'fixing', context)
        await stopOnBrokenWorkbench(runtime, caseId, treating, context, async () => {
          // Копия, испорченная ещё при диагнозе, — не работаем в ней дальше; испорченная правкой — не коммитим.
          assertWorkbenchIntact(treating)
          let doc = await treatmentDoc(runtime, treating.conversationId, context)
          let run: { status: ConverseStatus } | undefined
          if (!doc.fix) {
            run = await converse(runtime, treating, caseId, 'fix', fixMessage(diagnosis, doc.case), context)
            doc = await treatmentDoc(runtime, treating.conversationId, context)
          }
          const fix = doc.fix
          if (!fix && run?.status === 'day_budget') return deferToNextDay(runtime, caseId, task.state.checkpoint, 'model', context)
          assertWorkbenchIntact(treating)
          let fixCommit: string | undefined
          if (fix) {
            // Сбой между коммитом и памятью: при повторе коммитить нечего, но коммит правки уже в ветке.
            const made = await deps.guard.commitAll(treating.worktreePath, commitMessage(caseId, fix, diagnosis))
            const head = made ?? (await runtime.memo<string>('fixCommit', context)) ?? (await deps.guard.resolve('HEAD', { cwd: treating.worktreePath }))
            fixCommit = head === treating.baseCommit ? undefined : await runtime.memo('fixCommit', head, context)
          }
          if (!fix || !fixCommit) {
            const reason = fix ? 'no_changes' : run?.status === 'budget' ? run.status : 'no_answer'
            const text = causeFoundReport({ case: doc.case, diagnosis, reason })
            await finish(runtime, caseId, 'report_only', 'cause_found', text, { outcome: 'cause_found' }, context, treating.baseRunning)
            return
          }
          const files = await deps.guard.changedFiles(treating.worktreePath, treating.baseCommit)
          const changedPaths = [...new Set(files.flatMap((file) => (file.previousPath ? [file.path, file.previousPath] : [file.path])))]
          const inspection = inspectFix(await deps.loadConfig(), files, doc.case)
          const fixed = { diagnosis, fix, fixCommit, changedPaths, inspection }
          // Правке нельзя доверить собственную проверку: без проверок и без отправки — сразу к решению.
          const next = fixCanBeChecked(inspection) ? ({ phase: 'verifying', ...fixed } as const) : ({ phase: 'gated', ...fixed, pushed: false } as const)
          await runtime.commit(async (tx) => {
            ;(await caseIn(recordTransactionOver(tx), caseId)).state = next.phase
            return { status: 'running', checkpoint: { ...treating, ...next } }
          }, context)
        })
      },

      verifying: async (task, runtime, context) => {
        const { caseId } = task.input
        const checkpoint = task.state.checkpoint
        await backFromDeferral(runtime, caseId, 'verifying', context)
        const doc = await treatmentDoc(runtime, checkpoint.conversationId, context)
        const config = await deps.loadConfig()

        let checks = (await runtime.memo<JsonValue>('checks', context)) as ChecksResult | undefined
        // Eval не пустили: остаток дня держат чужие брони (`wait`) или денег до конца суток нет (`next_day`).
        let evalHeld: 'wait' | 'next_day' | undefined
        if (!checks && config.checks.eval && selectEvalScenarios({ ...config, maxScenarios: config.checks.eval.maxScenarios }, checkpoint.changedPaths).status !== 'not_needed') {
          // Случай вот-вот попросит eval: другие случаи оставляют ему долю остатка дня.
          await runtime.commit(async (tx) => {
            await joinEvalQueueIn(recordTransactionOver(tx), caseKey(caseId), deps.now())
            return undefined
          }, context)
        }
        if (!checks) await stopOnBrokenWorkbench(runtime, caseId, checkpoint, context, async () => {
          // Проверки идут в своих копиях на закоммиченной правке и на основе: мусор модели в верстаке им не мешает.
          const closed = (await deps.guard.listFiles(checkpoint.baseCommit)).filter((file) => matchesAnyMask(config.closedPaths, file))
          const candidateDir = join(deps.worktreesDir, `case-${caseId}-candidate`)
          const baseDir = join(deps.worktreesDir, `case-${caseId}-base`)
          // Копии проверок всегда заново: после сбоя в старых мог остаться мусор прошлого прогона.
          await deps.guard.addWorktree({ path: candidateDir, base: checkpoint.fixCommit, exclude: closed, fresh: true })
          await deps.guard.addWorktree({ path: baseDir, base: checkpoint.baseCommit, exclude: closed, fresh: true })
          // Бронь — прямо перед запуском eval: открытая бронь всегда закрывается в finally или после перезапуска.
          let reservation: { day: string; id: string } | undefined
          let evalSpend: ReturnType<typeof evalSpendRecorder> | undefined
          let settled = false
          try {
            const result = await createChecks({
              runner: deps.checksRunner,
              config,
              evalEnv: deps.evalEnv,
              ...(deps.evalProxy ? { evalProxy: deps.evalProxy } : {}),
              baseCache: deps.evalBaseCache,
              workDir: deps.checksDir,
              timeoutSeconds: Math.max(1, Math.ceil(config.workbench.bashTimeoutMs / 1000)),
            }).run({
              candidateDir,
              baseDir,
              baseCommit: checkpoint.baseCommit,
              changedPaths: checkpoint.changedPaths,
              // Правку плохого ответа проверяет только eval: без сценариев по карте её нечем проверить.
              evalRequired: doc.case.kind === 'bad_answer',
              reserveEval: async () => {
                const reserved = await reserveEval(runtime, caseId, config, context)
                if (reserved.admission.kind !== 'reserve' || !reserved.id) {
                  evalHeld = reserved.admission.kind === 'reserve' ? undefined : reserved.admission.kind
                  return 0
                }
                reservation = { day: reserved.day, id: reserved.id }
                evalSpend = evalSpendRecorder(runtime, reservation, context)
                return reserved.admission.usd
              },
              onEvalSpend: (spend) => evalSpend!.record(spend),
            })
            if (reservation) {
              await evalSpend!.flush()
              await updateReservation(runtime, reservation, context, (item) => (item.actualUsd = result.eval.costUsd))
            }
            settled = true
            // Не пустили к eval — итог не запоминается: после ожидания проверки идут заново.
            if (!evalHeld) checks = (await runtime.memo('checks', result as unknown as JsonValue, context)) as unknown as ChecksResult
          } finally {
            // Проверка упала: бронь закрывается тем, что досчитал прокси, а не сгорает целиком.
            if (!settled && reservation) {
              const open = reservation
              await evalSpend!.flush()
              await updateReservation(runtime, open, context, (item) => settleEvalWithProxyFact(item, evalSpend!.latest())).catch((error: unknown) => runtime.report(error))
            }
            await deps.guard.removeWorktree(candidateDir).catch(() => {})
            await deps.guard.removeWorktree(baseDir).catch(() => {})
            if (!evalHeld) {
              await runtime.commit(async (tx) => {
                await leaveEvalQueueIn(recordTransactionOver(tx), caseKey(caseId))
                return undefined
              }, context).catch((error: unknown) => runtime.report(error))
            }
          }
        })
        if (evalHeld === 'next_day') return deferToNextDay(runtime, caseId, checkpoint, 'eval', context)
        // Случай остаётся в очереди eval со свежей отметкой и спрашивает снова.
        if (evalHeld === 'wait') return runtime.sleepUntil(deps.now() + EVAL_WAIT_MS, checkpoint, context)
        // Копия проверки испорчена: отчёт уже записан.
        if (!checks) return

        let pushed = true
        try {
          await deps.guard.push(checkpoint.branch)
        } catch (error) {
          pushed = false
          runtime.report(error)
        }

        await runtime.commit(async (tx) => {
          ;(await caseIn(recordTransactionOver(tx), caseId)).state = 'gated'
          return { status: 'running', checkpoint: { ...checkpoint, phase: 'gated', checks, pushed } }
        }, context)
      },

      gated: async (task, runtime, context) => {
        const { caseId } = task.input
        const checkpoint = task.state.checkpoint
        const { checks, diagnosis, fix, inspection } = checkpoint
        const doc = await treatmentDoc(runtime, checkpoint.conversationId, context)
        const config = await deps.loadConfig()
        const sick = await readCase(runtime, caseId, context)
        const spendDay = (await runtime.snapshot(recordFamilyOf('spend'), spendDayKey(deps.now(), config.app.timeZone), context)) as unknown as SpendDay | undefined
        const controls = deps.deployControls ? await deps.deployControls.read({ caseId, fingerprint: sick.fingerprint, config }) : noDeployControls()
        const ledger = (await runtime.snapshot(recordFamilyOf(LEDGER.collection), LEDGER.key, context)) as unknown as FingerprintLedger | undefined
        const attempts = deployAttemptsOf(ledger, { fingerprint: sick.fingerprint, now: deps.now(), timeZone: config.app.timeZone, limits: config.limits })
        const gate = decideDeploy(deployFactsOf({ inspection, checks, controls, attempts, spendDay: spendDay ?? emptySpendDay(), limits: config.limits }))
        const closing = closingOf(gate, checks)
        const sdkPackage = agentChatSdkPackage(diagnosis, inspection)
        const result = {
          branch: checkpoint.branch,
          fixCommit: checkpoint.fixCommit,
          changedPaths: checkpoint.changedPaths,
          ...(checks ? { checks } : {}),
          gate,
          ...(sdkPackage ? { sdkPackage } : {}),
        }
        const ready = { case: doc.case, diagnosis, fix, branch: checkpoint.branch, commit: checkpoint.fixCommit, pushed: checkpoint.pushed }
        const sdkTask = sdkPackage ? agentChatSdkTask({ case: doc.case, stack: doc.case.stack, diagnosis, packageName: sdkPackage }) : undefined
        const close = (text: ReportText, outcome: Omit<TreatmentResult, 'reportId'>) =>
          finish(runtime, caseId, closing.caseState, closing.report, text, { ...result, ...outcome }, context, checkpoint.baseRunning)
        switch (closing.kind) {
          case 'deploy':
            // Этап 6 подключает здесь выкатку; пока решение `deploy` закрывается отчётом «правка готова».
            // Перед выкаткой решение надо зафиксировать в чекпойнте: при повторе фазы оно сейчас считается заново.
            return close(fixReadyReport({ ...ready, checks: checks! }), { outcome: 'fix_ready' })
          case 'not_deployed':
            return close(gateReport({ ...ready, ...(checks ? { checks } : {}), decision: gate }), { outcome: 'fix_ready' })
          case 'checks_red':
            return close(causeFoundReport({ case: doc.case, diagnosis, reason: 'checks_red', branch: checkpoint.branch, checks: checks! }), { outcome: 'cause_found' })
          case 'stand_broken':
            return close(standBrokenReport({ case: doc.case, branch: checkpoint.branch, checks: checks! }), { outcome: 'stand_broken' })
          case 'needs_human':
            return close(gateReport({ ...ready, ...(checks ? { checks } : {}), decision: gate, ...(sdkTask ? { sdkTask } : {}) }), {
              outcome: 'needs_human',
              why: sdkPackage ? 'agent_chat_sdk' : 'gate',
            })
        }
      },
    },
    abort: (_task, runtime, context) => runtime.commit(() => ({ status: 'terminal', outcome: { status: 'aborted' } }), context),
  })

  /**
   * Потолок расходов перед каждым запросом к модели. Хук не может отменить запрос, поэтому держит его, будит сверку
   * расходов, и та останавливает разговор; потолок отпустил (новые сутки) — запрос уходит.
   */
  const budgetHook = hook(GenerationTask, {
    beforeRequest: async (request, api, context) => {
      const doc = await api.snapshot(TreatmentDoc, api.conversationId, context)
      if (!doc?.case) return undefined
      const signal = (api as { signal?: AbortSignal }).signal ?? context.abortSignal
      while (await modelBlockOf(api, api.conversationId, doc.case.caseId, context)) {
        budgetWatchers.get(api.conversationId)?.()
        if (signal?.aborted) throw new Error('разговор остановлен на потолке расходов')
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, BUDGET_HOLD_RECHECK_MS)
          signal?.addEventListener('abort', () => {
            clearTimeout(timer)
            resolve()
          }, { once: true })
        })
        if (signal?.aborted) throw new Error('разговор остановлен на потолке расходов')
      }
      return undefined
    },
  })

  const extension: Extension = defineExtension({
    name: 'remontnik.doctor',
    tools: [...doctorTools()],
    hooks: [doctorToolGuard, budgetHook],
    tasks: [task],
  })

  return {
    extension,
    async startIn(records, opened) {
      const tx = durableTxOf(records)
      if (!tx) throw new Error('лечение запускается только в транзакции записей на pi-durable')
      const conversation = await tx.createConversation({ ownership: { kind: 'ownerless' } })
      const taskId = await tx.createTask(task, { caseId: opened.caseId }, { ownership: { kind: 'conversation' }, conversationId: conversation.id, background: true })
      opened.treatmentTaskId = String(taskId)
      opened.state = 'triage'
    },
  }
}

/** Кэш итогов eval основы в записях врача: переживает перезапуск. */
export function createRecordEvalBaseCache(records: RecordStore): EvalBaseCache {
  const key = (commit: string, scenario: string) => `${commit}:${scenario}`
  return {
    async get(commit, scenario) {
      const stored = await records.read<{ result?: unknown }>('eval-base', key(commit, scenario))
      return stored?.result as Awaited<ReturnType<EvalBaseCache['get']>>
    },
    async set(commit, scenario, result) {
      await records.transaction(async (tx) => {
        ;(await tx.doc<{ result?: unknown }>('eval-base', key(commit, scenario), {})).result = result
      })
    },
  }
}
