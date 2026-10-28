import { describe, expect, it } from 'vitest'
import type { Case, CaseState } from '../case-book/index.js'
import type { CaseSpend } from '../ledgers/spend-ledger.js'
import { createMemoryRecordStore } from '../records/index.js'
import type { Treatment } from '../treatment/index.js'
import { createCaseRetry, type CaseRetryDeps } from './case-retry.js'

// Повтор лечения по команде владельца: остановленная после повторных падений задача продолжается сама, упавшая —
// заменяется новой попыткой; случай, закончившийся без излечения, лечится новой попыткой со своим потолком расходов.
// Закрытый случай, идущее лечение и незаконченная выкатка не трогаются.

type TaskView = 'terminal' | 'parked' | 'running'

interface WorldOptions {
  treatment?: boolean
  /** Ещё поля случая: итог прошлой попытки, номер задачи моста. */
  sick?: Partial<Case>
  onTaskCheck?: (records: ReturnType<typeof createMemoryRecordStore>) => Promise<void>
}

async function world(state: CaseState, initial: TaskView, options: WorldOptions = {}) {
  let task = initial
  const records = createMemoryRecordStore()
  await records.transaction(async (tx) => {
    const opened = await tx.doc<Case>('case', '1', {} as Case)
    Object.assign(opened, { caseId: 1, appName: 'app', fingerprint: 'f', state, treatmentTaskId: '5', reportIds: [] }, options.sick)
    ;(await tx.doc<CaseSpend>('spend-case', '1', { modelUsd: 0 })).modelUsd = 0.7
  })
  const retried: number[] = []
  const restarted: number[] = []
  const harness: CaseRetryDeps['harness'] = {
    // Задача 5 — прежнее лечение случая; задачи новых попыток идут.
    getTask: (async (id: number) => {
      await options.onTaskCheck?.(records)
      return { state: { status: id === 5 && task === 'terminal' ? 'terminal' : 'running' } }
    }) as never,
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
      delete opened.lastOutcome
      return opened.treatmentAttempt
    },
  } as unknown as Treatment
  const retryCase = createCaseRetry({ harness, records, ...(options.treatment === false ? {} : { treatment }), now: () => Date.parse('2026-10-26T10:00:00Z') })
  return {
    retryCase,
    records,
    retried,
    restarted,
    read: async () => (await records.read<Case>('case', '1'))!,
    spend: async () => (await records.read<CaseSpend>('spend-case', '1'))!,
  }
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

  it('задача упала насовсем → новая попытка со своей задачей; потолок случая общий с прежней попыткой', async () => {
    const w = await world('fixing', 'terminal')

    expect(await w.retryCase(1, 'owner')).toEqual({ retried: 'restarted', attempt: 2 })
    expect(await w.read()).toMatchObject({ state: 'triage', treatmentTaskId: '6', treatmentAttempt: 2, retriedBy: 'owner' })
    expect((await w.spend()).budgetFromUsd).toBeUndefined()
  })

  it('случай закончился без излечения (только отчёт, причина не найдена и др.) → новая попытка со своим потолком расходов', async () => {
    for (const state of ['report_only', 'no_cause_found', 'stand_broken', 'needs_human', 'not_helped'] as const) {
      const w = await world(state, 'terminal')

      expect(await w.retryCase(1, 'owner'), state).toEqual({ retried: 'restarted', attempt: 2 })
      expect(await w.read()).toMatchObject({ state: 'triage', treatmentTaskId: '6', treatmentAttempt: 2, retriedBy: 'owner' })
      expect((await w.spend()).budgetFromUsd).toBeCloseTo(0.7)
    }
  })

  it('две команды повтора законченного случая сразу → одна новая попытка, вторая получает already_running', async () => {
    const w = await world('report_only', 'terminal')

    const answers = await Promise.all([w.retryCase(1, 'owner'), w.retryCase(1, 'second')])

    expect(answers).toContainEqual({ retried: 'restarted', attempt: 2 })
    expect(answers).toContainEqual({ error: 'already_running', state: 'triage' })
    expect(w.restarted).toEqual([1])
  })

  it('пока проверялась задача, случай сдвинулся (поздняя выкатка агента взята под наблюдение) → already_running, новой попытки нет', async () => {
    const w = await world('report_only', 'terminal', {
      async onTaskCheck(records) {
        await records.transaction(async (tx) => {
          const opened = await tx.doc<Case>('case', '1', {} as Case)
          if (opened.state !== 'report_only') return
          Object.assign(opened, { state: 'observing', treatmentTaskId: '7', treatmentAttempt: 2 })
        })
      },
    })

    expect(await w.retryCase(1, 'owner')).toEqual({ error: 'already_running', state: 'observing' })
    expect(w.restarted).toEqual([])
    expect((await w.spend()).budgetFromUsd).toBeUndefined()
  })

  it('случай у агента Paseo: задача остановлена → продолжается; ждёт агента → already_running', async () => {
    for (const state of ['handoff_check', 'handed_off', 'paseo_working', 'reclaimed'] as const) {
      const parked = await world(state, 'parked')
      expect(await parked.retryCase(1, 'owner'), state).toEqual({ retried: 'parked', attempt: 1 })
      const running = await world(state, 'running')
      expect(await running.retryCase(1, 'owner'), state).toEqual({ error: 'already_running', state })
    }
  })

  it('случай у агента Paseo, задача упала насовсем → новая попытка: номер задачи моста в случае, второго агента не будет', async () => {
    for (const state of ['handoff_check', 'handed_off', 'paseo_working', 'reclaimed'] as const) {
      const w = await world(state, 'terminal', { sick: { handoffTaskId: 'T1' } })
      expect(await w.retryCase(1, 'owner'), state).toEqual({ retried: 'restarted', attempt: 2 })
      expect(await w.read()).toMatchObject({ state: 'triage', treatmentTaskId: '6', handoffTaskId: 'T1' })
      // Лечение не кончилось, а упало: потолок случая прежний.
      expect((await w.spend()).budgetFromUsd).toBeUndefined()
    }
  })

  it('передача упала, номер задачи моста помнила только задача (врач до обновления) → handoff_unconfirmed; с force — новая попытка', async () => {
    const w = await world('handoff_check', 'terminal')

    const refused = await w.retryCase(1, 'owner')
    expect(refused).toMatchObject({ error: 'handoff_unconfirmed', state: 'handoff_check' })
    expect('hint' in refused && refused.hint).toContain('remontnik-doctor case 1 retry --force')
    expect(w.restarted).toEqual([])

    expect(await w.retryCase(1, 'owner', { force: true })).toEqual({ retried: 'restarted', attempt: 2 })
    // Задача остальных состояний Paseo без номера в случае: документ передачи уже записан, номер в нём.
    for (const state of ['handed_off', 'paseo_working', 'reclaimed'] as const) {
      expect(await (await world(state, 'terminal')).retryCase(1, 'owner'), state).toEqual({ retried: 'restarted', attempt: 2 })
    }
  })

  it('правка готова (fix_ready) → отказ с веткой и командой; с force — новая попытка, ответ называет прежнюю ветку', async () => {
    const sick = { lastOutcome: { outcome: 'fix_ready', branch: 'remontnik/1-price' } }
    const w = await world('report_only', 'terminal', { sick })

    const refused = await w.retryCase(1, 'owner')
    expect(refused).toMatchObject({ error: 'fix_ready', state: 'report_only', branch: 'remontnik/1-price' })
    expect('hint' in refused && refused.hint).toContain('remontnik-doctor case 1 retry --force')
    expect(w.restarted).toEqual([])
    expect((await w.spend()).budgetFromUsd).toBeUndefined()

    expect(await w.retryCase(1, 'owner', { force: true })).toEqual({ retried: 'restarted', attempt: 2, previousBranch: 'remontnik/1-price' })
    expect((await w.spend()).budgetFromUsd).toBeCloseTo(0.7)
    expect((await w.read()).lastOutcome).toBeUndefined()
  })

  it('после выкатки нужен человек (откат не удался, выкатка брошена, человек выкатил своё) → deploy_needs_human; с force — новая попытка', async () => {
    const w = await world('needs_human', 'terminal', { sick: { lastOutcome: { outcome: 'needs_human', why: 'deploy', branch: 'remontnik/1-price' } } })

    const refused = await w.retryCase(1, 'owner')
    expect(refused).toMatchObject({ error: 'deploy_needs_human', state: 'needs_human' })
    expect('hint' in refused && refused.hint).toContain('какая версия работает')
    expect(w.restarted).toEqual([])

    expect(await w.retryCase(1, 'owner', { force: true })).toEqual({ retried: 'restarted', attempt: 2, previousBranch: 'remontnik/1-price' })
    // Человек нужен по другой причине (правку не пропустили проверки) → согласия не нужно.
    const gate = await world('needs_human', 'terminal', { sick: { lastOutcome: { outcome: 'needs_human', why: 'gate' } } })
    expect(await gate.retryCase(1, 'owner')).toEqual({ retried: 'restarted', attempt: 2 })
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

  it('случай закрыт (вылечен или откачен) → case_finished; незнакомый → unknown_case, и запись под него не появляется', async () => {
    for (const state of ['healed', 'healed_by_paseo', 'rolled_back'] as const) {
      const w = await world(state, 'terminal')
      expect(await w.retryCase(1, 'owner')).toEqual({ error: 'case_finished', state })
      expect(w.restarted).toEqual([])
    }
    const w = await world('healed', 'terminal')
    expect(await w.retryCase(2, 'owner')).toEqual({ error: 'unknown_case' })
    expect(await w.records.read('case', '2')).toBeUndefined()
  })

  it('лечения у врача нет → treatment_off', async () => {
    const w = await world('received', 'terminal', { treatment: false })

    expect(await w.retryCase(1, 'owner')).toEqual({ error: 'treatment_off', state: 'received' })
  })
})
