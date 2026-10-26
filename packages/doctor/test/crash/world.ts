import { renameSync, writeFileSync } from 'node:fs'
import { createIncidentEvent, type IncidentEvent } from '@ykurilov/remontnik-core/incident'

// Общее для стенда падений и врача в дочернем процессе: точки падения, приложение-пациент и пути на диске.

/**
 * Где врача убивают: по одной точке на фазу лечения, у выкатки — после метки прежней версии, до и после переключения
 * версии и после `confirm`, а ещё — когда правка уже в main, а отчёт ещё не записан. `mid_commit` — посреди коммита
 * правки: git тоже убит и оставил замок индекса (так бывает, когда перезапускают весь контейнер врача).
 */
export const CRASH_POINTS = [
  'triage',
  'diagnosing',
  'fixing',
  'mid_commit',
  'verifying',
  'gated',
  'after_tag',
  'before_promote',
  'after_promote',
  'observing',
  'after_confirm',
  'after_merge_push',
] as const
/** Правка делает хуже: врача убивают сразу после отката. */
/** Состояние на диске читают родитель и дочерний врач одновременно: пишем целиком через переименование, чтобы читатель не увидел пустой файл. */
export function writeJsonAtomically(path: string, value: unknown): void {
  const temporary = `${path}.${process.pid}.tmp`
  writeFileSync(temporary, JSON.stringify(value))
  renameSync(temporary, path)
}

export const ROLLBACK_CRASH_POINT = 'after_rollback'
/** Браузер врача ждёт человека: отчёт `needs_human` уже записан, врача убивают на первом опросе службы браузера. */
export const BROWSER_CRASH_POINT = 'browser_wait_human'
/**
 * Режим «сначала Paseo»: мост принял задачу, а передача ещё не записана; агент работает; врач наблюдает выкатку агента;
 * врач забрал случай, а отменить задачу у моста не успел; мост молчит, а начало молчания уже записано.
 */
export const PASEO_CRASH_POINTS = ['handoff_sent', 'paseo_working', 'paseo_observing', 'before_cancel', 'bridge_silent'] as const
export type CrashPoint =
  | (typeof CRASH_POINTS)[number]
  | typeof ROLLBACK_CRASH_POINT
  | typeof BROWSER_CRASH_POINT
  | (typeof PASEO_CRASH_POINTS)[number]

/** Сколько мост может молчать на стенде: минута по часам врача, а не 5 — опросов меньше. */
export const STAND_BRIDGE_SILENCE_MS = 60_000

/** Секрет моста Paseo на стенде. */
export const BRIDGE_SECRET = 'bridge-test-secret'

/** Секрет владельца врача на стенде: им подписывается `case <id> retry`. */
export const CONTROL_SECRET = 'owner-test-secret'

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
  /** Подставная служба браузера на диске (`FakeBrowserState`). */
  browserStatePath: string
  /** Правка делает хуже: здоровье приложения плохое, пока она работает. */
  sickFix: boolean
  /** Подставной мост Paseo (режим «сначала Paseo»): он в процессе стенда и переживает перезапуск врача. */
  paseoBridgeUrl?: string
}

/** Подставное приложение на диске: какая версия работает и сколько раз её переключали. */
export interface FakeAppState {
  running: string | null
  previous: string | null
  candidate: string | null
  promotes: number
  rollbacks: number
  calls: string[]
  /** Кто-то правит рабочую копию основной ветки: изменённые файлы и их sha256. */
  mainCopyDirty?: Record<string, string>
}

/** Подставная служба браузера: проверка для человека на странице, пока владелец не вернул управление. */
export interface FakeBrowserState {
  ownerReturned: boolean
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
