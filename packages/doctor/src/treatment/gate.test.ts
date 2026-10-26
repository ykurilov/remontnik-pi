import { describe, expect, it } from 'vitest'
import type { ChangedFile } from '../changed-files/index.js'
import type { ChecksResult } from '../checks/index.js'
import { decideDeploy } from '../deploy-gate/index.js'
import { testRemontnikConfig } from '../testing/config.js'
import { agentChatSdkPackage, closingOf, deployFactsOf, fixCanBeChecked, inspectFix, noDeployControls } from './gate.js'
import { deployAttemptsOf } from '../ledgers/fingerprint-ledger.js'
import { emptySpendDay } from '../ledgers/spend-ledger.js'

// Фаза `gated`: факты правки собирает код, решает `decideDeploy`, итог случая выбирается по решению.

const config = testRemontnikConfig()

function file(path: string, patch = '@@ -1 +1 @@\n-old\n+new\n', status: ChangedFile['status'] = 'modified'): ChangedFile {
  return { path, status, added: 1, removed: status === 'added' ? 0 : 1, patch }
}

const noAttempts = deployAttemptsOf(undefined, { fingerprint: 'fp', now: 0, timeZone: 'UTC', limits: config.limits })

const appIncident = { where: 'src/price.ts:5:3', stack: 'Error: x\n    at price (src/price.ts:5:3)' }
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
  return deployFactsOf({ inspection: inspectFix(config, files, appIncident, []), checks: result, controls: noDeployControls(), attempts: noAttempts, spendDay: day, limits: config.limits })
}

describe('осмотр правки: одно место для фактов о диффе', () => {
  it('правка в src с новым тестом — чистая, её можно проверять', () => {
    const inspection = inspectFix(config, fixInSrc, appIncident, [])
    expect(inspection.forbiddenZones).toEqual([])
    expect(inspection.protectedChanges).toEqual([])
    expect(inspection.diff.suspicious).toEqual([])
    expect(fixCanBeChecked(inspection)).toBe(true)
  })

  it('правка в оплате — запретная зона, но проверять её можно: человеку нужна проверенная правка', () => {
    const inspection = inspectFix(config, [file('src/payments/charge.ts')], appIncident, [])
    expect(inspection.forbiddenZones.map((hit) => hit.zone)).toEqual(['money'])
    expect(fixCanBeChecked(inspection)).toBe(true)
  })

  it('изменён существующий тест — проверять нельзя: модель подделала бы собственную проверку', () => {
    const inspection = inspectFix(config, [file('src/price.ts'), file('test/price.test.ts')], appIncident, [])
    expect(inspection.diff.existingTestChanges.map((change) => change.path)).toEqual(['test/price.test.ts'])
    expect(fixCanBeChecked(inspection)).toBe(false)
  })

  it('подозрительный код — проверять нельзя', () => {
    const inspection = inspectFix(config, [file('src/price.ts', '@@ -1 +1 @@\n-a\n+const key = process.env.SECRET\n')], appIncident, [])
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
    expect(result.spend).toEqual({ modelUsd: 5, modelLimitUsd: config.limits.doctorModelUsdPerDay, evalUsd: 0.4, evalLimitUsd: config.limits.evalUsdPerDay })
    expect(decideDeploy(result).reasons.map((reason) => reason.code)).toEqual(['budget_exhausted'])
  })

  it('до этапа выкатки: стоп-крана нет, перенос не нужен', () => {
    expect(noDeployControls()).toEqual({ stopSwitch: false, rebase: 'clean' })
  })

  it('попытки выкатки — из учёта по отпечатку: после отката нужен человек', () => {
    const now = Date.UTC(2026, 10, 2, 12)
    const ledger = {
      fingerprints: { fp: { autoDeploys: [{ at: new Date(now - 3_600_000).toISOString(), deploymentId: 1 }], needsHuman: true } },
      deploysToday: { day: '2026-11-02', count: 1 },
    }
    const attempts = deployAttemptsOf(ledger, { fingerprint: 'fp', now, timeZone: 'UTC', limits: config.limits })
    const result = deployFactsOf({ inspection: inspectFix(config, fixInSrc, appIncident, []), checks: checks(), controls: noDeployControls(), attempts, spendDay: emptySpendDay(), limits: config.limits })
    expect(result.attempts).toMatchObject({ autoDeploysForFingerprint: 1, autoDeploysToday: 1, needsHumanAfterRollback: true })
    expect(decideDeploy(result).reasons.map((reason) => reason.code)).toEqual(['needs_human_after_rollback'])
  })
})

