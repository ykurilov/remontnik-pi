import { checkPages, createBrowserTools, takeCaseScreenshotsIn, withPageCheck, type BrowserClient, type PageCheck } from '../browser-tools/index.js'
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
  type Extension,
  type TaskId,
  type TaskRuntime,
  type UsageState,
} from '@earendil-works/pi-durable'
import type { RemontnikConfig } from '@ykurilov/remontnik-core/config'
import { newEventId } from '@ykurilov/remontnik-core/incident'
import { redactSecrets, redactValue } from '@ykurilov/remontnik-core/redact'
import { setCaseStateIn, type Case, type CaseState } from '../case-book/index.js'
import type { CaseServices } from '../case-services/index.js'
import { createChecks, selectEvalScenarios, type ChecksResult, type EvalBaseCache } from '../checks/index.js'
import type { EvalProxy, EvalSpend } from '../eval-proxy/index.js'
import { ATTEMPT_REFUSALS, decideDeploy, type GateDecision } from '../deploy-gate/index.js'
import { deploymentIdIn, type Deployer, type DeployRequest, type Deployment, type DeployStep } from '../deployer/deploy-sequence.js'
import { GIT_GUARD_REASONS, GitGuardError, slugify, type GitGuard } from '../git-guard/index.js'
import {
  agentDeadlineOf,
  agentDeployWindow,
  agentStep,
  BRIDGE_SILENCE_MS,
  CANCEL_REASONS,
  cancelPending,
  HANDOFF_COLLECTION,
  HANDOFF_POLL_MS,
  handoffKey,
  handoffTaskBody,
  reclaimHandoff,
  unadoptedDeploy,
  type AgentWaitPhase,
  type Handoff,
  type HandoffResult,
  type PaseoBridgeClient,
  type ReclaimReason,
} from '../handoff/index.js'
import { CONTROLS, type DeployControls as DeployControlsState } from '../ledgers/controls.js'
import { diagnoseMessage, fixMessage, resumeMessage } from '../model/case-messages.js'
import { buildRepoMap, buildSystemPrompt } from '../model/system-prompt.js'
import { matchesAnyMask } from '../path-mask/index.js'
import type { RecordStore, RecordTransaction } from '../records/index.js'
import type { ReportType, Reports } from '../reports/index.js'
import { budgetDeferredReport } from '../reports/budget-texts.js'
import { agentChatSdkReport, agentChatSdkTask, gateReport } from '../reports/gate-texts.js'
import {
  causeFoundReport,
  deploymentReport,
  fixReadyReport,
  needsHumanReport,
  handedOffReport,
  noCauseFoundReport,
  paseoDeploymentReport,
  paseoDoneReport,
  PASEO_UNAVAILABLE_NOTE,
  reclaimedReport,
  standBrokenReport,
  type MainlineResult,
  type ReportText,
} from '../reports/texts.js'
import { durableTxOf, recordFamilyOf, recordTransactionOver, runDeploymentInTask } from '../service/harness.js'
import { createWorkbench, SpoiledCopyError, workbenchPath, type CommandRunner } from '../workbench/index.js'
import { TreatmentDoc, type Diagnosis, type FixSummary, type TreatmentDocState } from './doc.js'
import {
  agentChatSdkPackage,
  closingOf,
  deployFactsOf,
  fixCanBeChecked,
  inspectFix,
  noDeployControls,
  type DeployControls,
  type FixInspection,
  type GateClosing,
} from './gate.js'
import { admitAutoDeployIn, deployAttemptsOf, emptyFingerprintLedger, LEDGER, recordRollbackIn, refundAutoDeployIn, type FingerprintLedger } from '../ledgers/fingerprint-ledger.js'
import type { ModelBudget } from '../ledgers/model-budget.js'
import {
  caseLimitUsdOf,
  closeCaseEvalIn,
  emptySpendDay,
  evalSpentUsd,
  joinEvalQueueIn,
  leaveEvalQueueIn,
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
// Каждый запрос модели бронирует наибольшую цену до отправки (`ledgers/model-budget.ts`); денег на бронь нет —
// запрос не уходит, ход разговора кончается отказом. Отказ по дню — случай `deferred_budget`: задача спит до начала
// следующих суток (с запасом в минуту) и продолжает тот же этап (модели — просьба продолжить). Отказ по случаю — отчёт.
// Плохой ответ бота (`bad_answer`) лечится так же: выдержка разговора идёт модели вычищенной и помеченной как данные,
// правку проверяет eval по карте `evalScope`; карта не даёт сценариев — eval «не запускался», и выкатки нет.
//
// Модель работает в отдельном разговоре, которым владеет задача: системный промпт и набор инструментов
// постоянны для основы, сведения о случае — в сообщениях.
//
// Режим «сначала Paseo» (`handoff.mode: paseo-first`, R18): до своего лечения врач отдаёт случай агенту Paseo.
//
//   handoff_check → handed_off → paseo_working → healed_by_paseo | paseo_observing → …
//
// Мост не ответил — врач лечит сам, отчёты говорят «Paseo недоступен». Агент не взял случай, не уложился, не смог или
// мост пропал — врач забирает случай (`reclaimed`), отменяет задачу агента и лечит сам с `triage`. Выкатку агента
// врач наблюдает своим выкатчиком (`adopt`) и откатывает, если стало хуже. Поздняя выкатка агента — после `reclaimed` —
// тоже не остаётся без присмотра: врач бросает своё лечение (правит случай только один) или, если лечение уже
// кончилось, начинает новую попытку только для наблюдения.

/** Вид задачи лечения в pi-durable: по нему отчёт о её сбое находит случай. */
export const TREATMENT_TASK_NAME = 'remontnik.treatment'

/**
 * `attempt` — номер попытки лечения случая: новая после `case <id> retry` упавшей задачи, со своей копией и веткой.
 * `adopt` — попытка только наблюдает позднюю выкатку агента Paseo: версия и когда агент о ней сообщил.
 */
export type TreatmentInput = { caseId: number; attempt?: number; adopt?: PaseoDeploy }

/** `caseSince` нет у наблюдений, начатых до него: тогда сбой случая — тоже с `since`. */
type PaseoDeploy = { version: string; since: number; caseSince?: number }

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
  /** Сутки последнего переноса: второй перенос в те же сутки идёт без нового отчёта. */
  deferredDay?: string
}

