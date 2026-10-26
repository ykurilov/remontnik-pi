import { describe, expect, it } from 'vitest'
import type { DiffInspection } from '../diff-inspector/index.js'
import type { ForbiddenZoneHit } from '../forbidden-zones/index.js'
import { decideDeploy, type DeployFacts, type GateReasonCode } from './index.js'

const cleanDiff: DiffInspection = {
  existingTestChanges: [],
  suspicious: [],
  size: { files: 2, lines: 40, exceeds: [] },
}

function greenFacts(): DeployFacts {
  return {
    tests: { status: 'green', failed: [] },
    eval: { status: 'not_worse', worseScenarios: [] },
    forbiddenZones: [],
    diff: cleanDiff,
    stopSwitch: false,
    attempts: {
      autoDeploysForFingerprint: 0,
      maxPerFingerprintPerDay: 2,
      autoDeploysToday: 0,
      maxPerDay: 5,
      needsHumanAfterRollback: false,
    },
    spend: { modelUsd: 1, modelLimitUsd: 5, evalUsd: 1, evalLimitUsd: 5 },
    rebase: 'clean',
  }
}

function codesOf(facts: DeployFacts): GateReasonCode[] {
  return decideDeploy(facts).reasons.map((reason) => reason.code)
}

const moneyHit: ForbiddenZoneHit = { path: 'src/payments/charge.ts', zone: 'money', rule: 'src/payments/**' }

describe('decideDeploy: всё зелёное', () => {
  it('выкатывает', () => {
    expect(decideDeploy(greenFacts())).toEqual({ verdict: 'deploy', reasons: [] })
  })

  it('eval не нужен (правка вне области сценариев) — тоже выкатывает', () => {
    const facts = { ...greenFacts(), eval: { status: 'not_needed' as const, worseScenarios: [] } }
    expect(decideDeploy(facts).verdict).toBe('deploy')
  })

  it('значения ровно под потолками — выкатывает', () => {
    const facts = greenFacts()
    facts.attempts.autoDeploysForFingerprint = 1
    facts.attempts.autoDeploysToday = 4
    facts.spend.modelUsd = 4.99
    expect(decideDeploy(facts).verdict).toBe('deploy')
  })
})

describe('decideDeploy: каждая причина даёт report_only', () => {
  const cases: Array<[GateReasonCode, string, (facts: DeployFacts) => void]> = [
    ['tests_not_green', 'тесты красные', (f) => void (f.tests = { status: 'red', failed: ['greeting.test.ts'] })],
    ['tests_not_green', 'тесты нестабильны', (f) => void (f.tests = { status: 'flaky', failed: ['greeting.test.ts'] })],
    ['tests_not_green', 'тесты не запускались', (f) => void (f.tests = { status: 'not_run', failed: [] })],
    ['eval_worse', 'eval хуже основы', (f) => void (f.eval = { status: 'worse', worseScenarios: ['greeting'] })],
    ['eval_worse', 'стенд eval сломан', (f) => void (f.eval = { status: 'stand_broken', worseScenarios: [] })],
    ['eval_worse', 'eval не запускался, хотя должен', (f) => void (f.eval = { status: 'not_run', worseScenarios: [] })],
    ['forbidden_zone', 'запретная зона', (f) => void (f.forbiddenZones = [moneyHit])],
    [
      'existing_test_changed',
      'изменён существующий тест',
      (f) => void (f.diff = { ...cleanDiff, existingTestChanges: [{ path: 'src/a.test.ts', status: 'modified' }] }),
    ],
    [
      'suspicious_change',
      'подозрительная правка',
      (f) =>
        void (f.diff = {
          ...cleanDiff,
          suspicious: [{ path: 'src/a.ts', signal: 'environment_access', line: 'process.env.X' }],
        }),
    ],
    [
      'diff_too_large',
      'дифф больше предела',
      (f) => void (f.diff = { ...cleanDiff, size: { files: 3, lines: 301, exceeds: ['lines'] } }),
    ],
    ['stop_switch', 'стоп-кран включён', (f) => void (f.stopSwitch = true)],
    ['attempts_exhausted', 'лимит по отпечатку', (f) => void (f.attempts.autoDeploysForFingerprint = 2)],
    ['attempts_exhausted', 'лимит в сутки', (f) => void (f.attempts.autoDeploysToday = 5)],
    [
      'needs_human_after_rollback',
      'отпечаток помечен после отката',
      (f) => void (f.attempts.needsHumanAfterRollback = true),
    ],
    ['budget_exhausted', 'потолок расходов на модель', (f) => void (f.spend.modelUsd = 5)],
    ['budget_exhausted', 'потолок расходов на eval', (f) => void (f.spend.evalUsd = 5.5)],
    ['rebase_conflict', 'перенос правки дал конфликт', (f) => void (f.rebase = 'conflict')],
  ]

  it.each(cases)('%s: %s', (code, _title, break_) => {
    const facts = greenFacts()
    break_(facts)
    const decision = decideDeploy(facts)
    expect(decision.verdict).toBe('report_only')
    expect(decision.reasons.map((reason) => reason.code)).toEqual([code])
  })

  it('покрыты все коды из data-model', () => {
    const covered = new Set(cases.map(([code]) => code))
    expect([...covered].sort()).toEqual(
      [
        'tests_not_green',
        'eval_worse',
        'forbidden_zone',
        'existing_test_changed',
        'suspicious_change',
        'diff_too_large',
        'stop_switch',
        'attempts_exhausted',
        'needs_human_after_rollback',
        'budget_exhausted',
        'rebase_conflict',
      ].sort(),
    )
  })
})

