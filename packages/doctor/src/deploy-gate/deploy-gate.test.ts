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
    protectedChanges: [],
    diff: structuredClone(cleanDiff),
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
      'protected_path',
      'защищённый путь (вне путей правки, настройка тестов)',
      (f) => void (f.protectedChanges = [{ path: 'vitest.config.ts', why: 'настройка запуска тестов или файл eval' }]),
    ],
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
        'protected_path',
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

  it('защищённые пути: пути и почему в подробностях', () => {
    const facts = greenFacts()
    facts.protectedChanges = [
      { path: 'vitest.config.ts', why: 'настройка запуска тестов или файл eval' },
      { path: 'scripts/fix.ts', why: 'вне путей, которые можно править (src/**)' },
    ]
    const [reason] = decideDeploy(facts).reasons
    expect(reason?.paths).toEqual(['vitest.config.ts', 'scripts/fix.ts'])
    expect(reason?.message).toContain('vitest.config.ts: настройка запуска тестов')
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

describe('decideDeploy: нет данных или данные невозможны — нет выкатки', () => {
  const broken: Array<[string, (facts: DeployFacts) => void]> = [
    ['stopSwitch не задан', (f) => void ((f as unknown as Record<string, unknown>).stopSwitch = undefined)],
    ['stopSwitch — строка "false"', (f) => void ((f as unknown as Record<string, unknown>).stopSwitch = 'false')],
    ['rebase не задан', (f) => void ((f as unknown as Record<string, unknown>).rebase = undefined)],
    ['rebase — неизвестное слово', (f) => void ((f as unknown as Record<string, unknown>).rebase = 'maybe')],
    ['tests.status — неизвестное слово', (f) => void ((f.tests as unknown as Record<string, unknown>).status = 'passed')],
    ['tests.failed не список', (f) => void ((f.tests as unknown as Record<string, unknown>).failed = undefined)],
    ['eval.status — неизвестное слово', (f) => void ((f.eval as unknown as Record<string, unknown>).status = 'fine')],
    ['eval не задан', (f) => void ((f as unknown as Record<string, unknown>).eval = undefined)],
    ['forbiddenZones не список', (f) => void ((f as unknown as Record<string, unknown>).forbiddenZones = undefined)],
    ['protectedChanges не список', (f) => void ((f as unknown as Record<string, unknown>).protectedChanges = undefined)],
    ['diff не задан', (f) => void ((f as unknown as Record<string, unknown>).diff = undefined)],
    ['diff.existingTestChanges не список', (f) => void ((f.diff as unknown as Record<string, unknown>).existingTestChanges = undefined)],
    ['diff.suspicious не список', (f) => void ((f.diff as unknown as Record<string, unknown>).suspicious = null)],
    ['diff.size.exceeds не список', (f) => void ((f.diff.size as unknown as Record<string, unknown>).exceeds = undefined)],
    ['diff.size.exceeds с неизвестным словом', (f) => void ((f.diff.size as unknown as Record<string, unknown>).exceeds = ['huge'])],
    ['diff.size.files = 0 (пустая правка)', (f) => void (f.diff = { ...cleanDiff, size: { files: 0, lines: 0, exceeds: [] } })],
    ['diff.size.lines = NaN', (f) => void (f.diff = { ...cleanDiff, size: { files: 2, lines: Number.NaN, exceeds: [] } })],
    ['счётчик по отпечатку NaN', (f) => void (f.attempts.autoDeploysForFingerprint = Number.NaN)],
    ['счётчик за сутки undefined', (f) => void ((f.attempts as unknown as Record<string, unknown>).autoDeploysToday = undefined)],
    ['лимит по отпечатку NaN', (f) => void (f.attempts.maxPerFingerprintPerDay = Number.NaN)],
    ['лимит за сутки undefined', (f) => void ((f.attempts as unknown as Record<string, unknown>).maxPerDay = undefined)],
    ['счётчик отрицательный', (f) => void (f.attempts.autoDeploysToday = -1)],
    ['needsHumanAfterRollback не задан', (f) => void ((f.attempts as unknown as Record<string, unknown>).needsHumanAfterRollback = undefined)],
    ['attempts не задан', (f) => void ((f as unknown as Record<string, unknown>).attempts = undefined)],
    ['расход модели NaN', (f) => void (f.spend.modelUsd = Number.NaN)],
    ['расход eval undefined', (f) => void ((f.spend as unknown as Record<string, unknown>).evalUsd = undefined)],
    ['потолок модели Infinity', (f) => void (f.spend.modelLimitUsd = Number.POSITIVE_INFINITY)],
    ['потолок eval NaN', (f) => void (f.spend.evalLimitUsd = Number.NaN)],
    ['расход отрицательный', (f) => void (f.spend.modelUsd = -0.5)],
    ['spend не задан', (f) => void ((f as unknown as Record<string, unknown>).spend = undefined)],
  ]

  it.each(broken)('%s', (_name, break_) => {
    const facts = greenFacts()
    break_(facts)
    const decision = decideDeploy(facts)
    expect(decision.verdict).toBe('report_only')
    expect(decision.reasons.map((reason) => reason.code)).toEqual(['facts_invalid'])
  })

  it('причина называет, какие факты не годятся', () => {
    const facts = greenFacts()
    facts.spend.modelUsd = Number.NaN
    ;(facts as unknown as Record<string, unknown>).stopSwitch = undefined
    const [reason] = decideDeploy(facts).reasons
    expect(reason?.paths).toEqual(expect.arrayContaining(['spend.modelUsd', 'stopSwitch']))
  })

  it('факты — не объект: нет выкатки', () => {
    for (const facts of [undefined, null, 'ok', 42]) {
      expect(decideDeploy(facts as unknown as DeployFacts).verdict).toBe('report_only')
    }
  })

  it('«размер неизвестен» от осмотра диффа — это diff_too_large', () => {
    const facts = greenFacts()
    facts.diff = { ...cleanDiff, size: { files: 2, lines: 10, exceeds: ['unknown'] } }
    expect(codesOf(facts)).toEqual(['diff_too_large'])
  })

  it('нулевые лимиты и счётчики — не ошибка данных', () => {
    const facts = greenFacts()
    facts.attempts.autoDeploysToday = 0
    facts.spend.modelUsd = 0
    expect(decideDeploy(facts).verdict).toBe('deploy')
  })
})
