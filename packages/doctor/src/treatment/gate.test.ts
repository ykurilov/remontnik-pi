import { describe, expect, it } from 'vitest'
import type { ChangedFile } from '../changed-files/index.js'
import type { ChecksResult } from '../checks/index.js'
import { decideDeploy } from '../deploy-gate/index.js'
import { testRemontnikConfig } from '../testing/config.js'
import { agentChatSdkPackage, closingOf, deployFactsOf, fixCanBeChecked, inspectFix, noDeploysYet } from './gate.js'
import { emptySpendDay } from './spend.js'

// Фаза `gated`: факты правки собирает код, решает `decideDeploy`, итог случая выбирается по решению.

const config = testRemontnikConfig()

function file(path: string, patch = '@@ -1 +1 @@\n-old\n+new\n', status: ChangedFile['status'] = 'modified'): ChangedFile {
  return { path, status, added: 1, removed: status === 'added' ? 0 : 1, patch }
}

const fixInSrc = [file('src/price.ts'), file('test/default-plan.test.ts', '@@ -0,0 +1 @@\n+test\n', 'added')]

function checks(overrides: { tests?: Partial<ChecksResult['tests']>; eval?: Partial<ChecksResult['eval']> } = {}): ChecksResult {
  return {
    tests: { status: 'green', failed: [], durationMs: 1000, ...overrides.tests },
    eval: { status: 'not_worse', scenarios: [{ id: 'greeting', basePass: 2, candidatePass: 2, repeats: 2 }], costUsd: 0.1, ...overrides.eval },
  }
}

function facts(files: ChangedFile[], ...rest: [result?: ChecksResult | undefined, day?: ReturnType<typeof emptySpendDay>]) {
  const result = rest.length > 0 ? rest[0] : checks()
  const day = rest[1] ?? emptySpendDay()
  return deployFactsOf({ inspection: inspectFix(config, files), checks: result, controls: noDeploysYet(config), spendDay: day, limits: config.limits })
}

describe('осмотр правки: одно место для фактов о диффе', () => {
  it('правка в src с новым тестом — чистая, её можно проверять', () => {
    const inspection = inspectFix(config, fixInSrc)
    expect(inspection.forbiddenZones).toEqual([])
    expect(inspection.protectedChanges).toEqual([])
    expect(inspection.diff.suspicious).toEqual([])
    expect(fixCanBeChecked(inspection)).toBe(true)
  })

  it('правка в оплате — запретная зона, но проверять её можно: человеку нужна проверенная правка', () => {
    const inspection = inspectFix(config, [file('src/payments/charge.ts')])
    expect(inspection.forbiddenZones.map((hit) => hit.zone)).toEqual(['money'])
    expect(fixCanBeChecked(inspection)).toBe(true)
  })

  it('изменён существующий тест — проверять нельзя: модель подделала бы собственную проверку', () => {
    const inspection = inspectFix(config, [file('src/price.ts'), file('test/price.test.ts')])
    expect(inspection.diff.existingTestChanges.map((change) => change.path)).toEqual(['test/price.test.ts'])
    expect(fixCanBeChecked(inspection)).toBe(false)
  })

  it('подозрительный код — проверять нельзя', () => {
    const inspection = inspectFix(config, [file('src/price.ts', '@@ -1 +1 @@\n-a\n+const key = process.env.SECRET\n')])
    expect(inspection.diff.suspicious.map((finding) => finding.signal)).toContain('environment_access')
    expect(fixCanBeChecked(inspection)).toBe(false)
  })
})

