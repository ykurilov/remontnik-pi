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
import { redactSecrets } from '@ykurilov/remontnik-core/redact'
import type { Case, CaseState } from '../case-book/index.js'
import { createChecks, type ChecksResult, type EvalBaseCache } from '../checks/index.js'
import type { EvalProxy, EvalSpend } from '../eval-proxy/index.js'
import { inspectDiff } from '../diff-inspector/index.js'
import { GitGuardError, slugify, type GitGuard } from '../git-guard/index.js'
import { diagnoseMessage, fixMessage } from '../model/case-messages.js'
import { buildRepoMap, buildSystemPrompt } from '../model/system-prompt.js'
import { matchesAnyMask } from '../path-mask/index.js'
import type { RecordStore, RecordTransaction } from '../records/index.js'
import type { ReportType, Reports } from '../reports/index.js'
import { causeFoundReport, fixReadyReport, needsHumanReport, noCauseFoundReport, standBrokenReport, type ReportText } from '../reports/texts.js'
import { durableTxOf, recordFamilyOf, recordTransactionOver } from '../service/harness.js'
import { createWorkbench, SpoiledCopyError, type CommandRunner } from '../workbench/index.js'
import { TreatmentDoc, type Diagnosis, type FixSummary, type TreatmentDocState } from './doc.js'
import { findProtectedChanges } from './protected-changes.js'
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
//   triage → diagnosing → fixing → verifying → (этап 5: gating и выкатка)
//
// Основа — рабочая версия (`deploy.commands.current`); неизвестна — последний коммит основной ветки, и отчёт это говорит.
// Правка, которая задевает защищённые пути (тесты, eval, зависимости, сборку, Ремонтника), не проверяется
// и не отправляется. Подменённая копия (git-замок: `escape`) — попытка выхода из верстака: случай останавливается.
// Расход модели и eval пишется в дневной учёт (`spend.ts`) по ходу работы.
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
  | ({ phase: 'verifying'; diagnosis: Diagnosis; fix: FixSummary; fixCommit: string; changedPaths: string[] } & Treating)

export type TreatmentOutcome = 'fix_ready' | 'cause_found' | 'no_cause_found' | 'stand_broken' | 'needs_human'