describe('причина в Agent Chat SDK', () => {
  const diagnosis = { found: true, cause: 'SDK теряет ход', evidence: [], confidence: 'high' as const }

  const appStack = 'Error: x\n    at price (src/price.ts:5:3)'

  it('диагноз называет пакет SDK → его имя', () => {
    expect(agentChatSdkPackage({ ...diagnosis, causeInPackage: '@ykurilov/agent-chat-core' })).toBe('@ykurilov/agent-chat-core')
  })

  it('другой пакет или пакет не назван → не SDK', () => {
    expect(agentChatSdkPackage({ ...diagnosis, causeInPackage: 'left-pad' })).toBeUndefined()
    expect(agentChatSdkPackage(diagnosis)).toBeUndefined()
  })

  it.each([' @ykurilov/agent-chat-core', '@ykurilov/agent-chat-core/dist', '@ykurilov/agent-chat-*', '@ykurilov/Agent-Chat-core', '@ykurilov/agent-chat-', 'agent-chat-core'])(
    'имя пакета не по форме @ykurilov/agent-chat-<имя> (%j) — как будто не назван',
    (named) => {
      expect(agentChatSdkPackage({ ...diagnosis, causeInPackage: named })).toBeUndefined()
    },
  )

  it('правка лезет в SDK (патч пакета) → SDK, даже если диагноз его не назвал', () => {
    const inspection = inspectFix(config, [file('patches/@ykurilov+agent-chat-server+1.2.0.patch', '@@ -0,0 +1 @@\n+x\n', 'added')], { where: 'src/price.ts:5', stack: appStack }, [])
    expect(agentChatSdkPackage(diagnosis, inspection)).toBe('@ykurilov/agent-chat-server')
  })

  it.each([
    ['верхний кадр стека в node_modules SDK', 'src/bot/bot.ts:40', 'Error: lost\n    at finishTurn (node_modules/@ykurilov/agent-chat-core/dist/turn.js:88:11)\n    at reply (src/bot/bot.ts:40:7)'],
    ['верхний кадр в пакете SDK у pnpm', 'src/bot/bot.ts:40', 'Error: lost\n    at /srv/app/node_modules/.pnpm/@ykurilov+agent-chat-core@1.4.0/node_modules/@ykurilov/agent-chat-core/dist/turn.js:88:11'],
    ['место сбоя в SDK', 'node_modules/@ykurilov/agent-chat-core/dist/turn.js:88:11', ''],
  ])('%s, модель пакет не назвала → SDK по стеку; выкатки нет без человека', (_what, where, stack) => {
    const inspection = inspectFix(config, fixInSrc, { where, stack }, [])
    expect(agentChatSdkPackage(diagnosis, inspection)).toBe('@ykurilov/agent-chat-core')
    const decision = decideDeploy(deployFactsOf({ inspection, checks: checks(), controls: noDeployControls(), attempts: noAttempts, spendDay: emptySpendDay(), limits: config.limits }))
    expect(decision.verdict).toBe('report_only')
    expect(decision.reasons.map((reason) => reason.code)).toEqual(['forbidden_zone'])
    expect(closingOf(decision, checks()).kind).toBe('needs_human')
  })

  it('SDK только глубже в стеке, сбой в коде приложения → не SDK, выкатка возможна', () => {
    const inspection = inspectFix(config, fixInSrc, {
      where: 'src/bot/bot.ts:40:7',
      stack: 'Error: x\n    at reply (src/bot/bot.ts:40:7)\n    at runTurn (node_modules/@ykurilov/agent-chat-core/dist/turn.js:12:3)',
    }, [])
    expect(agentChatSdkPackage(diagnosis, inspection)).toBeUndefined()
    expect(inspection.forbiddenZones).toEqual([])
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
