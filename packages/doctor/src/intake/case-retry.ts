import type { ReplayGuard } from '@ykurilov/remontnik-core/signed-http'
import type { IntakeHandler } from './http-kit.js'
import { createOwnerCommandHandler, parseBy } from './owner-command.js'

// Снова поставить случай в работу (contracts/doctor-api.md): `POST /v1/control/cases` `{ caseId, action: "retry", by, force? }`.
// Только секретом владельца: повтор тратит модель и может кончиться выкаткой.

export type CaseRetryAnswer =
  /** `parked` — задача, остановленная после повторных падений, продолжена со своего чекпойнта; `restarted` — новая попытка вместо упавшей задачи или лечения, кончившегося без излечения. */
  | { retried: 'parked' | 'restarted'; attempt: number; previousBranch?: string }
  | { error: 'unknown_case' }
  /** Случай закрыт (`case_finished`), его лечение идёт (`already_running`), выкатка не закончена (`deploy_unfinished`), лечения у врача нет (`treatment_off`). */
  | { error: 'case_finished' | 'already_running' | 'deploy_unfinished' | 'treatment_off'; state?: string }
  /**
   * Новая попытка только с `force`: правка готова в ветке (`fix_ready`), после выкатки нужен человек
   * (`deploy_needs_human`), передача Paseo упала, не записав номер задачи моста (`handoff_unconfirmed`).
   */
  | { error: 'fix_ready' | 'deploy_needs_human' | 'handoff_unconfirmed'; state: string; branch?: string; hint: string }

export interface CaseRetryOptions {
  secret: string
  controlSecret?: string
  retryCase(caseId: number, by: string, request?: { force?: boolean }): Promise<CaseRetryAnswer>
  replayGuard?: ReplayGuard
  bodyTimeoutMs?: number
  now?: () => number
}

export function createCaseRetryHandler(options: CaseRetryOptions): IntakeHandler {
  return createOwnerCommandHandler({
    ...options,
    parse(body) {
      const { caseId, action, by, force } = (body ?? {}) as { caseId?: unknown; action?: unknown; by?: unknown; force?: unknown }
      const who = parseBy(by)
      if (action !== 'retry' || !Number.isSafeInteger(caseId) || (caseId as number) < 1 || !who) return undefined
      if (force !== undefined && typeof force !== 'boolean') return undefined
      return { caseId: caseId as number, by: who, force: force === true }
    },
    async run({ caseId, by, force }) {
      const answer = await options.retryCase(caseId, by, force ? { force } : {})
      if ('retried' in answer) return { status: 200, body: { caseId, ...answer } }
      return { status: answer.error === 'unknown_case' ? 404 : 409, body: { caseId, ...answer } }
    },
  })
}