describe('факты для decideDeploy', () => {
  it('зелёная правка вне зон без выкаток и расходов → deploy', () => {
    expect(decideDeploy(facts(fixInSrc))).toEqual({ verdict: 'deploy', reasons: [] })
  })

  it('проверок не было → тесты и eval «не запускались»', () => {
    const result = facts([file('src/price.ts'), file('test/price.test.ts')], undefined)
    expect(result.tests).toEqual({ status: 'not_run', failed: [] })
    expect(result.eval).toEqual({ status: 'not_run', worseScenarios: [] })
  })

  it('eval хуже → в фактах только ухудшившиеся сценарии', () => {
    const worse = checks({
      eval: {
        status: 'worse',
        scenarios: [
          { id: 'price-named-plan', basePass: 2, candidatePass: 0, repeats: 2 },
          { id: 'price-default-plan', basePass: 0, candidatePass: 2, repeats: 2 },
        ],
      },
    })
    expect(facts(fixInSrc, worse).eval).toEqual({ status: 'worse', worseScenarios: ['price-named-plan'] })
  })

  it('каждый путь — под своей самой точной причиной: тест не повторяется в «защищённых путях»', () => {
    const decision = decideDeploy(facts([file('src/price.ts'), file('test/price.test.ts'), file('scripts/fix.ts')], undefined))
    expect(decision.reasons.find((reason) => reason.code === 'existing_test_changed')?.paths).toEqual(['test/price.test.ts'])
    expect(decision.reasons.find((reason) => reason.code === 'protected_path')?.paths).toEqual(['scripts/fix.ts'])
  })

  it('дневной расход — из учёта, потолки — из настройки', () => {
    const day = emptySpendDay()
    day.model['1'] = 3
    day.model['2'] = 2
    day.eval['case-1-0'] = { reservedUsd: 1, actualUsd: 0.4 }
    const result = facts(fixInSrc, checks(), day)
    expect(result.spend).toEqual({ modelUsd: 5, modelLimitUsd: config.limits.modelUsdPerDay, evalUsd: 0.4, evalLimitUsd: config.limits.evalUsdPerDay })
    expect(decideDeploy(result).reasons.map((reason) => reason.code)).toEqual(['budget_exhausted'])
  })

  it('до этапа выкатки: стоп-крана нет, выкаток не было, лимиты из настройки', () => {
    expect(noDeploysYet(config)).toEqual({
      stopSwitch: false,
      attempts: {
        autoDeploysForFingerprint: 0,
        maxPerFingerprintPerDay: config.limits.autoDeploysPerFingerprintPerDay,
        autoDeploysToday: 0,
        maxPerDay: config.limits.autoDeploysPerDay,
        needsHumanAfterRollback: false,
      },
      rebase: 'clean',
    })
  })
})

describe('причина в Agent Chat SDK', () => {
  const diagnosis = { found: true, cause: 'SDK теряет ход', evidence: [], confidence: 'high' as const }

  it('диагноз называет пакет SDK → его имя', () => {
    expect(agentChatSdkPackage(config, { ...diagnosis, causeInPackage: '@ykurilov/agent-chat-core' })).toBe('@ykurilov/agent-chat-core')
  })

  it('другой пакет или пакет не назван → не SDK', () => {
    expect(agentChatSdkPackage(config, { ...diagnosis, causeInPackage: 'left-pad' })).toBeUndefined()
    expect(agentChatSdkPackage(config, diagnosis)).toBeUndefined()
  })

  it('правка лезет в SDK (патч пакета) → SDK, даже если диагноз его не назвал', () => {
    const inspection = inspectFix(config, [file('patches/@ykurilov+agent-chat-server+1.2.0.patch', '@@ -0,0 +1 @@\n+x\n', 'added')])
    expect(agentChatSdkPackage(config, diagnosis, inspection)).toBe('@ykurilov/agent-chat-server')
  })
})

describe('итог фазы gated', () => {
  it('deploy → правка готова (до этапа выкатки — только отчёт)', () => {
    expect(closingOf(decideDeploy(facts(fixInSrc)), checks())).toEqual({ kind: 'deploy', caseState: 'report_only', report: 'fix_ready' })
  })

  it('только красные тесты → причина найдена, правка не прошла тесты', () => {
    const red = checks({ tests: { status: 'red', failed: ['a.test.ts'] } })
    expect(closingOf(decideDeploy(facts(fixInSrc, red)), red)).toEqual({ kind: 'checks_red', caseState: 'report_only', report: 'cause_found' })
  })

  it('сломан стенд eval → stand_broken', () => {
    const broken = checks({ eval: { status: 'stand_broken', scenarios: [] } })
    expect(closingOf(decideDeploy(facts(fixInSrc, broken)), broken)).toEqual({ kind: 'stand_broken', caseState: 'stand_broken', report: 'stand_broken' })
  })

  it.each([
    ['запретная зона', [file('src/payments/charge.ts')], checks()],
    ['eval хуже', fixInSrc, checks({ eval: { status: 'worse', scenarios: [{ id: 'greeting', basePass: 2, candidatePass: 0, repeats: 2 }] } })],
    ['нестабильные тесты', fixInSrc, checks({ tests: { status: 'flaky', failed: ['a.test.ts'] } })],
    ['красные тесты и запретная зона', [file('src/payments/charge.ts')], checks({ tests: { status: 'red', failed: ['a.test.ts'] } })],
    ['изменён тест, проверок не было', [file('test/price.test.ts')], undefined],
  ])('%s → нужен человек', (_what, files, result) => {
    expect(closingOf(decideDeploy(facts(files, result)), result)).toEqual({ kind: 'needs_human', caseState: 'report_only', report: 'needs_human' })
  })

  it('только стоп-кран, лимиты или расходы → правка готова, но не выкачена', () => {
    const decision = decideDeploy({ ...facts(fixInSrc), stopSwitch: true })
    expect(closingOf(decision, checks())).toEqual({ kind: 'not_deployed', caseState: 'report_only', report: 'fix_ready' })
  })
})
