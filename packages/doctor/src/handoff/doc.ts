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

/** Выкатка агента, которую врач ещё не взял под наблюдение. */
export function unadoptedDeploy(handoff: Handoff | undefined): { version: string; since: number } | undefined {
  if (!handoff || handoff.adoptedAt) return undefined
  const late = handoff.lateResult
  if (late?.kind === 'done' && late.deployed && late.version) return { version: late.version, since: Date.parse(late.receivedAt) }
  return undefined
}