export type TreatmentState =
  | { phase: 'triage' }
  | { phase: 'handoff_check' }
  /** С какой проверки мост молчит, пока агент работает. */
  | { phase: AgentWaitPhase; bridgeDownSince?: number }
  | ({ phase: 'paseo_observing' } & PaseoDeploy)
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

export type TreatmentOutcome =
  | 'fix_ready'
  | 'cause_found'
  | 'no_cause_found'
  | 'stand_broken'
  | 'needs_human'
  | 'healed'
  | 'healed_by_paseo'
  | 'rolled_back'
  | 'not_helped'

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
  /** Стоп-кран и перенос на свежий main. Нет — выкатки ещё нет (`noDeployControls`). Попытки — из учёта по отпечатку. */
  deployControls?: DeployControls
  /** Выкатчик приложения. Нет — решение `deploy` закрывается отчётом «правка готова». */
  deployer?: Deployer
  appDescription?: string
  /** Бронь запросов модели: хук привязывает запрос к случаю. */
  modelBudget: Pick<ModelBudget, 'bind'>
  /** Запуск врача: брони eval мёртвого запуска закрываются. */
  boot: string
  /** Новый отчёт записан: пора отправлять. */
  onReport(): void
  /** Служба браузера врача (`REMONTNIK_BROWSER_*`) и окружение для ссылки на живой экран. Нет — браузера нет. */
  browser?: { client?: BrowserClient; env?: Readonly<Record<string, string | undefined>>; pollMs?: number }
  /** Мост Paseo для режима «сначала Paseo». Нет клиента — мост недоступен, врач лечит сам. */
  handoff?: { client?: PaseoBridgeClient; pollMs?: number }
  now(): number
}

export interface Treatment {
  extension: Extension
  /** Внутри транзакции нового случая: разговор случая и задача лечения появляются вместе со случаем. */
  startIn(tx: RecordTransaction, opened: Case): Promise<void>
  /** Внутри транзакции: новая попытка лечения открытого случая, чья задача упала. Возвращает номер попытки. */
  restartIn(tx: RecordTransaction, opened: Case): Promise<number>
  /**
   * Внутри транзакции позднего итога агента: его выкатку, ещё не взятую под наблюдение, наблюдает новая попытка,
   * если лечение случая уже кончилось. Идущее лечение заметит её само на ближайшей фазе.
   */
  adoptLateDeployIn(tx: RecordTransaction, caseId: number): Promise<void>
}

type Runtime = TaskRuntime<TreatmentInput, TreatmentState, TreatmentResult, object>
type ConverseStatus = 'answered' | 'failed' | ModelBlock
type Stage = 'diagnose' | 'fix'
type Base = { commit: string; running: boolean }
type DeployPhase = Extract<TreatmentState, { phase: 'deploying' | 'observing' }>
type DeploySleep = Extract<DeployStep, { kind: 'sleep' }>
type AgentWait = Extract<TreatmentState, { phase: AgentWaitPhase }>