describe('decideDeploy: подробности и несколько причин', () => {
  it('собирает все причины сразу, а не первую', () => {
    const facts = greenFacts()
    facts.tests = { status: 'red', failed: ['a.test.ts'] }
    facts.forbiddenZones = [moneyHit]
    facts.stopSwitch = true
    expect(codesOf(facts)).toEqual(['tests_not_green', 'forbidden_zone', 'stop_switch'])
  })

  it('запретная зона: пути и зоны в подробностях', () => {
    const facts = greenFacts()
    facts.forbiddenZones = [moneyHit, { path: 'src/auth/session.ts', zone: 'access', rule: 'src/auth/**' }]
    const [reason] = decideDeploy(facts).reasons
    expect(reason?.paths).toEqual(['src/payments/charge.ts', 'src/auth/session.ts'])
    expect(reason?.message).toContain('money')
    expect(reason?.message).toContain('access')
  })

  it('упавшие тесты и числа попадают в подробности', () => {
    const facts = greenFacts()
    facts.tests = { status: 'red', failed: ['a.test.ts', 'b.test.ts'] }
    facts.diff = { ...cleanDiff, size: { files: 20, lines: 450, exceeds: ['lines', 'files'] } }
    const reasons = decideDeploy(facts).reasons
    expect(reasons.find((reason) => reason.code === 'tests_not_green')?.paths).toEqual(['a.test.ts', 'b.test.ts'])
    expect(reasons.find((reason) => reason.code === 'diff_too_large')?.numbers).toEqual({ files: 20, lines: 450 })
  })

  it('подозрительные находки несут пути', () => {
    const facts = greenFacts()
    facts.diff = {
      ...cleanDiff,
      suspicious: [
        { path: 'src/a.ts', signal: 'process_spawn', line: 'exec()' },
        { path: 'src/b.ts', signal: 'dynamic_code', line: 'eval(x)' },
      ],
    }
    expect(decideDeploy(facts).reasons[0]?.paths).toEqual(['src/a.ts', 'src/b.ts'])
  })

  it('функция чистая: входные факты не меняются', () => {
    const facts = greenFacts()
    facts.tests = { status: 'red', failed: ['a.test.ts'] }
    const before = structuredClone(facts)
    decideDeploy(facts)
    expect(facts).toEqual(before)
  })
})
