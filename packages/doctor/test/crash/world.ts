import { createIncidentEvent, type IncidentEvent } from '@ykurilov/remontnik-core/incident'

// Общее для стенда падений и врача в дочернем процессе: точки падения, приложение-пациент и пути на диске.

/**
 * Где врача убивают: по одной точке на фазу лечения, у выкатки — до и после переключения версии. `mid_commit` — посреди
 * коммита правки: git тоже убит и оставил замок индекса (так бывает, когда перезапускают весь контейнер врача).
 */
export const CRASH_POINTS = ['triage', 'diagnosing', 'fixing', 'mid_commit', 'verifying', 'gated', 'before_promote', 'after_promote', 'observing'] as const
/** Правка делает хуже: врача убивают сразу после отката. */
export const ROLLBACK_CRASH_POINT = 'after_rollback'
export type CrashPoint = (typeof CRASH_POINTS)[number] | typeof ROLLBACK_CRASH_POINT

export interface ChildWorld {
  repoDir: string
  stateDir: string
  worktreesDir: string
  /** Копия случая 1: после её создания врач падает в точке `triage`. */
  workbenchPath: string
  lockPath: string
  telegramUrl: string
  appStatePath: string
  clockPath: string
  /** Правка делает хуже: здоровье приложения плохое, пока она работает. */
  sickFix: boolean
}

/** Подставное приложение на диске: какая версия работает и сколько раз её переключали. */
export interface FakeAppState {
  running: string | null
  previous: string | null
  candidate: string | null
  promotes: number
  rollbacks: number
  calls: string[]
}

export const BUGGY = `const PLANS = { start: 990, pro: 2990 }
export const DEFAULT_PLAN = 'starter'
export function price(plan = DEFAULT_PLAN) {
  const value = PLANS[plan]
  if (value === undefined) throw new Error('нет тарифа ' + plan)
  return value
}
`
export const FIXED = BUGGY.replace("'starter'", "'start'")
export const NEW_TEST = `import { test } from 'node:test'
import assert from 'node:assert/strict'
import { price } from '../src/price.mjs'
test('цена тарифа по умолчанию', () => assert.equal(price(), 990))
`
export const OLD_TEST = `import { test } from 'node:test'
import assert from 'node:assert/strict'
import { price } from '../src/price.mjs'
test('тариф pro', () => assert.equal(price('pro'), 2990))
`

export function priceCrash(): IncidentEvent {
  return createIncidentEvent({
    appName: 'test-app',
    kind: 'crash',
    where: 'src/price.mjs:5:35',
    message: 'нет тарифа starter',
    stack: 'Error: нет тарифа starter\n    at price (src/price.mjs:5:35)',
    context: { processName: 'web' },
    occurredAt: new Date(),
  })
}
