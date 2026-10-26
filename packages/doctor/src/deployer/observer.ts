import type { RemontnikConfig } from '@ykurilov/remontnik-core/config'
import { readErrorsSince, type ErrorBaseline, type ErrorsSince } from '../case-book/error-hours.js'
import type { RecordStore } from '../records/index.js'
import type { AppCommands, CurrentAnswer, HealthAnswer } from './app-commands.js'

// Наблюдение после выкатки (research R9). Каждый тик — снимок: что работает (`current`), здоровье (`health`)
// и ошибки с начала выкатки и за последние 10 минут против уровня до неё. Решение — чистая функция от прошлого
// состояния и тика: после перезапуска врач продолжает с сохранённого состояния, а между тиками спит через
// `runtime.sleepUntil`. Итог «держится» — не раньше конца окна и не меньше чем по `healthWindowTicks` проверкам.

export type ObserveSettings = RemontnikConfig['observe']

/** Сколько ждать между тиками наблюдения. */
export const OBSERVE_TICK_MS = 30_000
/** Короткое окно ошибок: всплеск в конце не тонет в спокойном начале. */
export const RECENT_ERRORS_MS = 10 * 60_000

export interface ObservationState {
  healthFailuresInRow: number
  /** Последние проверки здоровья, новые в конце: `true` — сбой. */
  recentHealth: boolean[]
  /** Сколько проверок было в этом окне. */
  ticks: number
  lastHealthReason?: string
}

export interface ObservationTick {
  at: Date
  current: CurrentAnswer
  health: HealthAnswer
  /** С начала выкатки. */
  errors: ErrorsSince
  /** За последние `RECENT_ERRORS_MS`. */
  recentErrors: ErrorsSince
}

/** `current_unavailable` — неизвестно, что работает; `reverted` — приложение само вернулось к прежней версии. */
export type RollbackReason = 'health' | 'error_rate' | 'new_fingerprints' | 'current_unavailable' | 'reverted'

export type ObservationVerdict =
  | { kind: 'continue' }
  | { kind: 'rollback'; reason: RollbackReason; detail: string }
  /** Человек выкатил своё: откатывать нельзя. */
  | { kind: 'superseded'; version: string }
  /** Окно прошло без ухудшения; `not_helped` — сбой случая всё ещё повторяется. */
  | { kind: 'window_over'; outcome: 'holding' | 'not_helped' }

export interface ObservationWindow {
  settings: ObserveSettings
  baseline: ErrorBaseline
  candidateVersion: string
  previousVersion: string
  observeUntil: Date
}

export const startObservation = (): ObservationState => ({ healthFailuresInRow: 0, recentHealth: [], ticks: 0 })

export function observe(state: ObservationState, tick: ObservationTick, window: ObservationWindow): { state: ObservationState; verdict: ObservationVerdict } {
  const { settings, baseline } = window
  const { current } = tick
  const rollback = (next: ObservationState, reason: RollbackReason, detail: string) => ({ state: next, verdict: { kind: 'rollback', reason, detail } as const })
  if (!current.ok || current.version === null) {
    return rollback(state, 'current_unavailable', current.ok ? 'current: работающей версии нет' : current.reason)
  }
  if (current.version === window.previousVersion) return rollback(state, 'reverted', 'приложение вернулось к прежней версии')
  if (current.version !== window.candidateVersion) return { state, verdict: { kind: 'superseded', version: current.version } }

  const failure = tick.health.ok ? undefined : tick.health.reason
  const recentHealth = [...(state.recentHealth ?? []), failure !== undefined].slice(-settings.healthWindowTicks)
  const next: ObservationState = {
    healthFailuresInRow: failure === undefined ? 0 : state.healthFailuresInRow + 1,
    recentHealth,
    ticks: (state.ticks ?? 0) + 1,
    ...(failure === undefined ? {} : { lastHealthReason: failure }),
  }
  const windowOver = tick.at.getTime() >= window.observeUntil.getTime() && next.ticks >= settings.healthWindowTicks

  const failures = recentHealth.filter(Boolean).length
  if (next.healthFailuresInRow >= settings.healthFailuresToRollback) {
    return rollback(next, 'health', `${next.healthFailuresInRow} сбоя здоровья подряд: ${failure}`)
  }
  if (failures >= settings.healthFailuresToRollback) {
    return rollback(next, 'health', `${failures} из ${recentHealth.length} последних проверок здоровья — сбой: ${failure ?? state.lastHealthReason}`)
  }
  if (failure !== undefined && windowOver) return rollback(next, 'health', `сбой здоровья на последней проверке окна: ${failure}`)

  const ceiling = baseline.errorsPerHour * settings.errorRateFactor
  const tooMany = (errors: ErrorsSince) => errors.errors >= settings.minErrorsToRollback && errors.errorsPerHour > ceiling
  const against = `против ${baseline.errorsPerHour.toFixed(1)} до выкатки`
  if (tooMany(tick.errors)) {
    return rollback(next, 'error_rate', `ошибок ${tick.errors.errors}, ${tick.errors.errorsPerHour.toFixed(1)} в час ${against}`)
  }
  if (tooMany(tick.recentErrors)) {
    return rollback(next, 'error_rate', `за последние 10 минут ошибок ${tick.recentErrors.errors}, ${tick.recentErrors.errorsPerHour.toFixed(1)} в час ${against}`)
  }
  if (tick.errors.newFingerprints.length >= settings.newFingerprintsToRollback) {
    return rollback(next, 'new_fingerprints', `новых сбоев: ${tick.errors.newFingerprints.length}`)
  }
  if (windowOver) return { state: next, verdict: { kind: 'window_over', outcome: tick.errors.caseFingerprintSeen ? 'not_helped' : 'holding' } }
  return { state: next, verdict: { kind: 'continue' } }
}

/** Снимок для тика: команды приложения и ошибки из книги случаев. */
export async function readObservationTick(input: {
  commands: AppCommands
  records: RecordStore
  appName: string
  at: Date
  /** С какого времени считать ошибки кандидата: с конца `promote`. */
  errorsFrom: Date
  baseline: ErrorBaseline
  caseFingerprint: string
}): Promise<ObservationTick> {
  const current = await input.commands.current()
  const health = await input.commands.health()
  const since = (from: Date) =>
    readErrorsSince(input.records, input.appName, {
      from,
      to: input.at,
      knownFingerprints: input.baseline.knownFingerprints7d,
      caseFingerprint: input.caseFingerprint,
    })
  const recentFrom = new Date(Math.max(input.errorsFrom.getTime(), input.at.getTime() - RECENT_ERRORS_MS))
  return { at: input.at, current, health, errors: await since(input.errorsFrom), recentErrors: await since(recentFrom) }
}
