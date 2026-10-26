import { describe, expect, it } from 'vitest'
import type { Case, CaseState } from '../case-book/index.js'
import { createMemoryRecordStore } from '../records/index.js'
import type { Treatment } from '../treatment/index.js'
import { createCaseRetry, type CaseRetryDeps } from './case-retry.js'

// Повтор лечения по команде владельца: остановленная после повторных падений задача продолжается сама, упавшая —
// заменяется новой попыткой; законченный случай, идущее лечение и незаконченная выкатка не трогаются.

type TaskView = 'terminal' | 'parked' | 'running'

async function world(state: CaseState, initial: TaskView, options: { treatment?: boolean } = {}) {
  let task = initial
  const records = createMemoryRecordStore()
  await records.transaction(async (tx) => {
    const opened = await tx.doc<Case>('case', '1', {} as Case)
    Object.assign(opened, { caseId: 1, appName: 'app', fingerprint: 'f', state, treatmentTaskId: '5', reportIds: [] })
  })
  const retried: number[] = []
  const restarted: number[] = []
  const harness: CaseRetryDeps['harness'] = {
    getTask: (async () => ({ state: { status: task === 'terminal' ? 'terminal' : 'running' } })) as never,
    inspect: (async () => ({
      scheduling: 'running',
      submissions: [],
      tasks: task === 'terminal' ? [] : [{ record: { id: 5 }, state: task === 'parked' ? { kind: 'blocked', reason: 'restart_limit' } : { kind: 'running' } }],
    })) as never,
    // Как в pi-durable: снятие с остановки — своя фиксация; задачу, которая не стоит, повтор не трогает.
    retryTask: async (id) => {
      await new Promise((resolve) => setTimeout(resolve, 5))
      if (task !== 'parked') return
      retried.push(Number(id))
      task = 'running'
    },
  }
  const treatment = {
    async restartIn(_tx: unknown, opened: Case) {
      restarted.push(opened.caseId)
      opened.treatmentTaskId = '6'
      opened.treatmentAttempt = (opened.treatmentAttempt ?? 1) + 1
      opened.state = 'triage'
      return opened.treatmentAttempt
    },
  } as unknown as Treatment
  const retryCase = createCaseRetry({ harness, records, ...(options.treatment === false ? {} : { treatment }), now: () => Date.parse('2026-10-26T10:00:00Z') })
  return { retryCase, records, retried, restarted, read: async () => (await records.read<Case>('case', '1'))! }
}

describe('повтор лечения случая', () => {
  it('задача остановлена после повторных падений → продолжается со своего чекпойнта, попытка та же', async () => {
    const w = await world('fixing', 'parked')

    expect(await w.retryCase(1, 'owner')).toEqual({ retried: 'parked', attempt: 1 })
    expect(w.retried).toEqual([5])
    expect(w.restarted).toEqual([])
    expect(await w.read()).toMatchObject({ retriedBy: 'owner', retriedAt: '2026-10-26T10:00:00.000Z', treatmentTaskId: '5' })
  })

  it('две команды повтора остановленной задачи сразу → одна ставит в работу, вторая получает already_running', async () => {
    const w = await world('fixing', 'parked')

    const answers = await Promise.all([w.retryCase(1, 'owner'), w.retryCase(1, 'second')])

    expect(answers).toContainEqual({ retried: 'parked', attempt: 1 })
    expect(answers).toContainEqual({ error: 'already_running', state: 'fixing' })
    expect(w.retried).toEqual([5])
    expect(await w.read()).toMatchObject({ retriedBy: 'owner' })
  })

  it('задача упала насовсем → новая попытка со своей задачей', async () => {
    const w = await world('fixing', 'terminal')

    expect(await w.retryCase(1, 'owner')).toEqual({ retried: 'restarted', attempt: 2 })
    expect(await w.read()).toMatchObject({ state: 'triage', treatmentTaskId: '6', treatmentAttempt: 2, retriedBy: 'owner' })
  })

  it('лечение идёт → already_running, ничего не трогается', async () => {
    const w = await world('diagnosing', 'running')

    expect(await w.retryCase(1, 'owner')).toEqual({ error: 'already_running', state: 'diagnosing' })
    expect([...w.retried, ...w.restarted]).toEqual([])
  })

  it('упала посреди выкатки или наблюдения → deploy_unfinished: вторая выкатка поверх первой не начинается', async () => {
    for (const state of ['deploying', 'observing'] as const) {
      const w = await world(state, 'terminal')
      expect(await w.retryCase(1, 'owner')).toEqual({ error: 'deploy_unfinished', state })
      expect(w.restarted).toEqual([])
    }
  })

  it('случай закончен → case_finished; незнакомый → unknown_case, и запись под него не появляется', async () => {
    const w = await world('healed', 'terminal')

    expect(await w.retryCase(1, 'owner')).toEqual({ error: 'case_finished', state: 'healed' })
    expect(await w.retryCase(2, 'owner')).toEqual({ error: 'unknown_case' })
    expect(await w.records.read('case', '2')).toBeUndefined()
  })

  it('лечения у врача нет → treatment_off', async () => {
    const w = await world('received', 'terminal', { treatment: false })

    expect(await w.retryCase(1, 'owner')).toEqual({ error: 'treatment_off', state: 'received' })
  })
})
