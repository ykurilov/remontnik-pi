// Передача случая агенту Paseo — документ `handoff/<caseId>` (R18, data-model.md). Правит случай только один:
// `owner` — кто. Врач забрал случай (`reclaimed`) — итог агента после этого только `lateResult`, второй правки
// врачом поверх нет. Поздняя выкатка агента не теряется: врач наблюдает её под этим случаем (`adoptedAt`).

export const HANDOFF_COLLECTION = 'handoff'

export type HandoffResult =
  | { kind: 'done'; commit?: string; deployed: boolean; version?: string }
  | { kind: 'cannot'; reason: string }

export type ReclaimReason = 'bridge_unreachable' | 'accept_timeout' | 'work_timeout' | 'cannot'

export interface Handoff {
  caseId: number
  /** Номер задачи у моста (ULID). */
  taskId: string
  owner: 'paseo' | 'doctor'
  /** Мост принял задачу; нет — мост не ответил, врач лечит сам. */
  sentAt?: string
  acceptDeadline?: string
  acceptedAt?: string
  agent?: string
  workDeadline?: string
  /** Итог агента, пока случай за ним (и «не смог», из-за которого его забрали). */
  result?: HandoffResult
  finishedAt?: string
  reclaimedAt?: string
  reclaimReason?: ReclaimReason
  /** Итог агента после `reclaimed`: врач его не применяет, кроме наблюдения поздней выкатки. */
  lateResult?: HandoffResult & { receivedAt: string }
  /** Задачу мосту отправляли, но он не подтвердил приём: её всё равно отменяют — вдруг она дошла. */
  taskOffered?: boolean
  /** Мост принял отмену задачи (или её у него нет). */
  cancelSent?: boolean
  /** Врач взял выкатку агента под наблюдение. */
  adoptedAt?: string
}

export function handoffKey(caseId: number): string {
  return String(caseId)
}

/** Запас назад от отчёта агента: выкатка закончилась до отчёта, а началась раньше — когда, врач не знает. */
export const AGENT_DEPLOY_MARGIN_MS = 5 * 60_000

/**
 * Выкатка агента под наблюдением врача. Ошибки — с `since`: с запасом до отчёта, но не раньше передачи задачи
 * (до неё агент выкатить не мог). Сбой случая — только с `caseSince`, времени отчёта: до него мог работать прежний
 * код, и его сбой — не «правка не помогла».
 */
export type AgentDeploy = { version: string; since: number; caseSince: number }

export function agentDeployWindow(handoff: Handoff, version: string, reportedAt: string): AgentDeploy {
  const reported = Date.parse(reportedAt)
  const handedAt = Date.parse(handoff.sentAt ?? handoff.reclaimedAt ?? reportedAt)
  return { version, since: Math.max(handedAt, reported - AGENT_DEPLOY_MARGIN_MS), caseSince: reported }
}

/** Выкатка агента, которую врач ещё не взял под наблюдение. */
export function unadoptedDeploy(handoff: Handoff | undefined): AgentDeploy | undefined {
  if (!handoff || handoff.adoptedAt) return undefined
  const late = handoff.lateResult
  if (late?.kind === 'done' && late.deployed && late.version) return agentDeployWindow(handoff, late.version, late.receivedAt)
  return undefined
}

/** Врач забрал случай, задача могла дойти до моста, а её отмену мост ещё не подтвердил: агент, может быть, работает. */
export function cancelPending(handoff: Handoff): boolean {
  return handoff.owner === 'doctor' && !handoff.cancelSent && Boolean(handoff.sentAt || handoff.taskOffered) && handoff.reclaimReason !== undefined
}

/** До какого времени агент мог работать над задачей: взял — срок работы; не взял — срок взять и срок работы от передачи. */
export function agentDeadlineOf(handoff: Handoff, timeouts: { acceptTimeoutMs: number; workTimeoutMs: number }): number {
  if (handoff.workDeadline) return Date.parse(handoff.workDeadline)
  return Date.parse(handoff.sentAt ?? handoff.reclaimedAt ?? '') + timeouts.acceptTimeoutMs + timeouts.workTimeoutMs
}
