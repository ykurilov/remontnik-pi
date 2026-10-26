import { join } from 'node:path'
import type { JsonValue } from '@earendil-works/chord'
import type { Context } from '@earendil-works/chord/context'
import {
  configure,
  defineExtension,
  defineTask,
  UsageDoc,
  type ConversationId,
  type Extension,
  type TaskRuntime,
  type UsageState,
} from '@earendil-works/pi-durable'
import type { RemontnikConfig } from '@ykurilov/remontnik-core/config'
import { redactSecrets, redactValue } from '@ykurilov/remontnik-core/redact'
import { setCaseStateIn, type Case, type CaseState } from '../case-book/index.js'
import type { CaseServices } from '../case-services/index.js'
import { createChecks, type ChecksResult, type EvalBaseCache } from '../checks/index.js'
import type { EvalProxy, EvalSpend } from '../eval-proxy/index.js'
import { decideDeploy, type GateDecision } from '../deploy-gate/index.js'
import type { Deployer, DeployRequest, Deployment, DeployStep } from '../deployer/deploy-sequence.js'
import { GitGuardError, slugify, type GitGuard, type GitGuardErrorCode } from '../git-guard/index.js'
import { CONTROLS, type DeployControls as DeployControlsState } from '../ledgers/controls.js'
import { diagnoseMessage, fixMessage } from '../model/case-messages.js'
import { buildRepoMap, buildSystemPrompt } from '../model/system-prompt.js'
import { matchesAnyMask } from '../path-mask/index.js'
import type { RecordStore, RecordTransaction } from '../records/index.js'
import type { ReportType, Reports } from '../reports/index.js'
import { agentChatSdkReport, agentChatSdkTask, gateReport } from '../reports/gate-texts.js'
import {
  causeFoundReport,
  deploymentReport,
  fixReadyReport,
  needsHumanReport,
  noCauseFoundReport,
  standBrokenReport,
  type MainlineResult,
  type ReportText,
} from '../reports/texts.js'
import { durableTxOf, recordFamilyOf, recordTransactionOver, runDeploymentInTask } from '../service/harness.js'
import { createWorkbench, SpoiledCopyError, type CommandRunner } from '../workbench/index.js'
import { TreatmentDoc, type Diagnosis, type FixSummary, type TreatmentDocState } from './doc.js'
import { agentChatSdkPackage, closingOf, deployFactsOf, fixCanBeChecked, inspectFix, noDeploysYet, type DeployControls, type FixInspection } from './gate.js'
import {
  closeInterruptedEval,
  emptySpendDay,
  evalCaseBudgetUsd,
  modelSpentUsd,
  recordEvalObserved,
  settleEvalWithProxyFact,
  spendDayKey,
  type CaseSpend,
  type EvalReservation,
  type SpendDay,
} from './spend.js'
import { doctorToolGuard, doctorTools } from './tools.js'

// Задача лечения `remontnik.treatment` (R1). Фазы — чекпойнты pi-durable: перезапуск врача продолжает
// с последней сохранённой фазы, а фаза после перезапуска выполняется заново с начала, поэтому каждая
// идемпотентна: копия переиспользуется, запрос модели находится по `requestId`, итог модели лежит в документе.
//
//   triage → diagnosing → fixing → verifying → gated → deploying → observing → healed | rolled_back | not_helped
//
// Решение `gated` о выкатке фиксируется в чекпойнте `deploying`: после перезапуска оно не считается заново.
// Выкатку ведёт выкатчик (`runDeploymentInTask`), его отчёты (долгий замок, `.stale-*`, брошенная выкатка)
// отправляются после каждого шага. Правка, оставшаяся работать после окна наблюдения, сливается в основную ветку
// через git-замок (`repo.mainline: merge`, только вперёд) или ждёт запроса на слияние (`pull-request`).
// Без выкатчика решение `deploy` закрывается отчётом «правка готова».
//
// Основа — рабочая версия (`deploy.commands.current`); неизвестна — последний коммит основной ветки, и отчёт это говорит.
// Выкатывать или нет, решает только фаза `gated` (`decideDeploy` по фактам из `gate.ts`). Правка, которая задевает
// защищённые пути (тесты, eval, зависимости, сборку, Ремонтника) или похожа на подделку проверки, идёт в `gated`
// без проверок и не отправляется. Причина в Agent Chat SDK — правки нет, отчёт с задачей для агента SDK.
// Подменённая копия (git-замок: `escape`) — попытка выхода из верстака: случай останавливается.
// Расход модели и eval пишется в дневной учёт (`spend.ts`) по ходу работы.
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
}

