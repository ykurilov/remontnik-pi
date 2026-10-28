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
// Новая попытка там, где она может навредить или выбросить готовое, — только с явным согласием владельца (`force`):
// правка уже готова, после выкатки неясно, что работает, или передача Paseo упала, не записав номер задачи моста.

/** Новая попытка здесь начала бы вторую выкатку поверх незаконченной: сначала владелец смотрит, что с приложением. */
const DEPLOY_STATES: readonly CaseState[] = ['deploying', 'observing']

export interface CaseRetryDeps {
  harness: Pick<Harness, 'getTask' | 'inspect' | 'retryTask'>
  records: RecordStore
  treatment?: Treatment
  now: () => number
}

export interface CaseRetryRequest {
  /** Владелец согласен на новую попытку, о которой его предупредили. */
  force?: boolean
}

type Warning = Extract<CaseRetryAnswer, { error: 'fix_ready' | 'deploy_needs_human' | 'handoff_unconfirmed' }>

/** О чём предупредить перед новой попыткой; `undefined` — повторять можно без согласия. */
function warningFor(sick: Case): Warning | undefined {
  const force = `remontnik-doctor case ${sick.caseId} retry --force`
  const last = sick.lastOutcome
  if (last?.outcome === 'fix_ready') {
    const branch = last.branch ?? '—'
    return { error: 'fix_ready', state: sick.state, branch, hint: `правка готова в ветке ${branch}, её выкатывает человек. Новая попытка лечит на новой ветке, эта остаётся: ${force}` }
  }
  if (last?.why === 'deploy') {
    return { error: 'deploy_needs_human', state: sick.state, hint: `после выкатки нужен человек: сначала проверьте, какая версия работает. Если врач её не подтверждал — remontnik-doctor deploys confirm <версия>; после отката — remontnik-doctor fingerprint ${sick.fingerprint} release. Потом: ${force}` }
  }
  // Передача начата прежним врачом, номер задачи моста помнила только упавшая задача: новая попытка завела бы
  // агенту Paseo второй случай.
  if (sick.state === 'handoff_check' && sick.handoffTaskId === undefined) {
    return { error: 'handoff_unconfirmed', state: sick.state, hint: `неизвестно, получил ли агент Paseo случай: проверьте у моста, и если агент над ним работает, отмените его задачу. Потом: ${force}` }
  }
  return undefined
}

export function createCaseRetry(deps: CaseRetryDeps): (caseId: number, by: string, request?: CaseRetryRequest) => Promise<CaseRetryAnswer> {
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

  async function retryOnce(caseId: number, by: string, request: CaseRetryRequest): Promise<CaseRetryAnswer> {
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
    const warning = warningFor(sick)
    if (warning && !request.force) return warning
    const treatment = deps.treatment
    return deps.records.transaction(async (tx): Promise<CaseRetryAnswer> => {
      const opened = await tx.doc<Case>('case', String(caseId), {} as Case)
      // Пока шла проверка задачи, случай мог сдвинуться (вторая команда повтора, поздняя выкатка агента
      // Paseo взята под наблюдение): тогда ничего не делать.
      if (opened.treatmentTaskId !== sick.treatmentTaskId || opened.state !== sick.state) return { error: 'already_running', state: opened.state }
      // Владелец лечит законченный случай заново: потолок случая — новой попытке, иначе после «бюджет исчерпан» она
      // кончилась бы, не начавшись. Задача, упавшая посреди лечения, продолжает тратить свой потолок.
      if (UNHEALED_FINAL_STATES.includes(opened.state)) await renewCaseBudgetIn(tx, String(caseId))
      // Ветка прошлой попытки остаётся в origin: ответ её называет, раз новая попытка лечит на своей.
      const previousBranch = opened.lastOutcome?.branch
      const next = await treatment.restartIn(tx, opened)
      markRetried(opened, by)
      return { retried: 'restarted', attempt: next, ...(previousBranch ? { previousBranch } : {}) }
    })
  }

  // Команды одного случая — по очереди: вторая, пришедшая, пока первая снимает задачу с остановки, видит её уже
  // идущей (`already_running`), а не снимает второй раз.
  const queues = new Map<number, Promise<CaseRetryAnswer>>()
  return function retryCase(caseId, by, request = {}) {
    const next = (queues.get(caseId) ?? Promise.resolve(undefined)).then(
      () => retryOnce(caseId, by, request),
      () => retryOnce(caseId, by, request),
    )
    queues.set(caseId, next)
    const forget = () => {
      if (queues.get(caseId) === next) queues.delete(caseId)
    }
    next.then(forget, forget)
    return next
  }
}
