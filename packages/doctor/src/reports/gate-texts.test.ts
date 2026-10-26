import { describe, expect, it } from 'vitest'
import type { ChecksResult } from '../checks/index.js'
import type { GateDecision } from '../deploy-gate/index.js'
import { agentChatSdkReport, agentChatSdkTask, gateReport } from './gate-texts.js'

const sick = { caseId: 7, appName: 'patient', kind: 'crash' as const, where: 'src/payments/charge.ts:15', message: 'kopecks of undefined' }
const diagnosis = { found: true, cause: 'Сумма в копейках берётся у undefined', evidence: ['src/payments/charge.ts:15'], confidence: 'high' as const }
const fix = { summary: 'Сумма считается от цены тарифа', testsAdded: ['test/charge.test.ts'] }
const green: ChecksResult = {
  tests: { status: 'green', failed: [], durationMs: 1200 },
  eval: { status: 'not_worse', scenarios: [{ id: 'greeting', basePass: 3, candidatePass: 3, repeats: 3 }], costUsd: 0.12 },
}
const money: GateDecision = {
  verdict: 'report_only',
  reasons: [{ code: 'forbidden_zone', message: 'Выкатки нет: правка затрагивает запретные зоны (money). Нужен человек.', paths: ['src/payments/charge.ts'] }],
}

describe('отчёт решения о выкатке', () => {
  it('запретная зона после зелёных проверок: что не выкачено, почему, где правка и как её проверили', () => {
    const text = gateReport({ case: sick, diagnosis, fix, branch: 'remontnik/7-charge', commit: 'abc1234def', pushed: true, checks: green, decision: money })
    expect(text.short).toContain('Случай 7')
    expect(text.short).toContain('remontnik/7-charge')
    expect(text.short).toContain('запретная зона')
    expect(text.short).toContain('Нужен человек')
    expect(text.full).toContain('правка затрагивает запретные зоны (money)')
    expect(text.full).toContain('- src/payments/charge.ts')
    expect(text.full).toContain(diagnosis.cause)
    expect(text.full).toContain(fix.summary)
    expect(text.full).toContain('greeting: 3/3 → 3/3')
  })

  it('правка без проверок (изменён тест): сказано, что не проверял и не отправлял', () => {
    const decision: GateDecision = {
      verdict: 'report_only',
      reasons: [
        { code: 'tests_not_green', message: 'Выкатки нет: тесты не запускались.', paths: [] },
        { code: 'existing_test_changed', message: 'Выкатки нет: правка меняет или удаляет существующие тесты.', paths: ['test/bot.test.ts'] },
      ],
    }
    const text = gateReport({ case: sick, diagnosis, fix, branch: 'remontnik/7-charge', commit: 'abc1234def', pushed: false, decision })
    expect(text.short).toContain('не проверял и не отправлял')
    expect(text.short).toContain('изменён существующий тест')
    expect(text.full).toContain('- test/bot.test.ts')
    expect(text.full).toContain('Ветка (только у врача): remontnik/7-charge')
  })

  it('eval хуже: в коротком отчёте ухудшившиеся сценарии', () => {
    const worse: ChecksResult = { ...green, eval: { status: 'worse', scenarios: [{ id: 'price-named-plan', basePass: 2, candidatePass: 0, repeats: 2 }], costUsd: 0.1 } }
    const decision: GateDecision = { verdict: 'report_only', reasons: [{ code: 'eval_worse', message: 'Выкатки нет: сценарии eval хуже прежних.', paths: ['price-named-plan'] }] }
    const text = gateReport({ case: sick, diagnosis, fix, branch: 'b', commit: 'abc', pushed: true, checks: worse, decision })
    expect(text.short).toContain('eval хуже: price-named-plan')
    expect(text.full).toContain('price-named-plan: 2/2 → 0/2')
  })

  it('стоп-кран: правка готова, человек нужен только чтобы выкатить', () => {
    const decision: GateDecision = { verdict: 'report_only', reasons: [{ code: 'stop_switch', message: 'Выкатки нет: включён стоп-кран.' }] }
    const text = gateReport({ case: sick, diagnosis, fix, branch: 'b', commit: 'abc', pushed: true, checks: green, decision })
    expect(text.short).toContain('правка готова')
    expect(text.short).toContain('стоп-кран')
    expect(text.short).not.toContain('Нужен человек')
  })
})

describe('причина в Agent Chat SDK', () => {
  const sdkCase = { ...sick, where: 'node_modules/@ykurilov/agent-chat-core/dist/turn.js:88', message: 'turn lost' }
  const sdkDiagnosis = { ...diagnosis, cause: 'SDK теряет ход при обрыве потока', causeInPackage: '@ykurilov/agent-chat-core', fixPlan: 'Сохранять ход до ответа' }
  const stack = 'Error: turn lost\n    at finishTurn (node_modules/@ykurilov/agent-chat-core/dist/turn.js:88:11)'

  it('задача для агента SDK: пакет, сбой, стек, причина, улики, план — готовый текст', () => {
    const task = agentChatSdkTask({ case: sdkCase, stack, diagnosis: sdkDiagnosis, packageName: '@ykurilov/agent-chat-core' })
    expect(task).toContain('@ykurilov/agent-chat-core')
    expect(task).toContain('patient')
    expect(task).toContain('turn lost')
    expect(task).toContain('finishTurn (node_modules/@ykurilov/agent-chat-core/dist/turn.js:88:11)')
    expect(task).toContain(sdkDiagnosis.cause)
    expect(task).toContain('src/payments/charge.ts:15')
    expect(task).toContain(sdkDiagnosis.fixPlan)
  })

  it('отчёт: SDK не правлю, нужен человек, ниже задача для агента SDK', () => {
    const text = agentChatSdkReport({ case: sdkCase, stack, diagnosis: sdkDiagnosis, packageName: '@ykurilov/agent-chat-core' })
    expect(text.short).toContain('Agent Chat SDK')
    expect(text.short).toContain('@ykurilov/agent-chat-core')
    expect(text.short).toContain('Нужен человек')
    expect(text.full).toContain('Задача для агента Agent Chat SDK')
    expect(text.full).toContain(agentChatSdkTask({ case: sdkCase, stack, diagnosis: sdkDiagnosis, packageName: '@ykurilov/agent-chat-core' }))
  })

  it('правка полезла в SDK: в отчёте решения — та же задача', () => {
    const decision: GateDecision = {
      verdict: 'report_only',
      reasons: [{ code: 'forbidden_zone', message: 'Выкатки нет: правка затрагивает запретные зоны (agent_chat_sdk).', paths: ['patches/@ykurilov+agent-chat-core+1.0.0.patch'] }],
    }
    const sdkTask = agentChatSdkTask({ case: sdkCase, stack, diagnosis: sdkDiagnosis, packageName: '@ykurilov/agent-chat-core' })
    const text = gateReport({ case: sdkCase, diagnosis: sdkDiagnosis, fix, branch: 'b', commit: 'abc', pushed: false, decision, sdkTask })
    expect(text.short).toContain('Agent Chat SDK')
    expect(text.full).toContain(sdkTask)
  })
})
