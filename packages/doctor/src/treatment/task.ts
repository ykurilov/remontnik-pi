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
import type { Case, CaseState } from '../case-book/index.js'
import { createChecks, type ChecksResult, type EvalBaseCache } from '../checks/index.js'
import { slugify, type GitGuard } from '../git-guard/index.js'
import { diagnoseMessage, fixMessage } from '../model/case-messages.js'
import { buildRepoMap, buildSystemPrompt } from '../model/system-prompt.js'
import { matchesAnyMask } from '../path-mask/index.js'
import type { RecordStore, RecordTransaction } from '../records/index.js'
import type { ReportType, Reports } from '../reports/index.js'
import { causeFoundReport, fixReadyReport, noCauseFoundReport, standBrokenReport, type ReportText } from '../reports/texts.js'
import { durableTxOf, recordFamilyOf, recordTransactionOver } from '../service/harness.js'
import { createWorkbench, type CommandRunner } from '../workbench/index.js'
import { TreatmentDoc, type Diagnosis, type FixSummary, type TreatmentDocState } from './doc.js'
import { doctorToolGuard, doctorTools } from './tools.js'

// Задача лечения `remontnik.treatment` (R1). Фазы — чекпойнты pi-durable: перезапуск врача продолжает
// с последней сохранённой фазы, а фаза после перезапуска выполняется заново с начала, поэтому каждая
// идемпотентна: копия переиспользуется, запрос модели находится по `requestId`, итог модели лежит в документе.
//
//   triage → diagnosing → fixing → verifying → (этап 5: gating и выкатка)
//
// Модель работает в отдельном разговоре, которым владеет задача: системный промпт и набор инструментов
// постоянны для основы, сведения о случае — в сообщениях.

export type TreatmentInput = { caseId: number }