const BASE_UNKNOWN_NOTE = 'Заметка: основа — main, рабочая версия неизвестна.'
const COMMIT_SHA = /^[0-9a-f]{7,64}$/i
/** Остаток eval на сегодня держат чужие брони: через сколько спросить снова. */
const EVAL_WAIT_MS = 60_000
/** Задача просыпается чуть позже начала новых суток: часы и таймер не должны оставить её в старых. */
export const RESUME_MARGIN_MS = 60_000

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
  function redactedWith(knownSecrets: string[], text: ReportText, baseRunning: boolean): ReportText {
    return {
      short: redactSecrets(text.short, { knownSecrets }),
      full: redactSecrets(baseRunning ? text.full : `${text.full}\n${BASE_UNKNOWN_NOTE}`, { knownSecrets }),
      ...(text.stopSwitch ? { stopSwitch: true as const } : {}),
      ...(text.screenshots ? { screenshots: text.screenshots } : {}),
    }
  }

  async function redactedReport(text: ReportText, baseRunning: boolean): Promise<ReportText> {
    return redactedWith(knownSecretsOf(await deps.loadConfig()), text, baseRunning)
  }

  /** Отчёт и состояние случая внутри фиксации задачи. */
  async function reportIn(records: RecordTransaction, caseId: number, state: CaseState, type: ReportType, text: ReportText): Promise<number> {
    const opened = await setCaseStateIn(records, caseId, state)
    // Снимки экрана, снятые браузером врача по случаю, уходят в ближайший отчёт.
    const screenshots = [...(text.screenshots ?? []), ...(await takeCaseScreenshotsIn(records, caseId))]
    const report = await deps.reports.addIn(records, {
      type,
      caseId,
      short: text.short,
      full: opened.paseoUnavailable ? `${text.full}\n${PASEO_UNAVAILABLE_NOTE}` : text.full,
      telegram: 'pending',
      ...(text.stopSwitch ? { stopSwitch: true } : {}),
      ...(screenshots.length > 0 ? { screenshots } : {}),
    })
    opened.reportIds.push(report.reportId)
    return report.reportId
  }

  /** Отчёт, состояние случая и итог задачи — одной фиксацией; `alsoIn` — ещё записи в ту же фиксацию. */
  async function finish(
    runtime: Runtime,
    caseId: number,
    state: CaseState,
    type: ReportType,
    text: ReportText,
    result: Omit<TreatmentResult, 'reportId'>,
    context: Context,
    baseRunning = true,
    alsoIn?: (records: RecordTransaction) => Promise<void>,
  ): Promise<void> {
    const redacted = await redactedReport(text, baseRunning)
    const handedOff = (await readHandoff(runtime, caseId, context)) !== undefined
    await runtime.commit(async (tx) => {
      const records = recordTransactionOver(tx)
      if (alsoIn) await alsoIn(records)
      const reportId = await reportIn(records, caseId, state, type, redacted)
      // Агент выкатил после `reclaimed`, пока врач лечил: наблюдение этой выкатки — следующей попыткой.
      if (handedOff) await adoptIn(records, caseId)
      return { status: 'terminal', outcome: { status: 'completed', result: { ...result, reportId } } }
    }, context)
    deps.onReport()
  }

  async function readHandoff(runtime: Runtime, caseId: number, context: Context): Promise<Handoff | undefined> {
    return (await runtime.snapshot(recordFamilyOf(HANDOFF_COLLECTION), handoffKey(caseId), context)) as unknown as Handoff | undefined
  }

  /** Документ передачи внутри фиксации; вызывать, только когда он точно есть — иначе создастся пустой. */
  async function handoffIn(records: RecordTransaction, caseId: number): Promise<Handoff> {
    return records.doc<Handoff>(HANDOFF_COLLECTION, handoffKey(caseId), {} as Handoff)
  }

  /** Новая попытка наблюдает позднюю выкатку агента. Случай `observing`, документ передачи помнит, что выкатка взята. */
  async function adoptIn(records: RecordTransaction, caseId: number): Promise<void> {
    if (!deps.deployer) return
    const handoff = await handoffIn(records, caseId)
    const late = unadoptedDeploy(handoff)
    if (!late) return
    handoff.adoptedAt = new Date(deps.now()).toISOString()
    const opened = await caseIn(records, caseId)
    const attempt = (opened.treatmentAttempt ?? 1) + 1
    await startTreatmentIn(records, opened, { caseId, attempt, adopt: late })
    opened.treatmentAttempt = attempt
    opened.state = 'observing'
  }

  /**
   * Агент выкатил после `reclaimed`, а врач ещё лечит: своё лечение бросается — правит случай только один, —
   * задача переходит к наблюдению выкатки агента. `true` — перешла.
   */
  async function switchToLateDeploy(runtime: Runtime, caseId: number, context: Context): Promise<boolean> {
    if (!deps.deployer || !unadoptedDeploy(await readHandoff(runtime, caseId, context))) return false
    let switched = false
    await runtime.commit(async (tx) => {
      const records = recordTransactionOver(tx)
      const handoff = await handoffIn(records, caseId)
      const late = unadoptedDeploy(handoff)
      if (!late) return undefined
      handoff.adoptedAt = new Date(deps.now()).toISOString()
      await setCaseStateIn(records, caseId, 'observing')
      switched = true
      return { status: 'running', checkpoint: { phase: 'paseo_observing', ...late } }
    }, context)
    return switched
  }

  /** Врач забрал случай: задача агента отменяется у моста. Не вышло (мост пропал) — повтор в начале следующей фазы. */
  async function cancelReclaimed(runtime: Runtime, handoff: Handoff, context: Context): Promise<void> {
    if (!cancelPending(handoff)) return
    if (!(await deps.handoff?.client?.cancel(handoff.taskId, CANCEL_REASONS[handoff.reclaimReason!]))) return
    await runtime.commit(async (tx) => {
      ;(await handoffIn(recordTransactionOver(tx), handoff.caseId)).cancelSent = true
      return undefined
    }, context)
  }

  /**
   * Начало фазы лечения врачом после `reclaimed`: повторить отмену задачи агента, если мост её ещё не подтвердил,
   * и перейти к поздней выкатке агента, если она есть. `true` — перешла.
   */
  async function followUpReclaim(runtime: Runtime, caseId: number, context: Context): Promise<boolean> {
    const handoff = await readHandoff(runtime, caseId, context)
    if (!handoff) return false
    await cancelReclaimed(runtime, handoff, context)
    return switchToLateDeploy(runtime, caseId, context)
  }

  /**
   * Правит случай один: свою правку врач не выкатывает, пока агент, может быть, ещё работает — мост не подтвердил
   * отмену его задачи, а срок работы агента не прошёл. Возвращает, до какого времени ждать; `undefined` — можно.
   */
  async function ownDeployHold(runtime: Runtime, caseId: number, config: RemontnikConfig, context: Context): Promise<number | undefined> {
    const paseo = config.handoff.paseo
    const handoff = await readHandoff(runtime, caseId, context)
    if (!paseo || !handoff || !cancelPending(handoff)) return undefined
    const deadline = agentDeadlineOf(handoff, paseo)
    const now = deps.now()
    if (!(now < deadline)) return undefined
    return Math.min(now + (deps.handoff?.pollMs ?? HANDOFF_POLL_MS), deadline)
  }

  /** Врач забирает случай: `reclaimed`, отчёт и снова `triage` — одной фиксацией. Итог агента, пришедший раньше, важнее. */
  async function reclaim(runtime: Runtime, caseId: number, phase: AgentWaitPhase, reason: ReclaimReason, context: Context): Promise<void> {
    const config = await deps.loadConfig()
    const paseo = config.handoff.paseo
    const sick = await readCase(runtime, caseId, context)
    const seen = await readHandoff(runtime, caseId, context)
    const minutes = paseo ? Math.round((reason === 'accept_timeout' ? paseo.acceptTimeoutMs : paseo.workTimeoutMs) / 60_000) : undefined
    const agentSaid = seen?.result?.kind === 'cannot' ? seen.result.reason : undefined
    const text = await redactedReport(reclaimedReport({ case: sick, reason, ...(minutes === undefined ? {} : { minutes }), ...(agentSaid ? { agentSaid } : {}) }), true)
    let reported = false
    await runtime.commit(async (tx) => {
      const records = recordTransactionOver(tx)
      const handoff = await handoffIn(records, caseId)
      // Пока врач решал, агент прислал «сделано»: фаза перечитает документ и закроет случай по итогу агента.
      if (handoff.owner !== 'paseo' || (handoff.result?.kind === 'done' && reason !== 'cannot')) return { status: 'running', checkpoint: { phase } }
      reclaimHandoff(handoff, reason, deps.now())
      if (reason === 'bridge_unreachable') (await caseIn(records, caseId)).paseoUnavailable = true
      await reportIn(records, caseId, 'reclaimed', 'reclaimed', text)
      reported = true
      return { status: 'running', checkpoint: { phase: 'triage' } }
    }, context)
    if (reported) deps.onReport()
  }

  /** Агент сделал: без выкатки случай закрыт агентом; с выкаткой врач берёт её под наблюдение. */
  async function agentDone(runtime: Runtime, caseId: number, result: Extract<HandoffResult, { kind: 'done' }>, context: Context): Promise<void> {
    const sick = await readCase(runtime, caseId, context)
    const deployed = result.deployed && result.version ? result.version : undefined
    if (!deployed || !deps.deployer) {
      const text = paseoDoneReport({ case: sick, result: deployed ? { ...result, deployed: false } : result })
      await finish(runtime, caseId, 'healed_by_paseo', 'paseo_done', text, { outcome: 'healed_by_paseo' }, context)
      return
    }
    const text = await redactedReport(paseoDoneReport({ case: sick, result }), true)
    await runtime.commit(async (tx) => {
      const records = recordTransactionOver(tx)
      const handoff = await handoffIn(records, caseId)
      handoff.adoptedAt = new Date(deps.now()).toISOString()
      await reportIn(records, caseId, 'observing', 'paseo_done', text)
      return { status: 'running', checkpoint: { phase: 'paseo_observing', ...agentDeployWindow(handoff, deployed, handoff.finishedAt ?? handoff.adoptedAt) } }
    }, context)
    deps.onReport()
  }

  /**
   * Фазы `handed_off` и `paseo_working`: раз в `pollMs` — документ передачи (итог, «взял», сроки) и жив ли мост.
   * Мост молчит дольше `bridgeSilenceMs` — ждать итога агента незачем. Короче — перезагрузка моста или сон Mac: ждём.
   */
  async function waitForAgent(runtime: Runtime, caseId: number, checkpoint: AgentWait, context: Context): Promise<void> {
    const handoff = await readHandoff(runtime, caseId, context)
    if (!handoff) throw new Error(`передачи случая ${caseId} нет`)
    const pollMs = deps.handoff?.pollMs ?? HANDOFF_POLL_MS
    const step = agentStep(handoff, checkpoint.phase, deps.now(), pollMs)
    switch (step.kind) {
      case 'done':
        return agentDone(runtime, caseId, step.result, context)
      case 'reclaim':
        return reclaim(runtime, caseId, checkpoint.phase, step.reason, context)
      case 'accepted': {
        const paseo = (await deps.loadConfig()).handoff.paseo
        await runtime.commit(async (tx) => {
          const records = recordTransactionOver(tx)
          const fresh = await handoffIn(records, caseId)
          fresh.workDeadline = new Date(Date.parse(fresh.acceptedAt!) + (paseo?.workTimeoutMs ?? 0)).toISOString()
          await setCaseStateIn(records, caseId, 'paseo_working')
          return { status: 'running', checkpoint: { phase: 'paseo_working' } }
        }, context)
        return
      }
      case 'wait': {
        if ((await deps.handoff?.client?.health()) ?? false) return runtime.sleepUntil(step.until, { phase: checkpoint.phase }, context)
        const now = deps.now()
        const bridgeDownSince = checkpoint.bridgeDownSince ?? now
        const silenceMs = (await deps.loadConfig()).handoff.paseo?.bridgeSilenceMs ?? BRIDGE_SILENCE_MS
        if (now - bridgeDownSince >= silenceMs) return reclaim(runtime, caseId, checkpoint.phase, 'bridge_unreachable', context)
        return runtime.sleepUntil(step.until, { phase: checkpoint.phase, bridgeDownSince }, context)
      }
    }
  }

  /**
   * Дневной бюджет кончился: случай `deferred_budget`, отчёт и сон задачи до начала следующих суток — одной фиксацией.
   * Проснувшись, задача продолжает тот же этап. Второй перенос в те же сутки — без нового отчёта.
   */
  async function deferToNextDay(runtime: Runtime, caseId: number, checkpoint: Extract<TreatmentState, Treating>, what: 'model' | 'eval', context: Context): Promise<void> {
    const config = await deps.loadConfig()
    const now = deps.now()
    const today = spendDayKey(now, config.app.timeZone)
    const again = checkpoint.deferredDay === today
    const resumeAt = nextDayStartMs(now, config.app.timeZone) + RESUME_MARGIN_MS
    const day = (await runtime.snapshot(recordFamilyOf('spend'), spendDayKey(now, config.app.timeZone), context)) as unknown as SpendDay | undefined
    const doc = await treatmentDoc(runtime, checkpoint.conversationId, context)
    const text = budgetDeferredReport({
      case: doc.case,
      what,
      spentUsd: what === 'model' ? modelSpentUsd(day) : evalSpentUsd(day),
      limitUsd: what === 'model' ? config.limits.doctorModelUsdPerDay : config.limits.evalUsdPerDay,
      resumeAt: nextDayStartMs(now, config.app.timeZone),
      timeZone: config.app.timeZone,
    })
    const { short, full } = await redactedReport(text, checkpoint.baseRunning)
    await runtime.commit(async (tx) => {
      const records = recordTransactionOver(tx)
      const opened = await caseIn(records, caseId)
      opened.state = 'deferred_budget'
      if (!again) {
        const report = await deps.reports.addIn(records, { type: 'budget_reached', caseId, short, full, telegram: 'pending' })
        opened.reportIds.push(report.reportId)
      }
      // Отложенный случай сегодня eval не ждёт: его доля остатка дня не бережётся.
      await leaveEvalQueueIn(records, caseKey(caseId))
      return { status: 'sleeping', until: resumeAt, checkpoint: { ...checkpoint, resumes: (checkpoint.resumes ?? 0) + 1, deferredDay: today } }
    }, context)
    if (!again) deps.onReport()
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
   * Один этап работы модели. Каждый запрос бронирует деньги до отправки; не хватило — ход кончается отказом, и учёт
   * случая говорит, чей потолок. После перезапуска тот же `requestId` находит тот же запрос. После переноса на
   * следующие сутки этап продолжается просьбой продолжить — новым запросом, и он тоже переживает перезапуск.
   */
  async function converse(
    runtime: Runtime,
    treating: Treating,
    caseId: number,
    stage: Stage,
    content: string,
    context: Context,
  ): Promise<{ status: ConverseStatus; spentUsd: number }> {
    const handle = await runtime.conversation(treating.conversationId, context)
    if (!handle) throw new Error('разговор модели пропал')
    // С каким числом переносов этап впервые спросил модель: пока оно то же, запрос — исходный.
    const resumes = treating.resumes ?? 0
    const started = (await runtime.memo<number>(`started:${stage}`, context)) ?? (await runtime.memo<number>(`started:${stage}`, resumes, context))
    const request =
      started === resumes ? { requestId: `${stage}:${caseId}`, content } : { requestId: `${stage}:${caseId}:resume-${resumes}`, content: resumeMessage() }
    const record = await (await handle.submit({ type: 'input', ...request }, context)).wait(context)
    const spent = spentUsd(await runtime.snapshot(UsageDoc, treating.conversationId, context))
    if (record.status === 'done') return { status: 'answered', spentUsd: spent }
    const caseSpend = (await runtime.snapshot(recordFamilyOf('spend-case'), caseKey(caseId), context)) as unknown as CaseSpend | undefined
    return { status: caseSpend?.refused ?? 'failed', spentUsd: spent }
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
      reserved = await reserveEvalIn(recordTransactionOver(tx), { dayKey, caseKey: caseKey(caseId), now: deps.now(), boot: deps.boot, limits: config.limits })
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

  /**
   * Правка осталась работать — ветка уходит в основную: `merge` — git-замком, проверенной ревизией и только вперёд,
   * `pull-request` — ждёт запроса на слияние. Стоп-кран, нажатый за окно, слияние останавливает: правка ждёт человека.
   * Повтор после перезапуска безопасен: правку, уже лежащую в основной ветке, git-замок не отправляет второй раз, а
   * итог — «влил», даже если стоп-кран нажали, пока врач лежал после слияния.
   */
  async function settleMainline(runtime: Runtime, checkpoint: DeployPhase, context: Context): Promise<MainlineResult> {
    const config = await deps.loadConfig()
    const { branch } = checkpoint
    const controls = (await runtime.snapshot(recordFamilyOf(CONTROLS.collection), CONTROLS.key, context)) as unknown as DeployControlsState | undefined
    try {
      if (!checkpoint.pushed) await deps.guard.push(branch)
      if (config.repo.mainline !== 'merge') return { kind: 'pull_request', branch }
      if (controls?.autoDeploy === 'stopped') {
        return (await deps.guard.isInMainline(checkpoint.fixCommit)) ? { kind: 'merged', into: config.repo.mainBranch } : { kind: 'stopped', branch }
      }
      await deps.guard.mergeIntoMain(branch, checkpoint.fixCommit)
      return { kind: 'merged', into: config.repo.mainBranch }
    } catch (error) {
      if (!(error instanceof GitGuardError)) throw error
      // Текст git (в нём адрес origin) — только в журнал; в отчёт — причина по коду ошибки.
      runtime.report(error)
      return { kind: 'merge_failed', branch, reason: GIT_GUARD_REASONS[error.code] }
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
   * Страницы из `browser.pagesToCheck` сразу после выкатки; итог запоминается по выкатке — повтор шага браузер не
   * гоняет, а следующая выкатка того же случая проверяется заново.
   */
  async function pageCheckOf(runtime: Runtime, deploymentId: number, context: Context): Promise<PageCheck | undefined> {
    const key = `pageCheck:${deploymentId}`
    const kept = await runtime.memo<JsonValue>(key, context)
    if (kept !== undefined) return (kept ?? undefined) as unknown as PageCheck | undefined
    const check = await checkPages(deps.browser?.client, (await deps.loadConfig()).browser, context.abortSignal)
    await runtime.memo(key, (check ?? null) as unknown as JsonValue, context)
    return check
  }

  /**
   * Фазы `deploying` и `observing`: шаг выкатки. Пока выкатка ждёт замок, задача спит в `deploying`; когда правка
   * выкачена, одной фиксацией — случай `observing`, отчёт «выкатил, наблюдаю» и чекпойнт `observing`.
   * Конец выкатки закрывает случай её отчётом.
   */
  async function deployStep(runtime: Runtime, input: TreatmentInput, checkpoint: DeployPhase, deployer: Deployer, context: Context): Promise<void> {
    const { caseId } = input
    const sick = await readCase(runtime, caseId, context)
    const candidateDir = `${workbenchPath(deps.worktreesDir, caseId, input.attempt)}-deploy`
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
      const deployed =
        step.stage === 'observing'
          ? await redactedReport(withPageCheck(deploymentReport({ case: doc.case, deployment }), await pageCheckOf(runtime, deployment.deploymentId, context)), checkpoint.baseRunning)
          : undefined
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
    // Учёт выкаток — той же фиксацией, что итог. Правку откатили (или откат не удался): по этому отпечатку дальше
    // выкатывает только человек. Выкатка не началась: допуск возвращается, попытка не потрачена.
    const { timeZone } = (await deps.loadConfig()).app
    const ledgerIn = async (records: RecordTransaction) => {
      const input = { fingerprint: sick.fingerprint, deploymentId: deployment.deploymentId }
      if (deployment.outcome === 'rolled_back' || deployment.outcome === 'rollback_failed') await recordRollbackIn(records, { ...input, at: deps.now() })
      if (deployment.outcome === 'refused') await refundAutoDeployIn(records, { ...input, timeZone })
    }
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
      ledgerIn,
    )
  }

  const task = defineTask<TreatmentInput, TreatmentState, TreatmentResult>({
    name: TREATMENT_TASK_NAME,
    version: 1,
    initial: (input) => (input.adopt ? { phase: 'paseo_observing', ...input.adopt } : { phase: 'triage' }),
    phases: {
      triage: async (task, runtime, context) => {
        const { caseId } = task.input
        const sick = await readCase(runtime, caseId, context)
        const config = await deps.loadConfig()
        if (config.handoff.mode === 'paseo-first') {
          const handoff = await readHandoff(runtime, caseId, context)
          if (!handoff) {
            await runtime.commit(async (tx) => {
              ;(await caseIn(recordTransactionOver(tx), caseId)).state = 'handoff_check'
              return { status: 'running', checkpoint: { phase: 'handoff_check' } }
            }, context)
            return
          }
          // Попытка после сбоя задачи, пока случай у агента: врач снова ждёт его, а не лечит поверх.
          if (handoff.owner === 'paseo') {
            const phase = handoff.acceptedAt ? 'paseo_working' : 'handed_off'
            await runtime.commit(async (tx) => {
              ;(await caseIn(recordTransactionOver(tx), caseId)).state = phase
              return { status: 'running', checkpoint: { phase } }
            }, context)
            return
          }
          if (await followUpReclaim(runtime, caseId, context)) return
        }
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
          ...(task.input.attempt ? { attempt: task.input.attempt } : {}),
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
        const limitUsd = caseLimitUsdOf(config.limits)

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

      handoff_check: async (task, runtime, context) => {
        const { caseId } = task.input
        const config = await deps.loadConfig()
        const paseo = config.handoff.paseo
        const sick = await readCase(runtime, caseId, context)
        const client = deps.handoff?.client
        // Номер задачи — один на случай: повтор фазы после перезапуска мост узнаёт и второго письма агенту не шлёт.
        const taskId = (await runtime.memo<string>('handoffTaskId', context)) ?? (await runtime.memo('handoffTaskId', newEventId(deps.now()), context))
        let offered = false
        let sent = false
        if (client && paseo && (await client.health())) {
          offered = true
          sent = await client.sendTask(handoffTaskBody({ taskId, appName: config.app.name, case: sick, knownSecrets: knownSecretsOf(config) }))
        }
        const now = deps.now()
        const at = new Date(now).toISOString()
        if (!sent || !paseo) {
          await runtime.commit(async (tx) => {
            const records = recordTransactionOver(tx)
            const handoff = await records.doc<Handoff>(HANDOFF_COLLECTION, handoffKey(caseId), { caseId, taskId, owner: 'doctor' })
            Object.assign(handoff, { owner: 'doctor', reclaimedAt: at, reclaimReason: 'bridge_unreachable' }, offered ? { taskOffered: true } : {})
            const opened = await caseIn(records, caseId)
            opened.paseoUnavailable = true
            opened.state = 'triage'
            return { status: 'running', checkpoint: { phase: 'triage' } }
          }, context)
          return
        }
        const acceptDeadline = now + paseo.acceptTimeoutMs
        const text = await redactedReport(handedOffReport({ case: sick, acceptMinutes: Math.round(paseo.acceptTimeoutMs / 60_000) }), true)
        await runtime.commit(async (tx) => {
          const records = recordTransactionOver(tx)
          const handoff = await records.doc<Handoff>(HANDOFF_COLLECTION, handoffKey(caseId), { caseId, taskId, owner: 'paseo' })
          Object.assign(handoff, { owner: 'paseo', sentAt: at, acceptDeadline: new Date(acceptDeadline).toISOString() })
          await reportIn(records, caseId, 'handed_off', 'handed_off', text)
          return { status: 'sleeping', until: Math.min(now + (deps.handoff?.pollMs ?? HANDOFF_POLL_MS), acceptDeadline), checkpoint: { phase: 'handed_off' } }
        }, context)
        deps.onReport()
      },

      handed_off: async (task, runtime, context) => waitForAgent(runtime, task.input.caseId, task.state.checkpoint, context),

      paseo_working: async (task, runtime, context) => waitForAgent(runtime, task.input.caseId, task.state.checkpoint, context),

      paseo_observing: async (task, runtime, context) => {
        if (!deps.deployer) throw new Error('выкатку агента наблюдать нечем: выкатчика у врача нет')
        const { caseId } = task.input
        const checkpoint = task.state.checkpoint
        const sick = await readCase(runtime, caseId, context)
        const request: DeployRequest = {
          caseId,
          appName: sick.appName,
          fingerprint: sick.fingerprint,
          candidateVersion: checkpoint.version,
          candidateDir: '',
          adopt: { since: checkpoint.since, ...(checkpoint.caseSince === undefined ? {} : { caseSince: checkpoint.caseSince }) },
        }
        let step: DeployStep
        try {
          step = await runDeploymentInTask(runtime, deps.deployer, request, checkpoint, context)
        } finally {
          deps.onReport()
        }
        if (step.kind === 'sleep') return
        const { deployment } = step
        const text = paseoDeploymentReport({ case: sick, deployment })
        // Отказ выкатчика (работает не та версия, замок не взять) — не «правка готова»: правку делал агент, нужен человек.
        const closing =
          text.type === 'paseo_done'
            ? ({ state: 'healed_by_paseo', outcome: 'healed_by_paseo' } as const)
            : deployment.outcome === 'refused'
              ? ({ state: 'needs_human', outcome: 'needs_human', why: 'deploy' } as const)
              : deployClosing(deployment, text.type)
        const type: ReportType = deployment.outcome === 'refused' ? 'needs_human' : text.type
        const ledgerIn = async (records: RecordTransaction) => {
          if (deployment.outcome === 'rolled_back' || deployment.outcome === 'rollback_failed') {
            await recordRollbackIn(records, { fingerprint: sick.fingerprint, deploymentId: deployment.deploymentId, at: deps.now() })
          }
        }
        const result = { outcome: closing.outcome, ...('why' in closing && closing.why ? { why: closing.why } : {}), deploymentId: deployment.deploymentId }
        await finish(runtime, caseId, closing.state, type, text, result, context, true, ledgerIn)
      },

      diagnosing: async (task, runtime, context) => {
        const { caseId } = task.input
        const treating = task.state.checkpoint
        if (await followUpReclaim(runtime, caseId, context)) return
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
        if (await followUpReclaim(runtime, caseId, context)) return
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
        if (await followUpReclaim(runtime, caseId, context)) return
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
          const copyPath = workbenchPath(deps.worktreesDir, caseId, task.input.attempt)
          const candidateDir = `${copyPath}-candidate`
          const baseDir = `${copyPath}-base`
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
        if (await followUpReclaim(runtime, caseId, context)) return
        const doc = await treatmentDoc(runtime, checkpoint.conversationId, context)
        const config = await deps.loadConfig()
        const sick = await readCase(runtime, caseId, context)
        const spendDay = (await runtime.snapshot(recordFamilyOf('spend'), spendDayKey(deps.now(), config.app.timeZone), context)) as unknown as SpendDay | undefined
        const controls = deps.deployControls ? await deps.deployControls.read({ caseId, fingerprint: sick.fingerprint, config }) : noDeployControls()
        const sdkPackage = agentChatSdkPackage(diagnosis, inspection)
        const result = {
          branch: checkpoint.branch,
          fixCommit: checkpoint.fixCommit,
          changedPaths: checkpoint.changedPaths,
          ...(checks ? { checks } : {}),
          ...(sdkPackage ? { sdkPackage } : {}),
        }
        const ready = { case: doc.case, diagnosis, fix, branch: checkpoint.branch, commit: checkpoint.fixCommit, pushed: checkpoint.pushed }
        const sdkTask = sdkPackage ? agentChatSdkTask({ case: doc.case, stack: doc.case.stack, diagnosis, packageName: sdkPackage }) : undefined
        const knownSecrets = knownSecretsOf(config)
        const holdUntil = await ownDeployHold(runtime, caseId, config, context)
        const closeWith = (kind: GateClosing['kind'], gate: GateDecision): { text: ReportText; outcome: Pick<TreatmentResult, 'outcome' | 'why'> } => {
          switch (kind) {
            case 'deploy':
              return { text: fixReadyReport({ ...ready, checks: checks! }), outcome: { outcome: 'fix_ready' } }
            case 'not_deployed':
              return { text: gateReport({ ...ready, ...(checks ? { checks } : {}), decision: gate }), outcome: { outcome: 'fix_ready' } }
            case 'checks_red':
              return { text: causeFoundReport({ case: doc.case, diagnosis, reason: 'checks_red', branch: checkpoint.branch, checks: checks! }), outcome: { outcome: 'cause_found' } }
            case 'stand_broken':
              return { text: standBrokenReport({ case: doc.case, branch: checkpoint.branch, checks: checks! }), outcome: { outcome: 'stand_broken' } }
            case 'needs_human':
              return {
                text: gateReport({ ...ready, ...(checks ? { checks } : {}), decision: gate, ...(sdkTask ? { sdkTask } : {}) }),
                outcome: { outcome: 'needs_human', why: sdkPackage ? 'agent_chat_sdk' : 'gate' },
              }
          }
        }

        // Учёт выкаток читается в той же фиксации, где решение и допуск: два случая разом не займут последнее место
        // (отказ учёта — это решение «не выкатывать» с понятным отчётом), а продолжение после перезапуска решение
        // не пересчитывает и второй попыткой не считается.
        let reported = false
        await runtime.commit(async (tx) => {
          const records = recordTransactionOver(tx)
          const now = deps.now()
          const ledger = await records.doc<FingerprintLedger>(LEDGER.collection, LEDGER.key, emptyFingerprintLedger())
          const attempts = deployAttemptsOf(ledger, { fingerprint: sick.fingerprint, now, timeZone: config.app.timeZone, limits: config.limits })
          let gate = decideDeploy(deployFactsOf({ inspection, checks, controls, attempts, spendDay: spendDay ?? emptySpendDay(), limits: config.limits }))
          let closing = closingOf(gate, checks)
          // Агент, может быть, ещё правит: решение примем заново, когда мост подтвердит отмену или срок агента пройдёт.
          if (closing.kind === 'deploy' && deps.deployer && holdUntil !== undefined) return { status: 'sleeping', until: holdUntil, checkpoint }
          if (closing.kind === 'deploy' && deps.deployer) {
            const deployment = await deploymentIdIn(records, { caseId, candidateVersion: checkpoint.fixCommit })
            const admission = await admitAutoDeployIn(records, {
              fingerprint: sick.fingerprint,
              deploymentId: deployment.deploymentId,
              at: now,
              timeZone: config.app.timeZone,
              limits: config.limits,
            })
            if (admission.admitted) {
              deployment.reserve()
              await setCaseStateIn(records, caseId, 'deploying')
              return { status: 'running', checkpoint: { ...checkpoint, phase: 'deploying', gate } }
            }
            // Те же правила над тем же документом, так что отказа здесь быть не должно. Если он всё же есть — это
            // решение «не выкатывать»: случай закрывается отчётом, а фаза не падает по кругу.
            gate = { verdict: 'report_only', reasons: admission.reasons.map((code) => ({ code, message: ATTEMPT_REFUSALS[code] })) }
            closing = closingOf(gate, checks)
          }
          const { text, outcome } = closeWith(closing.kind, gate)
          const reportId = await reportIn(records, caseId, closing.caseState, closing.report, redactedWith(knownSecrets, text, checkpoint.baseRunning))
          reported = true
          return { status: 'terminal', outcome: { status: 'completed', result: { ...result, gate, ...outcome, reportId } } }
        }, context)
        if (reported) deps.onReport()
      },

      deploying: async (task, runtime, context) => {
        if (!deps.deployer) throw new Error('выкатка начата, а выкатчика у врача нет')
        await deployStep(runtime, task.input, task.state.checkpoint, deps.deployer, context)
      },

      observing: async (task, runtime, context) => {
        if (!deps.deployer) throw new Error('выкатка начата, а выкатчика у врача нет')
        await deployStep(runtime, task.input, task.state.checkpoint, deps.deployer, context)
      },
    },
    // Снятая задача не держит брони eval и место в очереди: за сегодня и вчера (прогон мог начаться до полуночи).
    abort: async (task, runtime, context) => {
      const { timeZone } = (await deps.loadConfig()).app
      const now = deps.now()
      const dayKeys = [...new Set([spendDayKey(now - 24 * 3_600_000, timeZone), spendDayKey(now, timeZone)])]
      await runtime.commit(async (tx) => {
        await closeCaseEvalIn(recordTransactionOver(tx), { caseKey: caseKey(task.input.caseId), dayKeys })
        return { status: 'terminal', outcome: { status: 'aborted' } }
      }, context)
    },
  })

  /**
   * Привязка запроса к случаю для брони: хук получает исполнение генерации, чей `signal` затем уходит в `streamSimple`.
   * Отказать в запросе хук не может (pi-durable только сообщает его ошибки) — отказывает бронь в моделях врача.
   */
  const budgetHook = hook(GenerationTask, {
    beforeRequest: async (_request, api, context) => {
      const doc = await api.snapshot(TreatmentDoc, api.conversationId, context)
      const { signal } = api as unknown as { signal?: AbortSignal }
      if (doc?.case && signal) deps.modelBudget.bind(signal, doc.case.caseId)
      return undefined
    },
  })

  const extension: Extension = defineExtension({
    name: 'remontnik.doctor',
    tools: [
      ...doctorTools(
        createBrowserTools({
          ...(deps.browser?.client ? { client: deps.browser.client } : {}),
          ...(deps.browser?.env ? { env: deps.browser.env } : {}),
          ...(deps.browser?.pollMs ? { pollMs: deps.browser.pollMs } : {}),
          loadConfig: deps.loadConfig,
          reports: deps.reports,
          onReport: deps.onReport,
        }),
      ),
    ],
    hooks: [doctorToolGuard, budgetHook],
    tasks: [task],
  })

  async function startTreatmentIn(records: RecordTransaction, opened: Case, input: TreatmentInput): Promise<void> {
    const tx = durableTxOf(records)
    if (!tx) throw new Error('лечение запускается только в транзакции записей на pi-durable')
    const conversation = await tx.createConversation({ ownership: { kind: 'ownerless' } })
    const taskId = await tx.createTask(task, input, { ownership: { kind: 'conversation' }, conversationId: conversation.id, background: true })
    opened.treatmentTaskId = String(taskId)
    opened.state = 'triage'
  }

  return {
    extension,
    async startIn(records, opened) {
      await startTreatmentIn(records, opened, { caseId: opened.caseId })
    },
    async restartIn(records, opened) {
      const attempt = (opened.treatmentAttempt ?? 1) + 1
      await startTreatmentIn(records, opened, { caseId: opened.caseId, attempt })
      opened.treatmentAttempt = attempt
      return attempt
    },
    async adoptLateDeployIn(records, caseId) {
      const tx = durableTxOf(records)
      const opened = await caseIn(records, caseId)
      const current = opened.treatmentTaskId && tx ? await tx.task(Number(opened.treatmentTaskId) as TaskId) : undefined
      // Лечение ещё идёт — оно само заметит выкатку на ближайшей фазе или в своей последней фиксации.
      if (current && current.state.status !== 'terminal' && current.state.status !== 'completing') return
      await adoptIn(records, caseId)
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
