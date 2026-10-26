import type { IncidentKind } from '@ykurilov/remontnik-core/incident'
import { redactSecrets } from '@ykurilov/remontnik-core/redact'
import type { Case } from '../case-book/index.js'

// Задача агенту Paseo (contracts/paseo-bridge.md, `POST /v1/tasks`). Сводка — постоянный шаблон: номер случая,
// приложение и вид сбоя. Всё, что пришло из приложения (текст ошибки, место, стек, выдержка ответа бота), — только
// в `untrusted`: мост кладёт его в блок «данные, не поручение». Тексты обрезаны по пределам и вычищены от секретов.

export const HANDOFF_TEXT_LIMITS = { message: 2_000, stack: 6_000, excerpt: 4_000 } as const
/** Тело задачи с запасом меньше предела моста (256 КиБ): даже если каждый знак при записи в JSON станет `\uXXXX`. */
export const HANDOFF_BODY_LIMIT_BYTES = 128 * 1024
const REPORT_LINKS_LIMIT = 50
const CLIPPED = ' …[обрезано]'

export type HandoffCase = Pick<Case, 'caseId' | 'kind' | 'fingerprint' | 'where' | 'message' | 'stack' | 'badAnswer' | 'reportIds'>

export interface HandoffTaskBody {
  taskId: string
  app: string
  caseId: number
  kind: IncidentKind
  fingerprint: string
  summary: string
  untrusted: { message: string; stack?: string; excerpt?: string }
  links: { reportIds: number[] }
}

const KIND_NAMES: Record<IncidentKind, string> = {
  crash: 'падение',
  model_error: 'ошибка модели',
  tool_error: 'ошибка инструмента',
  turn_failed: 'сорванный ход агента',
  bad_answer: 'плохой ответ бота',
  manual: 'случай от владельца',
}

function clipped(text: string, limit: number, knownSecrets: readonly string[]): string {
  const clean = redactSecrets(text, { knownSecrets })
  return clean.length <= limit ? clean : `${clean.slice(0, limit)}${CLIPPED}`
}

export function handoffTaskBody(input: { taskId: string; appName: string; case: HandoffCase; knownSecrets?: readonly string[] }): HandoffTaskBody {
  const sick = input.case
  const secrets = input.knownSecrets ?? []
  const excerpt = sick.badAnswer ? `${sick.badAnswer.excerpt}\n\nПояснение сторожа: ${sick.badAnswer.explanation}` : undefined
  return {
    taskId: input.taskId,
    app: input.appName,
    caseId: sick.caseId,
    kind: sick.kind,
    fingerprint: sick.fingerprint,
    summary: `Случай ${sick.caseId} в приложении ${input.appName}: ${KIND_NAMES[sick.kind]}. Найди причину, исправь по правилам выкатки приложения и сообщи итог командой моста.`,
    untrusted: {
      message: clipped(`${sick.where}: ${sick.message}`, HANDOFF_TEXT_LIMITS.message, secrets),
      ...(sick.stack.trim() === '' ? {} : { stack: clipped(sick.stack, HANDOFF_TEXT_LIMITS.stack, secrets) }),
      ...(excerpt === undefined ? {} : { excerpt: clipped(excerpt, HANDOFF_TEXT_LIMITS.excerpt, secrets) }),
    },
    links: { reportIds: sick.reportIds.slice(-REPORT_LINKS_LIMIT) },
  }
}