type Treating = {
  conversationId: ConversationId
  baseCommit: string
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

export type TreatmentOutcome = 'fix_ready' | 'cause_found' | 'no_cause_found' | 'stand_broken'

export type TreatmentResult = {
  outcome: TreatmentOutcome
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
  model: { provider: string; modelId: string }
  /** Исполнитель проверок (тесты, eval). */
  checksRunner: CommandRunner
  worktreesDir: string
  /** Папка для итогов eval. */
  checksDir: string
  evalEnv: Readonly<Record<string, string | undefined>>
  evalBaseCache: EvalBaseCache
  appDescription?: string
  /** Как часто сверять расход модели с потолком. */
  budgetPollMs: number
  /** Новый отчёт записан: пора отправлять. */
  onReport(): void
}

export interface Treatment {
  extension: Extension
  /** Внутри транзакции нового случая: разговор случая и задача лечения появляются вместе со случаем. */
  startIn(tx: RecordTransaction, opened: Case): Promise<void>
}

type Runtime = TaskRuntime<TreatmentInput, TreatmentState, TreatmentResult, object>

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
  ): Promise<void> {
    await runtime.commit(async (tx) => {
      const records = recordTransactionOver(tx)
      const opened = await caseIn(records, caseId)
      opened.state = state
      const report = await deps.reports.addIn(records, { type, caseId, short: text.short, full: text.full, telegram: 'pending' })
      opened.reportIds.push(report.reportId)
      return { status: 'terminal', outcome: { status: 'completed', result: { ...result, reportId: report.reportId } } }
    }, context)
    deps.onReport()
  }

  /**
   * Один этап работы модели. Пока она работает, расход сверяется с потолком; превысила — разговор прерывается.
   * После перезапуска тот же `requestId` находит тот же запрос.
   */
  async function converse(
    runtime: Runtime,
    treating: Treating,
    requestId: string,
    content: string,
    context: Context,
  ): Promise<{ status: 'answered' | 'failed' | 'budget'; spentUsd: number }> {
    const spent = async () => spentUsd(await runtime.snapshot(UsageDoc, treating.conversationId, context))
    if ((await spent()) >= treating.limitUsd) return { status: 'budget', spentUsd: await spent() }
    const handle = await runtime.conversation(treating.conversationId, context)
    if (!handle) throw new Error('разговор модели пропал')
    const submission = await handle.submit({ type: 'input', content, requestId }, context)

    let settled = false
    let overBudget = false
    const watcher = (async () => {
      while (!settled && !runtime.signal.aborted) {
        await new Promise<void>((resolve) => runtime.setTimer(resolve, deps.budgetPollMs))
        if (settled || runtime.signal.aborted) return
        if ((await spent()) >= treating.limitUsd) {
          overBudget = true
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
      if (overBudget) return { status: 'budget', spentUsd: total }
      return { status: record.status === 'done' ? 'answered' : 'failed', spentUsd: total }
    } finally {
      settled = true
    }
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
        const baseCommit = await runtime.memo('baseCommit', await deps.guard.resolve(`origin/${config.repo.mainBranch}`), context)
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
            checkpoint: { phase: 'diagnosing', conversationId, baseCommit, branch: workbench.branch, worktreePath: workbench.path, limitUsd },
          }
        }, context)
      },

      diagnosing: async (task, runtime, context) => {
        const { caseId } = task.input
        const treating = task.state.checkpoint
        let doc = await treatmentDoc(runtime, treating.conversationId, context)
        let run: { status: 'answered' | 'failed' | 'budget'; spentUsd: number } | undefined
        if (!doc.diagnosis) {
          run = await converse(runtime, treating, `diagnose:${caseId}`, diagnoseMessage(doc.case), context)
          doc = await treatmentDoc(runtime, treating.conversationId, context)
        }
        const diagnosis = doc.diagnosis
        if (!diagnosis?.found) {
          const reason = run?.status === 'budget' ? 'budget' : diagnosis ? 'not_found' : 'no_answer'
          const spent = run?.spentUsd ?? spentUsd(await runtime.snapshot(UsageDoc, treating.conversationId, context))
          const text = noCauseFoundReport({ case: doc.case, reason, spentUsd: spent, limitUsd: treating.limitUsd, ...(diagnosis ? { diagnosis } : {}) })
          await finish(runtime, caseId, 'no_cause_found', 'no_cause_found', text, { outcome: 'no_cause_found' }, context)
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
        let doc = await treatmentDoc(runtime, treating.conversationId, context)
        let run: { status: 'answered' | 'failed' | 'budget' } | undefined
        if (!doc.fix) {
          run = await converse(runtime, treating, `fix:${caseId}`, fixMessage(diagnosis), context)
          doc = await treatmentDoc(runtime, treating.conversationId, context)
        }
        const fix = doc.fix
        let fixCommit: string | undefined
        if (fix) {
          const made = await deps.guard.commitAll(treating.worktreePath, commitMessage(caseId, fix, diagnosis))
          fixCommit = made === undefined ? await runtime.memo<string>('fixCommit', context) : await runtime.memo('fixCommit', made, context)
        }
        if (!fix || !fixCommit) {
          const reason = fix ? 'no_changes' : run?.status === 'budget' ? 'budget' : 'no_answer'
          const text = causeFoundReport({ case: doc.case, diagnosis, reason })
          await finish(runtime, caseId, 'report_only', 'cause_found', text, { outcome: 'cause_found' }, context)
          return
        }
        const changedPaths = await deps.guard.changedPaths(treating.worktreePath, treating.baseCommit)
        await runtime.commit(async (tx) => {
          ;(await caseIn(recordTransactionOver(tx), caseId)).state = 'verifying'
          return { status: 'running', checkpoint: { ...treating, phase: 'verifying', diagnosis, fix, fixCommit, changedPaths } }
        }, context)
      },

      verifying: async (task, runtime, context) => {
        const { caseId } = task.input
        const checkpoint = task.state.checkpoint
        const doc = await treatmentDoc(runtime, checkpoint.conversationId, context)
        const config = await deps.loadConfig()

        let checks = (await runtime.memo<JsonValue>('checks', context)) as ChecksResult | undefined
        if (!checks) {
          // Проверки идут в своих копиях на закоммиченной правке и на основе: мусор модели в верстаке им не мешает.
          const closed = (await deps.guard.listFiles(checkpoint.baseCommit)).filter((file) => matchesAnyMask(config.closedPaths, file))
          const candidateDir = join(deps.worktreesDir, `case-${caseId}-candidate`)
          const baseDir = join(deps.worktreesDir, `case-${caseId}-base`)
          await deps.guard.addWorktree({ path: candidateDir, base: checkpoint.fixCommit, exclude: closed })
          await deps.guard.addWorktree({ path: baseDir, base: checkpoint.baseCommit, exclude: closed })
          try {
            const result = await createChecks({
              runner: deps.checksRunner,
              config,
              evalEnv: deps.evalEnv,
              baseCache: deps.evalBaseCache,
              workDir: deps.checksDir,
              timeoutSeconds: Math.max(1, Math.ceil(config.workbench.bashTimeoutMs / 1000)),
            }).run({
              candidateDir,
              baseDir,
              baseCommit: checkpoint.baseCommit,
              changedPaths: checkpoint.changedPaths,
              budgetUsd: config.limits.evalUsdPerDay,
            })
            checks = (await runtime.memo('checks', result as unknown as JsonValue, context)) as unknown as ChecksResult
          } finally {
            await deps.guard.removeWorktree(candidateDir).catch(() => {})
            await deps.guard.removeWorktree(baseDir).catch(() => {})
          }
        }

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
          await finish(runtime, caseId, 'stand_broken', 'stand_broken', text, { outcome: 'stand_broken', ...result }, context)
          return
        }
        if (checks.tests.status === 'green' || checks.tests.status === 'flaky') {
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
          await finish(runtime, caseId, 'report_only', 'fix_ready', text, { outcome: 'fix_ready', ...result }, context)
          return
        }
        const text = causeFoundReport({ case: doc.case, diagnosis: checkpoint.diagnosis, reason: 'checks_red', branch: checkpoint.branch, checks })
        await finish(runtime, caseId, 'report_only', 'cause_found', text, { outcome: 'cause_found', ...result }, context)
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
