import { describe, expect, it } from 'vitest'
import type { ChecksResult } from '../checks/index.js'
import type { Deployment } from '../deployer/deploy-sequence.js'
import { abandonedDeploymentReport, causeFoundReport, deploymentReport, fixReadyReport, lostLockReport, noCauseFoundReport, standBrokenReport } from './texts.js'

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

describe('тексты отчётов выкатки', () => {
  const PREV = 'a'.repeat(40)
  const CAND = 'c'.repeat(40)
  const base: Deployment = {
    deploymentId: 2,
    caseId: 7,
    appName: 'patient',
    fingerprint: 'fp',
    candidateVersion: CAND,
    candidateDir: '/srv/copies/7',
    lockToken: '0123456789abcdef',
    stage: 'done',
    outcome: 'holding',
    startedAt: '2026-10-26T12:00:00.000Z',
    previousVersion: PREV,
    preDeployTag: 'remontnik/pre-deploy/2026-10-26-7-2',
    promotedAt: '2026-10-26T12:01:00.000Z',
    observeUntil: '2026-10-26T12:31:00.000Z',
    lastTick: { at: '2026-10-26T12:31:00.000Z', errors: 0, errorsPerHour: 0, newFingerprints: [], caseFingerprintSeen: false },
  }
  const report = (deployment: Partial<Deployment>, extra: Omit<Parameters<typeof deploymentReport>[0], 'case' | 'deployment'> = {}) =>
    deploymentReport({ case: sick, deployment: { ...base, ...deployment }, ...extra })

  it('держится: deployed с версией, меткой прежней и снимками экрана', () => {
    const text = report({}, { screenshots: ['/state/shots/7-1.png'] })
    expect(text.type).toBe('deployed')
    expect(text.short).toContain('Случай 7')
    expect(text.short).toContain(CAND.slice(0, 12))
    expect(text.full).toContain('remontnik/pre-deploy/2026-10-26-7-2')
    expect(text.full).toContain(PREV.slice(0, 12))
    expect(text.screenshots).toEqual(['/state/shots/7-1.png'])
  })

  it('оставленная правка: влита в основную ветку или ждёт запроса на слияние', () => {
    expect(report({}, { mainline: { kind: 'merged', into: 'main' } }).short).toContain('влил в основную ветку main')
    const waiting = report({ outcome: 'not_helped' }, { mainline: { kind: 'pull_request', branch: 'remontnik/7-fix' } })
    expect(waiting.type).toBe('not_helped')
    expect(waiting.short).toContain('remontnik/7-fix')
    expect(waiting.short).toContain('запрос на слияние')
    expect(waiting.short).toContain('сотрёт правку')
    const stopped = report({}, { mainline: { kind: 'stopped', branch: 'remontnik/7-fix' } })
    expect(stopped.short).toContain('стоп-кран')
    expect(stopped.short).toContain('запрос на слияние')
    const failed = report({}, { mainline: { kind: 'merge_failed', branch: 'remontnik/7-fix', reason: 'основная ветка ушла вперёд' } })
    expect(failed.short).toContain('основная ветка ушла вперёд')
    expect(failed.short).toContain('запрос на слияние')
  })

  it('выкатка в окне наблюдения: deployed «наблюдаю до»', () => {
    const text = report({ stage: 'observing', outcome: 'in_progress' })
    expect(text.type).toBe('deployed')
    expect(text.short).toContain('наблюдаю')
    expect(text.short).toContain('12:31')
  })

  it('откат: причина, на какую версию вернулся и здоровье после', () => {
    const text = report({ outcome: 'rolled_back', rollbackCause: 'error_rate', rollbackReason: 'ошибок 9, 18.0 в час против 1.0 до выкатки', healthyAfterRollback: true })
    expect(text.type).toBe('rolled_back')
    expect(text.short).toContain('откатил')
    expect(text.short).toContain('ошибок 9')
    expect(text.short).toContain(PREV.slice(0, 12))
    expect(text.full).toContain('здоров')
    const sick2 = report({ outcome: 'rolled_back', rollbackCause: 'health', rollbackReason: '3 сбоя здоровья подряд', healthyAfterRollback: false, healthAfterRollback: 'база недоступна' })
    expect(sick2.short).toContain('Нужен человек')
    expect(sick2.full).toContain('база недоступна')
  })

  it('откат из изменённой рабочей копии: нужен человек, пометка в самом начале', () => {
    const changed = report({ outcome: 'rolled_back', rollbackCause: 'main_copy_changed', rollbackReason: 'рабочая копия основной ветки изменена: изменены файлы: app.ts', healthyAfterRollback: true })
    expect(changed.type).toBe('needs_human')
    expect(changed.short).toMatch(/^ВНИМАНИЕ: откат шёл из изменённой рабочей копии основной ветки/)
    expect(changed.short).toContain('app.ts')
    expect(changed.short).toContain('Нужен человек')
    // Копию изменили уже во время отката по другой причине — та же пометка.
    const during = report({ outcome: 'rolled_back', rollbackCause: 'health', mainCopyChange: 'рабочая копия основной ветки изменена: коммит', healthyAfterRollback: true })
    expect(during.type).toBe('needs_human')
    expect(during.short).toMatch(/^ВНИМАНИЕ: откат шёл из изменённой рабочей копии основной ветки/)
  })

  it('откат из-за возврата приложения: причина', () => {
    const reverted = report({ outcome: 'rolled_back', rollbackCause: 'reverted', rollbackReason: 'приложение вернулось к прежней версии', healthyAfterRollback: true })
    expect(reverted.short).toContain('приложение вернулось к прежней версии')
  })

  it('не помогло: сбой случая повторился без ухудшения', () => {
    const text = report({ outcome: 'not_helped', lastTick: { ...base.lastTick!, caseFingerprintSeen: true } })
    expect(text.type).toBe('not_helped')
    expect(text.short).toContain('не помогла')
  })

  it('откат не удался или человек выкатил своё — нужен человек', () => {
    const failed = report({ outcome: 'rollback_failed', rollbackAttempts: 3, detail: 'откатывать некуда' })
    expect(failed.type).toBe('needs_human')
    expect(failed.short).toContain('Нужен человек')
    expect(failed.full).toContain('откатывать некуда')
    const human = report({ outcome: 'superseded_by_human', supersededBy: 'd'.repeat(40) })
    expect(human.type).toBe('needs_human')
    expect(human.short).toContain('d'.repeat(12))
  })

  it('выкатку бросили (замок потерян или задача умерла) — нужен человек, кандидат назван', () => {
    const lost = report({ outcome: 'abandoned', stage: 'done', detail: 'замок выкатки потерян: в файле замка manual deploy' })
    expect(lost.type).toBe('needs_human')
    expect(lost.short).toContain('бросил')
    expect(lost.short).toContain(CAND.slice(0, 12))
    expect(lost.full).toContain('manual deploy')
    const lockLost = report({ outcome: 'refused', refusal: 'lock_lost' })
    expect(lockLost.short).toContain('замок')
    const unconfirmed = report({ outcome: 'refused', refusal: 'unconfirmed_version' })
    expect(unconfirmed.short).toContain('брошенной')
  })

  it('отчёты врача о чужой брошенной выкатке и об отложенном замке', () => {
    const dead = abandonedDeploymentReport({ deployment: { ...base, outcome: 'abandoned', abandonedBy: 9 } })
    expect(dead.short).toContain('Выкатка 2')
    expect(dead.short).toContain(CAND.slice(0, 12))
    expect(dead.short).toContain('Нужен человек')
    const lost = lostLockReport({ deployment: base, lockFile: '.remontnik/deploy.lock', lostFile: '/srv/app/.remontnik/deploy.lock.lost-ab12' })
    expect(lost.short).toContain('/srv/app/.remontnik/deploy.lock.lost-ab12')
    expect(lost.short).toContain('.remontnik/deploy.lock')
  })

  it('стоп-кран: правка готова в ветке, не выкатывал; другие отказы — нужен человек с причиной', () => {
    const stopped = report({ outcome: 'refused', refusal: 'stop_switch' }, { branch: 'remontnik/7-orders' })
    expect(stopped.type).toBe('fix_ready')
    expect(stopped.short).toContain('стоп-кран')
    expect(stopped.short).toContain('remontnik/7-orders')
    expect(stopped.stopSwitch).toBe(true)
    const noBuild = report({ outcome: 'refused', refusal: 'no_previous_build', detail: 'current: прежней сборки нет' })
    expect(noBuild.type).toBe('needs_human')
    expect(noBuild.short).toContain('прежней сборки')
    expect(noBuild.stopSwitch).toBeUndefined()
  })
})