export type TreatmentResult = {
  outcome: TreatmentOutcome
  /** Почему нужен человек. */
  why?: 'protected_paths' | 'suspicious' | 'escape' | 'spoiled' | 'eval_worse'
  reportId: number
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
    // Ключи eval и всё похожее на секреты вырезается из отчёта: он уходит в Telegram и Paseo.
    const config = await deps.loadConfig()
    const evalNames = [...(config.checks.eval?.env ?? []), ...(config.checks.eval?.providers ?? []).map((provider) => provider.keyEnv)]
    const knownSecrets = evalNames.flatMap((name) => deps.evalEnv[name] ?? [])
    const short = redactSecrets(text.short, { knownSecrets })
    const full = redactSecrets(baseRunning ? text.full : `${text.full}\n${BASE_UNKNOWN_NOTE}`, { knownSecrets })
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

  /** Расход eval по прокси — в бронь по ходу, по одной записи за раз; последняя запись важнее промежуточных. */
  function evalSpendRecorder(runtime: Runtime, reservation: { day: string; id: string }, context: Context) {
    let latest: EvalSpend | undefined
    let unwritten: EvalSpend | undefined
    let chain = Promise.resolve()
    return {
      latest: () => latest,
      record(spend: EvalSpend) {
        latest = spend
        unwritten = spend
        chain = chain
          .then(async () => {
            const next = unwritten
            unwritten = undefined
            if (next) await updateReservation(runtime, reservation, context, (item) => recordEvalObserved(item, next))
          })
          .catch((error: unknown) => runtime.report(error))
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
            run = await converse(runtime, treating, caseId, `fix:${caseId}`, fixMessage(diagnosis), context)
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
          const config = await deps.loadConfig()
          const protectedChanges = findProtectedChanges(config, files)
          if (protectedChanges.length > 0) {
            const text = needsHumanReport({ case: doc.case, diagnosis, fix, reason: { kind: 'protected_paths', changes: protectedChanges, branch: treating.branch } })
            const result = { outcome: 'needs_human', why: 'protected_paths', branch: treating.branch, fixCommit, changedPaths } as const
            await finish(runtime, caseId, 'report_only', 'needs_human', text, result, context, treating.baseRunning)
            return
          }
          // Запись в файлы, окружение, новые адреса, Ремонтник и итог eval: правка могла бы подделать проверку.
          const suspicious = inspectDiff(files, config.limits, {
            knownHosts: config.browser?.allowedOrigins ?? [],
            ...(config.checks.eval ? { evalResultFile: config.checks.eval.resultFile } : {}),
          }).suspicious
          if (suspicious.length > 0) {
            const text = needsHumanReport({ case: doc.case, diagnosis, fix, reason: { kind: 'suspicious', findings: suspicious, branch: treating.branch } })
            const result = { outcome: 'needs_human', why: 'suspicious', branch: treating.branch, fixCommit, changedPaths } as const
            await finish(runtime, caseId, 'report_only', 'needs_human', text, result, context, treating.baseRunning)
            return
          }
          await runtime.commit(async (tx) => {
            ;(await caseIn(recordTransactionOver(tx), caseId)).state = 'verifying'
            return { status: 'running', checkpoint: { ...treating, phase: 'verifying', diagnosis, fix, fixCommit, changedPaths } }
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
          // Бронь — прямо перед проверками: открытая бронь всегда закрывается в finally или после перезапуска.
          const reservation = await reserveEval(runtime, caseId, config, context)
          const evalSpend = evalSpendRecorder(runtime, reservation, context)
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
              budgetUsd: reservation.budgetUsd,
              onEvalSpend: evalSpend.record,
            })
            await evalSpend.flush()
            await updateReservation(runtime, reservation, context, (item) => (item.actualUsd = result.eval.costUsd))
            settled = true
            checks = (await runtime.memo('checks', result as unknown as JsonValue, context)) as unknown as ChecksResult
          } finally {
            // Проверка упала: бронь закрывается тем, что досчитал прокси, а не сгорает целиком.
            if (!settled) {
              await evalSpend.flush()
              await updateReservation(runtime, reservation, context, (item) => settleEvalWithProxyFact(item, evalSpend.latest())).catch((error: unknown) => runtime.report(error))
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

        const result = { branch: checkpoint.branch, fixCommit: checkpoint.fixCommit, changedPaths: checkpoint.changedPaths, checks }
        if (checks.eval.status === 'stand_broken') {
          const text = standBrokenReport({ case: doc.case, branch: checkpoint.branch, checks })
          await finish(runtime, caseId, 'stand_broken', 'stand_broken', text, { outcome: 'stand_broken', ...result }, context, checkpoint.baseRunning)
          return
        }
        const testsPassed = checks.tests.status === 'green' || checks.tests.status === 'flaky'
        if (testsPassed && checks.eval.status === 'worse') {
          const text = needsHumanReport({
            case: doc.case,
            diagnosis: checkpoint.diagnosis,
            fix: checkpoint.fix,
            reason: { kind: 'eval_worse', branch: checkpoint.branch, checks },
          })
          await finish(runtime, caseId, 'report_only', 'needs_human', text, { outcome: 'needs_human', why: 'eval_worse', ...result }, context, checkpoint.baseRunning)
          return
        }
        if (testsPassed) {
          const text = fixReadyReport({
            case: doc.case,
            diagnosis: checkpoint.diagnosis,
            fix: checkpoint.fix,
            branch: checkpoint.branch,
            commit: checkpoint.fixCommit,
            checks,
            pushed,
          })
          // Этап 4 только сообщает: решение о выкатке (gated) добавит этап 5.
          await finish(runtime, caseId, 'report_only', 'fix_ready', text, { outcome: 'fix_ready', ...result }, context, checkpoint.baseRunning)
          return
        }
        const text = causeFoundReport({ case: doc.case, diagnosis: checkpoint.diagnosis, reason: 'checks_red', branch: checkpoint.branch, checks })
        await finish(runtime, caseId, 'report_only', 'cause_found', text, { outcome: 'cause_found', ...result }, context, checkpoint.baseRunning)
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
