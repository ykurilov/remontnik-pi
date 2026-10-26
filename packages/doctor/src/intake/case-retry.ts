import type { ReplayGuard } from '@ykurilov/remontnik-core/signed-http'
import type { IntakeHandler } from './http-kit.js'
import { createOwnerCommandHandler, parseBy } from './owner-command.js'

// Снова поставить случай в работу (contracts/doctor-api.md): `POST /v1/control/cases` `{ caseId, action: "retry", by }`.
// Только секретом владельца: повтор тратит модель и может кончиться выкаткой.

export type CaseRetryAnswer =
  /** `parked` — задача, остановленная после повторных падений, продолжена со своего чекпойнта; `restarted` — упавшая задача заменена новой попыткой. */
  | { retried: 'parked' | 'restarted'; attempt: number }
  | { error: 'unknown_case' }
  /** Случай закончен (`case_finished`), его лечение идёт (`already_running`), выкатка не закончена (`deploy_unfinished`), лечения у врача нет (`treatment_off`). */
  | { error: 'case_finished' | 'already_running' | 'deploy_unfinished' | 'treatment_off'; state?: string }

export interface CaseRetryOptions {
  secret: string
  controlSecret?: string
  retryCase(caseId: number, by: string): Promise<CaseRetryAnswer>
  replayGuard?: ReplayGuard
  bodyTimeoutMs?: number
  now?: () => number
}

export function createCaseRetryHandler(options: CaseRetryOptions): IntakeHandler {
  return createOwnerCommandHandler({
    ...options,
    parse(body) {
      const { caseId, action, by } = (body ?? {}) as { caseId?: unknown; action?: unknown; by?: unknown }
      const who = parseBy(by)
      if (action !== 'retry' || !Number.isSafeInteger(caseId) || (caseId as number) < 1 || !who) return undefined
      return { caseId: caseId as number, by: who }
    },
    async run({ caseId, by }) {
      const answer = await options.retryCase(caseId, by)
      if ('retried' in answer) return { status: 200, body: { caseId, ...answer } }
      return { status: answer.error === 'unknown_case' ? 404 : 409, body: { caseId, ...answer } }
    },
  })
}
