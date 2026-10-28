import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import type { Harness, TaskId } from '@earendil-works/pi-durable'
import { CLOSED_CASE_STATES, UNHEALED_FINAL_STATES, type Case, type CaseState } from '../case-book/index.js'
import type { CaseRetryAnswer } from '../intake/case-retry.js'
import { renewCaseBudgetIn } from '../ledgers/spend-ledger.js'
import type { RecordStore } from '../records/index.js'
import type { Treatment } from '../treatment/index.js'

// Повтор лечения по команде владельца (`case <id> retry`): задача, остановленная после повторных падений врача,
// продолжается со своего чекпойнта; упавшая насовсем — заменяется новой попыткой со своей копией и веткой. Случай,
// чьё лечение кончилось без излечения (`UNHEALED_FINAL_STATES`), лечится новой попыткой со своим потолком расходов.
// Закрытый случай (вылечен или откачен) не повторяется: новый сбой с тем же отпечатком сам откроет новый случай.

/** Новая попытка здесь начала бы вторую выкатку поверх незаконченной: сначала владелец смотрит, что с приложением. */
const DEPLOY_STATES: readonly CaseState[] = ['deploying', 'observing']

export interface CaseRetryDeps {
  harness: Pick<Harness, 'getTask' | 'inspect' | 'retryTask'>
  records: RecordStore
  treatment?: Treatment
  now: () => number
}

export function createCaseRetry(deps: CaseRetryDeps): (caseId: number, by: string) => Promise<CaseRetryAnswer> {
  async function taskStatus(taskId: string): Promise<'parked' | 'live' | 'over'> {
    const id = Number(taskId) as TaskId
    const found = await deps.harness.getTask(id, BACKGROUND_CONTEXT)
    if (!found || found.state.status === 'terminal') return 'over'
    const inspection = await deps.harness.inspect(BACKGROUND_CONTEXT)
    const live = inspection.tasks.find((task) => task.record.id === id)
    return live?.state.kind === 'blocked' && live.state.reason === 'restart_limit' ? 'parked' : 'live'
  }

  const markRetried = (opened: Case, by: string) => {
    opened.retriedBy = by
    opened.retriedAt = new Date(deps.now()).toISOString()
  }

  async function retryOnce(caseId: number, by: string): Promise<CaseRetryAnswer> {
    const sick = await deps.records.read<Case>('case', String(caseId))
    if (sick?.caseId !== caseId) return { error: 'unknown_case' }
    if (CLOSED_CASE_STATES.includes(sick.state)) return { error: 'case_finished', state: sick.state }
    if (!deps.treatment) return { error: 'treatment_off', state: sick.state }
    const attempt = sick.treatmentAttempt ?? 1
    const status = sick.treatmentTaskId === undefined ? 'over' : await taskStatus(sick.treatmentTaskId)
    if (status === 'parked') {
      await deps.harness.retryTask(Number(sick.treatmentTaskId) as TaskId, BACKGROUND_CONTEXT)
      await deps.records.transaction(async (tx) => markRetried(await tx.doc<Case>('case', String(caseId), {} as Case), by))
      return { retried: 'parked', attempt }
    }
    if (status === 'live') return { error: 'already_running', state: sick.state }
    if (DEPLOY_STATES.includes(sick.state)) return { error: 'deploy_unfinished', state: sick.state }
    const treatment = deps.treatment
    return deps.records.transaction(async (tx): Promise<CaseRetryAnswer> => {
      const opened = await tx.doc<Case>('case', String(caseId), {} as Case)
      // Пока шла проверка задачи, случай мог сдвинуться (вторая команда повтора, поздняя выкатка агента
      // Paseo взята под наблюдение): тогда ничего не делать.
      if (opened.treatmentTaskId !== sick.treatmentTaskId || opened.state !== sick.state) return { error: 'already_running', state: opened.state }
      // Владелец лечит законченный случай заново: потолок случая — новой попытке, иначе после «бюджет исчерпан» она
      // кончилась бы, не начавшись. Задача, упавшая посреди лечения, продолжает тратить свой потолок.
      if (UNHEALED_FINAL_STATES.includes(opened.state)) await renewCaseBudgetIn(tx, String(caseId))
      const next = await treatment.restartIn(tx, opened)
      markRetried(opened, by)
      return { retried: 'restarted', attempt: next }
    })
  }

  // Команды одного случая — по очереди: вторая, пришедшая, пока первая снимает задачу с остановки, видит её уже
  // идущей (`already_running`), а не снимает второй раз.
  const queues = new Map<number, Promise<CaseRetryAnswer>>()
  return function retryCase(caseId, by) {
    const next = (queues.get(caseId) ?? Promise.resolve(undefined)).then(
      () => retryOnce(caseId, by),
      () => retryOnce(caseId, by),
    )
    queues.set(caseId, next)
    const forget = () => {
      if (queues.get(caseId) === next) queues.delete(caseId)
    }
    next.then(forget, forget)
    return next
  }
}
