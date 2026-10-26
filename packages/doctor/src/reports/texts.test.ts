import { describe, expect, it } from 'vitest'
import type { ChecksResult } from '../checks/index.js'
import { causeFoundReport, fixReadyReport, noCauseFoundReport, standBrokenReport } from './texts.js'

const sick = { caseId: 7, appName: 'patient', kind: 'tool_error' as const, where: 'src/bot/tools.ts', message: 'orders storage timeout' }
const diagnosis = {
  found: true,
  cause: 'Тариф по умолчанию указывает на несуществующий id',
  evidence: ['src/bot/plans.ts: DEFAULT_PLAN_ID = "starter"', 'findPlanById вернул undefined'],
  confidence: 'high' as const,
}
const fix = { summary: 'Вернул id тарифа по умолчанию', testsAdded: ['test/default-plan.test.ts'] }
const green: ChecksResult = {
  tests: { status: 'green', failed: [], durationMs: 1200 },
  eval: { status: 'not_worse', scenarios: [{ id: 'greeting', basePass: 3, candidatePass: 3, repeats: 3 }], costUsd: 0.12 },
}

describe('тексты отчётов лечения', () => {
  it('fix_ready: ветка, проверки и что выкатки не было', () => {
    const text = fixReadyReport({ case: sick, diagnosis, fix, branch: 'remontnik/7-orders', commit: 'abc1234def', checks: green, pushed: true })
    expect(text.short).toContain('Случай 7')
    expect(text.short).toContain('remontnik/7-orders')
    expect(text.short).toContain('тесты зелёные')
    expect(text.short).toContain('не выкатывал')
    expect(text.full).toContain(diagnosis.cause)
    expect(text.full).toContain('test/default-plan.test.ts')
    expect(text.full).toContain('greeting: 3/3 → 3/3')
  })

  it('fix_ready с eval хуже: какие сценарии ухудшились', () => {
    const worse: ChecksResult = {
      tests: green.tests,
      eval: {
        status: 'worse',
        scenarios: [
          { id: 'price-named-plan', basePass: 3, candidatePass: 0, repeats: 3 },
          { id: 'greeting', basePass: 3, candidatePass: 3, repeats: 3 },
        ],
        costUsd: 0,
      },
    }
    const text = fixReadyReport({ case: sick, diagnosis, fix, branch: 'remontnik/7-orders', commit: 'abc1234', checks: worse, pushed: true })
    expect(text.short).toContain('eval хуже')
    expect(text.short).toContain('price-named-plan')
    expect(text.short).not.toContain('greeting')
    expect(text.full).toContain('price-named-plan: 3/3 → 0/3')
  })

  it('fix_ready, ветка не отправлена: так и сказано', () => {
    const text = fixReadyReport({ case: sick, diagnosis, fix, branch: 'remontnik/7-orders', commit: 'abc1234', checks: green, pushed: false })
    expect(text.short).toContain('не отправлена')
  })

  it('no_cause_found по бюджету: сколько потрачено и что успел найти', () => {
    const text = noCauseFoundReport({ case: sick, reason: 'budget', spentUsd: 0.6, limitUsd: 0.5, diagnosis: { ...diagnosis, found: false } })
    expect(text.short).toContain('не нашёл')
    expect(text.short).toContain('бюджет')
    expect(text.short).toContain('$0.60 из $0.50')
    expect(text.full).toContain('findPlanById вернул undefined')
  })

  it('no_cause_found без находок', () => {
    const text = noCauseFoundReport({ case: sick, reason: 'no_answer', spentUsd: 0, limitUsd: 1 })
    expect(text.short).toContain('не нашёл')
    expect(text.full).toContain('модель не дала диагноза')
  })

  it('cause_found: правка не прошла тесты — какие', () => {
    const red: ChecksResult = { tests: { status: 'red', failed: ['plans › default'], durationMs: 10 }, eval: { status: 'not_run', scenarios: [], costUsd: 0 } }
    const text = causeFoundReport({ case: sick, diagnosis, reason: 'checks_red', branch: 'remontnik/7-orders', checks: red })
    expect(text.short).toContain('причину нашёл')
    expect(text.short).toContain('plans › default')
  })

  it('cause_found: правки нет', () => {
    const text = causeFoundReport({ case: sick, diagnosis, reason: 'no_changes' })
    expect(text.short).toContain('правку не сделал')
    expect(text.full).toContain(diagnosis.cause)
  })

  it('stand_broken: стенд проверки сломан', () => {
    const broken: ChecksResult = { tests: green.tests, eval: { status: 'stand_broken', scenarios: [], costUsd: 0, note: 'нет итога eval' } }
    const text = standBrokenReport({ case: sick, branch: 'remontnik/7-orders', checks: broken })
    expect(text.short).toContain('стенд')
    expect(text.full).toContain('нет итога eval')
  })
})
