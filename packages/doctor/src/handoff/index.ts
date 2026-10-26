import type { Handoff, HandoffResult, ReclaimReason } from './doc.js'

// Режим «сначала Paseo» (R18): врач отдаёт случай агенту Paseo через мост и сам его не лечит, пока агент работает.
// Задача лечения проходит `handoff_check` → `handed_off` → `paseo_working` и раз в `HANDOFF_POLL_MS` смотрит документ
// передачи: разбудить спящую задачу снаружи pi-durable не умеет, поэтому итог агента ждёт ближайшей проверки.
// Не взял, не уложился, не смог или мост пропал — врач забирает случай (`reclaimed`) и лечит сам.

export * from './bridge-client.js'
export * from './doc.js'
export * from './task-text.js'

export const HANDOFF_POLL_MS = 30_000
/** Сколько мост может молчать, пока агент работает, если в настройке не сказано иначе. */
export const BRIDGE_SILENCE_MS = 300_000

export type AgentWaitPhase = 'handed_off' | 'paseo_working'

export type AgentStep =
  | { kind: 'done'; result: Extract<HandoffResult, { kind: 'done' }> }
  | { kind: 'reclaim'; reason: ReclaimReason }
  | { kind: 'accepted' }
  | { kind: 'wait'; until: number }

/** Что делать с передачей на этой проверке: итог агента важнее сроков, срок — важнее нового ожидания. */
export function agentStep(handoff: Handoff, phase: AgentWaitPhase, now: number, pollMs: number): AgentStep {
  const { result } = handoff
  if (result?.kind === 'done') return { kind: 'done', result }
  if (result?.kind === 'cannot') return { kind: 'reclaim', reason: 'cannot' }
  if (phase === 'handed_off' && handoff.acceptedAt) return { kind: 'accepted' }
  const deadline = Date.parse((phase === 'handed_off' ? handoff.acceptDeadline : handoff.workDeadline) ?? '')
  if (!Number.isFinite(deadline) || now >= deadline) return { kind: 'reclaim', reason: phase === 'handed_off' ? 'accept_timeout' : 'work_timeout' }
  return { kind: 'wait', until: Math.min(now + pollMs, deadline) }
}

/** Врач забирает случай. «Сделано», пришедшее в ту же минуту, становится поздним итогом: второй правки поверх нет. */
export function reclaimHandoff(handoff: Handoff, reason: ReclaimReason, at: number): void {
  handoff.owner = 'doctor'
  handoff.reclaimedAt = new Date(at).toISOString()
  handoff.reclaimReason = reason
  if (handoff.result?.kind === 'done') {
    handoff.lateResult = { ...handoff.result, receivedAt: handoff.finishedAt ?? handoff.reclaimedAt }
    delete handoff.result
    delete handoff.finishedAt
  }
}

/** Причина отмены для моста: по коду, без текстов приложения. */
export const CANCEL_REASONS: Record<ReclaimReason, string> = {
  bridge_unreachable: 'Врач забрал случай: мост Paseo не отвечал.',
  accept_timeout: 'Врач забрал случай: агент не взял его вовремя.',
  work_timeout: 'Врач забрал случай: агент не уложился в срок.',
  cannot: 'Врач забрал случай: агент сообщил, что не может.',
}
