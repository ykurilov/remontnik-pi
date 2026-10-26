import type { RemontnikConfig } from '@ykurilov/remontnik-core/config'
import { readErrorsSince, type ErrorBaseline, type ErrorsSince } from '../case-book/error-hours.js'
import type { RecordStore } from '../records/index.js'
import type { AppCommands, CurrentAnswer, HealthAnswer } from './app-commands.js'

// Наблюдение после выкатки (research R9). Каждый тик — снимок: что работает (`current`), здоровье (`health`)
// и ошибки с начала выкатки против уровня до неё. Решение — чистая функция от прошлого состояния и тика:
// после перезапуска врач продолжает с сохранённого состояния, а между тиками спит через `runtime.sleepUntil`.

export type ObserveSettings = RemontnikConfig['observe']

/** Сколько ждать между тиками наблюдения. */
export const OBSERVE_TICK_MS = 30_000

export interface ObservationState {
  healthFailuresInRow: number
  lastHealthReason?: string
}

export interface ObservationTick {
  at: Date
  current: CurrentAnswer
  health: HealthAnswer
  errors: ErrorsSince
}

export type RollbackReason = 'health' | 'error_rate' | 'new_fingerprints'

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
  observeUntil: Date
}

export const startObservation = (): ObservationState => ({ healthFailuresInRow: 0 })

export function observe(state: ObservationState, tick: ObservationTick, window: ObservationWindow): { state: ObservationState; verdict: ObservationVerdict } {
  const { settings, baseline } = window
  if (tick.current.ok && tick.current.version !== null && tick.current.version !== window.candidateVersion) {
    return { state, verdict: { kind: 'superseded', version: tick.current.version } }
  }

  // `current` молчит — работает ли кандидат, неизвестно: это сбой здоровья.
  const failure = !tick.current.ok
    ? tick.current.reason
    : tick.current.version === null
      ? 'current: работающей версии нет'
      : !tick.health.ok
        ? tick.health.reason
        : undefined
  const next: ObservationState =
    failure === undefined ? { healthFailuresInRow: 0 } : { healthFailuresInRow: state.healthFailuresInRow + 1, lastHealthReason: failure }
  const rollback = (reason: RollbackReason, detail: string) => ({ state: next, verdict: { kind: 'rollback', reason, detail } as const })

  if (next.healthFailuresInRow >= settings.healthFailuresToRollback) {
    return rollback('health', `${next.healthFailuresInRow} сбоя здоровья подряд: ${failure}`)
  }
  const { errors } = tick
  const ceiling = baseline.errorsPerHour * settings.errorRateFactor
  if (errors.errors >= settings.minErrorsToRollback && errors.errorsPerHour > ceiling) {
    return rollback('error_rate', `ошибок ${errors.errors}, ${errors.errorsPerHour.toFixed(1)} в час против ${baseline.errorsPerHour.toFixed(1)} до выкатки`)
  }
  if (errors.newFingerprints.length >= settings.newFingerprintsToRollback) {
    return rollback('new_fingerprints', `новых сбоев: ${errors.newFingerprints.length}`)
  }
  if (tick.at.getTime() >= window.observeUntil.getTime()) {
    return { state: next, verdict: { kind: 'window_over', outcome: errors.caseFingerprintSeen ? 'not_helped' : 'holding' } }
  }
  return { state: next, verdict: { kind: 'continue' } }
}

/** Снимок для тика: команды приложения и ошибки из книги случаев. */
export async function readObservationTick(input: {
  commands: AppCommands
  records: RecordStore
  appName: string
  at: Date
  promotedAt: Date
  baseline: ErrorBaseline
  caseFingerprint: string
}): Promise<ObservationTick> {
  const current = await input.commands.current()
  const health = await input.commands.health()
  const errors = await readErrorsSince(input.records, input.appName, {
    from: input.promotedAt,
    to: input.at,
    knownFingerprints: input.baseline.knownFingerprints7d,
    caseFingerprint: input.caseFingerprint,
  })
  return { at: input.at, current, health, errors }
}