export type TreatmentState =
  | { phase: 'triage' }
  | ({ phase: 'diagnosing' } & Treating)
  | ({ phase: 'fixing'; diagnosis: Diagnosis } & Treating)
  | ({ phase: 'verifying' } & Fixed & Treating)
  | ({ phase: 'gated' } & Gated)
  | ({ phase: 'deploying'; gate: GateDecision } & Gated)
  | ({ phase: 'observing'; gate: GateDecision } & Gated)

/** Закоммиченная правка и осмотр её диффа. */
type Fixed = { diagnosis: Diagnosis; fix: FixSummary; fixCommit: string; changedPaths: string[]; inspection: FixInspection }
/** Правка проверена (или проверять её нельзя) и, может быть, отправлена в origin. */
type Gated = { checks?: ChecksResult; pushed: boolean } & Fixed & Treating

export type TreatmentOutcome = 'fix_ready' | 'cause_found' | 'no_cause_found' | 'stand_broken' | 'needs_human' | 'healed' | 'rolled_back' | 'not_helped'

export type TreatmentResult = {
  outcome: TreatmentOutcome
  /** Почему нужен человек. */
  why?: 'escape' | 'spoiled' | 'agent_chat_sdk' | 'gate' | 'deploy'
  reportId: number
  /** Решение фазы `gated`. */
  gate?: GateDecision
  /** Пакет Agent Chat SDK, в котором причина. */
  sdkPackage?: string
  branch?: string
  fixCommit?: string
  changedPaths?: string[]
  checks?: ChecksResult
  deploymentId?: number
  /** Что стало с веткой правки, которая осталась работать. */
  mainline?: MainlineResult
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
  /** Службы для тестов (`checks.services`). */
  checksServices?: Pick<CaseServices, 'up'>
  evalBaseCache: EvalBaseCache
  /** Стоп-кран, учёт выкаток, перенос на свежий main. Нет — выкаток ещё не было (`noDeploysYet`). */
  deployControls?: DeployControls
  /** Выкатчик приложения. Нет — решение `deploy` закрывается отчётом «правка готова». */
  deployer?: Deployer
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
type ConverseStatus = 'answered' | 'failed' | 'budget' | 'day_budget'
type Base = { commit: string; running: boolean }
type DeployPhase = Extract<TreatmentState, { phase: 'deploying' | 'observing' }>
type DeploySleep = Extract<DeployStep, { kind: 'sleep' }>

/** Почему не удалось влить правку — для отчёта человеку, без текста git. */
const MERGE_FAILURES: Record<GitGuardErrorCode, string> = {
  diverged: 'основная ветка ушла вперёд',
  failed: 'origin отказал',
  timeout: 'origin не ответил вовремя',
  forbidden: 'git-замок не разрешил',
  escape: 'git-замок не разрешил',
}
const BASE_UNKNOWN_NOTE = 'Заметка: основа — main, рабочая версия неизвестна.'
const COMMIT_SHA = /^[0-9a-f]{7,64}$/i

function spentUsd(usage: UsageState | undefined): number {
  if (!usage) return 0
  return [...Object.values(usage.models), ...Object.values(usage.tools)].reduce((sum, item) => sum + (item.cost?.total ?? 0), 0)
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
  async function redactedReport(text: ReportText, baseRunning: boolean): Promise<{ short: string; full: string }> {
    const knownSecrets = knownSecretsOf(await deps.loadConfig())
    return {
      short: redactSecrets(text.short, { knownSecrets }),
      full: redactSecrets(baseRunning ? text.full : `${text.full}\n${BASE_UNKNOWN_NOTE}`, { knownSecrets }),
    }
  }

  /** Отчёт и состояние случая внутри фиксации задачи. */
  async function reportIn(records: RecordTransaction, caseId: number, state: CaseState, type: ReportType, text: { short: string; full: string }): Promise<number> {
    const opened = await setCaseStateIn(records, caseId, state)
    const report = await deps.reports.addIn(records, { type, caseId, ...text, telegram: 'pending' })
    opened.reportIds.push(report.reportId)
    return report.reportId
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
    const redacted = await redactedReport(text, baseRunning)
    await runtime.commit(async (tx) => {
      const reportId = await reportIn(recordTransactionOver(tx), caseId, state, type, redacted)
      return { status: 'terminal', outcome: { status: 'completed', result: { ...result, reportId } } }
    }, context)
    deps.onReport()
  }

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
   */
  async function converse(
    runtime: Runtime,
    treating: Treating,
    caseId: number,
    requestId: string,
    content: string,
    context: Context,
  ): Promise<{ status: ConverseStatus; spentUsd: number }> {
    const config = await deps.loadConfig()
    const spent = async () => spentUsd(await runtime.snapshot(UsageDoc, treating.conversationId, context))
    const overLimit = async (): Promise<'budget' | 'day_budget' | undefined> => {
      const total = await spent()
      const today = await recordModelSpend(runtime, caseId, total, config.app.timeZone, context)
      if (total >= treating.limitUsd) return 'budget'
      return today >= config.limits.modelUsdPerDay ? 'day_budget' : undefined
    }
    const before = await overLimit()
    if (before) return { status: before, spentUsd: await spent() }
    const handle = await runtime.conversation(treating.conversationId, context)
    if (!handle) throw new Error('разговор модели пропал')
    const submission = await handle.submit({ type: 'input', content, requestId }, context)

    let settled = false
    let stopped: 'budget' | 'day_budget' | undefined
    const watcher = (async () => {
      while (!settled && !runtime.signal.aborted) {
        await new Promise<void>((resolve) => runtime.setTimer(resolve, deps.budgetPollMs))
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
      await watcher
      const total = await spent()
      await recordModelSpend(runtime, caseId, total, config.app.timeZone, context)
      if (stopped) return { status: stopped, spentUsd: total }
      return { status: record.status === 'done' ? 'answered' : 'failed', spentUsd: total }
    } finally {
      settled = true
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

  /** Бронь eval: доля случая, не больше остатка дня. Брони прогонов, прерванных перезапуском, закрываются фактом прокси. */
  async function reserveEval(runtime: Runtime, caseId: number, config: RemontnikConfig, context: Context): Promise<{ day: string; id: string; budgetUsd: number }> {
    const dayKey = spendDayKey(deps.now(), config.app.timeZone)
    let reservation = { day: dayKey, id: '', budgetUsd: 0 }
    await runtime.commit(async (tx) => {
      const day = await recordTransactionOver(tx).doc<SpendDay>('spend', dayKey, emptySpendDay())
      let attempt = 0
      while (day.eval[`case-${caseId}-${attempt}`]) {
        closeInterruptedEval(day.eval[`case-${caseId}-${attempt}`]!)
        attempt += 1
      }
      const id = `case-${caseId}-${attempt}`
      const budgetUsd = evalCaseBudgetUsd(day, config.limits)
      day.eval[id] = { reservedUsd: budgetUsd }
      reservation = { day: dayKey, id, budgetUsd }
      return undefined
    }, context)
    return reservation
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

  /**
   * Правка осталась работать — ветка уходит в основную: `merge` — git-замком, проверенной ревизией и только вперёд,
   * `pull-request` — ждёт запроса на слияние. Стоп-кран, нажатый за окно, слияние останавливает: правка ждёт человека.
   * Повтор после перезапуска безопасен: правку, уже лежащую в основной ветке, git-замок не отправляет второй раз.
   */
  async function settleMainline(runtime: Runtime, checkpoint: DeployPhase, context: Context): Promise<MainlineResult> {
    const config = await deps.loadConfig()
    const { branch } = checkpoint
    const controls = (await runtime.snapshot(recordFamilyOf(CONTROLS.collection), CONTROLS.key, context)) as unknown as DeployControlsState | undefined
    try {
      if (!checkpoint.pushed) await deps.guard.push(branch)
      if (config.repo.mainline !== 'merge') return { kind: 'pull_request', branch }
      if (controls?.autoDeploy === 'stopped') return { kind: 'stopped', branch }
      await deps.guard.mergeIntoMain(branch, checkpoint.fixCommit)
      return { kind: 'merged', into: config.repo.mainBranch }
    } catch (error) {
      if (!(error instanceof GitGuardError)) throw error
      // Текст git (в нём адрес origin) — только в журнал; в отчёт — причина по коду ошибки.
      runtime.report(error)
      return { kind: 'merge_failed', branch, reason: MERGE_FAILURES[error.code] }
    }
  }

  /** Итог выкатки: состояние случая и итог задачи по записи выкатки и типу её отчёта. */
  function deployClosing(deployment: Deployment, report: ReportType): { state: CaseState; outcome: TreatmentOutcome; why?: 'deploy' } {
    if (report === 'needs_human') return { state: 'needs_human', outcome: 'needs_human', why: 'deploy' }
    switch (deployment.outcome) {
      case 'holding':
        return { state: 'healed', outcome: 'healed' }
      case 'not_helped':
        return { state: 'not_helped', outcome: 'not_helped' }
      case 'rolled_back':
        return { state: 'rolled_back', outcome: 'rolled_back' }
      case 'refused':
        // Стоп-кран: правка готова, выкатит её человек.
        return { state: 'report_only', outcome: 'fix_ready' }
      default:
        return { state: 'needs_human', outcome: 'needs_human', why: 'deploy' }
    }
  }

  /**
   * Фазы `deploying` и `observing`: шаг выкатки. Пока выкатка ждёт замок, задача спит в `deploying`; когда правка
   * выкачена, одной фиксацией — случай `observing`, отчёт «выкатил, наблюдаю» и чекпойнт `observing`.
   * Конец выкатки закрывает случай её отчётом.
   */
  async function deployStep(runtime: Runtime, caseId: number, checkpoint: DeployPhase, deployer: Deployer, context: Context): Promise<void> {
    const sick = await readCase(runtime, caseId, context)
    const candidateDir = join(deps.worktreesDir, `case-${caseId}-deploy`)
    // Копия правки нужна только для сборки: в наблюдении её уже нет.
    if (checkpoint.phase === 'deploying') await deps.guard.addWorktree({ path: candidateDir, base: checkpoint.fixCommit })
    const request: DeployRequest = { caseId, appName: sick.appName, fingerprint: sick.fingerprint, candidateVersion: checkpoint.fixCommit, candidateDir }
    const sleepsHere = (step: DeploySleep) => (checkpoint.phase === 'observing' || step.stage === 'waiting_lock' ? checkpoint : undefined)
    let step: DeployStep
    try {
      step = await runDeploymentInTask(runtime, deployer, request, sleepsHere, context)
    } finally {
      // Отчёты выкатчика (долгий замок, `.stale-*`, брошенная чужая выкатка) записаны его фиксациями.
      deps.onReport()
    }
    if (step.kind === 'sleep' && sleepsHere(step)) return

    const doc = await treatmentDoc(runtime, checkpoint.conversationId, context)
    const { deployment } = step
    if (step.kind === 'sleep') {
      await deps.guard.removeWorktree(candidateDir).catch(() => {})
      const deployed = step.stage === 'observing' ? await redactedReport(deploymentReport({ case: doc.case, deployment }), checkpoint.baseRunning) : undefined
      await runtime.commit(async (tx) => {
        const records = recordTransactionOver(tx)
        if (deployed) await reportIn(records, caseId, 'observing', 'deployed', deployed)
        else await setCaseStateIn(records, caseId, 'observing')
        return { status: 'running', checkpoint: { ...checkpoint, phase: 'observing' } }
      }, context)
      if (deployed) deps.onReport()
      return
    }

    await deps.guard.removeWorktree(candidateDir).catch(() => {})
    const stays = deployment.outcome === 'holding' || deployment.outcome === 'not_helped'
    const mainline = stays ? await settleMainline(runtime, checkpoint, context) : undefined
    const text = deploymentReport({ case: doc.case, deployment, branch: checkpoint.branch, ...(mainline ? { mainline } : {}) })
    const closing = deployClosing(deployment, text.type)
    await finish(
      runtime,
      caseId,
      closing.state,
      text.type,
      text,
      {
        outcome: closing.outcome,
        ...(closing.why ? { why: closing.why } : {}),
        branch: checkpoint.branch,
        fixCommit: checkpoint.fixCommit,
        changedPaths: checkpoint.changedPaths,
        ...(checkpoint.checks ? { checks: checkpoint.checks } : {}),
        gate: checkpoint.gate,
        deploymentId: deployment.deploymentId,
        ...(mainline ? { mainline } : {}),
      },
      context,
      checkpoint.baseRunning,
    )
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
        const limitUsd = config.limits.diagnoseUsdPerCase ?? config.limits.modelUsdPerDay

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
        let doc = await treatmentDoc(runtime, treating.conversationId, context)
        let run: { status: ConverseStatus; spentUsd: number } | undefined
        if (!doc.diagnosis) {
          run = await converse(runtime, treating, caseId, `diagnose:${caseId}`, diagnoseMessage(doc.case), context)
          doc = await treatmentDoc(runtime, treating.conversationId, context)
        }
        const diagnosis = doc.diagnosis
        if (!diagnosis?.found) {
          const reason = run?.status === 'budget' || run?.status === 'day_budget' ? run.status : diagnosis ? 'not_found' : 'no_answer'
          const spent = run?.spentUsd ?? spentUsd(await runtime.snapshot(UsageDoc, treating.conversationId, context))
          const limitUsd = reason === 'day_budget' ? (await deps.loadConfig()).limits.modelUsdPerDay : treating.limitUsd
          const text = noCauseFoundReport({ case: doc.case, reason, spentUsd: spent, limitUsd, ...(diagnosis ? { diagnosis } : {}) })
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
        await stopOnBrokenWorkbench(runtime, caseId, treating, context, async () => {
          // Копия, испорченная ещё при диагнозе, — не работаем в ней дальше; испорченная правкой — не коммитим.
          assertWorkbenchIntact(treating)
          let doc = await treatmentDoc(runtime, treating.conversationId, context)
          let run: { status: ConverseStatus } | undefined
          if (!doc.fix) {
            run = await converse(runtime, treating, caseId, `fix:${caseId}`, fixMessage(diagnosis, doc.case), context)
            doc = await treatmentDoc(runtime, treating.conversationId, context)
          }
          const fix = doc.fix
          assertWorkbenchIntact(treating)
          let fixCommit: string | undefined
          if (fix) {
            // Сбой между коммитом и памятью: при повторе коммитить нечего, но коммит правки уже в ветке.
            const made = await deps.guard.commitAll(treating.worktreePath, commitMessage(caseId, fix, diagnosis))
            const head = made ?? (await runtime.memo<string>('fixCommit', context)) ?? (await deps.guard.resolve('HEAD', { cwd: treating.worktreePath }))
            fixCommit = head === treating.baseCommit ? undefined : await runtime.memo('fixCommit', head, context)
          }
          if (!fix || !fixCommit) {
            const reason = fix ? 'no_changes' : run?.status === 'budget' || run?.status === 'day_budget' ? run.status : 'no_answer'
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
        const doc = await treatmentDoc(runtime, checkpoint.conversationId, context)
        const config = await deps.loadConfig()

        let checks = (await runtime.memo<JsonValue>('checks', context)) as ChecksResult | undefined
        if (!checks) await stopOnBrokenWorkbench(runtime, caseId, checkpoint, context, async () => {
          // Проверки идут в своих копиях на закоммиченной правке и на основе: мусор модели в верстаке им не мешает.
          const closed = (await deps.guard.listFiles(checkpoint.baseCommit)).filter((file) => matchesAnyMask(config.closedPaths, file))
          const candidateDir = join(deps.worktreesDir, `case-${caseId}-candidate`)
          const baseDir = join(deps.worktreesDir, `case-${caseId}-base`)
          // Копии проверок всегда заново: после сбоя в старых мог остаться мусор прошлого прогона.
          await deps.guard.addWorktree({ path: candidateDir, base: checkpoint.fixCommit, exclude: closed, fresh: true })
          await deps.guard.addWorktree({ path: baseDir, base: checkpoint.baseCommit, exclude: closed, fresh: true })
          // Бронь — прямо перед запуском eval: открытая бронь всегда закрывается в finally или после перезапуска.
          let reservation: { day: string; id: string; budgetUsd: number } | undefined
          let evalSpend: ReturnType<typeof evalSpendRecorder> | undefined
          let settled = false
          try {
            const result = await createChecks({
              runner: deps.checksRunner,
              config,
              evalEnv: deps.evalEnv,
              ...(deps.evalProxy ? { evalProxy: deps.evalProxy } : {}),
              ...(deps.checksServices ? { services: deps.checksServices } : {}),
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
                reservation = await reserveEval(runtime, caseId, config, context)
                evalSpend = evalSpendRecorder(runtime, reservation, context)
                return reservation.budgetUsd
              },
              onEvalSpend: (spend) => evalSpend!.record(spend),
            })
            if (reservation) {
              await evalSpend!.flush()
              await updateReservation(runtime, reservation, context, (item) => (item.actualUsd = result.eval.costUsd))
            }
            settled = true
            checks = (await runtime.memo('checks', result as unknown as JsonValue, context)) as unknown as ChecksResult
          } finally {
            // Проверка упала: бронь закрывается тем, что досчитал прокси, а не сгорает целиком.
            if (!settled && reservation) {
              const open = reservation
              await evalSpend!.flush()
              await updateReservation(runtime, open, context, (item) => settleEvalWithProxyFact(item, evalSpend!.latest())).catch((error: unknown) => runtime.report(error))
            }
            await deps.guard.removeWorktree(candidateDir).catch(() => {})
            await deps.guard.removeWorktree(baseDir).catch(() => {})
          }
        })
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
        const controls = deps.deployControls ? await deps.deployControls.read({ caseId, fingerprint: sick.fingerprint, config }) : noDeploysYet(config)
        const gate = decideDeploy(deployFactsOf({ inspection, checks, controls, spendDay: spendDay ?? emptySpendDay(), limits: config.limits }))
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
            if (!deps.deployer) return close(fixReadyReport({ ...ready, checks: checks! }), { outcome: 'fix_ready' })
            // Решение — в чекпойнте: повтор фазы после перезапуска его уже не пересчитывает.
            await runtime.commit(async (tx) => {
              await setCaseStateIn(recordTransactionOver(tx), caseId, 'deploying')
              return { status: 'running', checkpoint: { ...checkpoint, phase: 'deploying', gate } }
            }, context)
            return
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

      deploying: async (task, runtime, context) => {
        if (!deps.deployer) throw new Error('выкатка начата, а выкатчика у врача нет')
        await deployStep(runtime, task.input.caseId, task.state.checkpoint, deps.deployer, context)
      },

      observing: async (task, runtime, context) => {
        if (!deps.deployer) throw new Error('выкатка начата, а выкатчика у врача нет')
        await deployStep(runtime, task.input.caseId, task.state.checkpoint, deps.deployer, context)
      },
    },
    abort: (_task, runtime, context) => runtime.commit(() => ({ status: 'terminal', outcome: { status: 'aborted' } }), context),
  })

  const extension: Extension = defineExtension({
    name: 'remontnik.doctor',
    tools: [...doctorTools()],
    hooks: [doctorToolGuard],
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
