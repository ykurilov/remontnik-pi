import type { ChecksResult } from '../checks/index.js'
import type { GateDecision, GateReasonCode } from '../deploy-gate/index.js'
import type { Diagnosis, FixSummary } from '../treatment/doc.js'
import { caseLines, checksLines, diagnosisLines, evalShort, head, type ReportCase, type ReportText } from './texts.js'

// Тексты фазы `gated`: почему правка не выкачена, и задача для агента Agent Chat SDK, когда причина в нём.

const STACK_LINES = 40
const OPERATIONAL: readonly GateReasonCode[] = ['stop_switch', 'attempts_exhausted', 'budget_exhausted', 'rebase_conflict']

function reasonLabel(code: GateReasonCode, checks: ChecksResult | undefined): string | undefined {
  switch (code) {
    case 'tests_not_green':
      if (!checks) return undefined
      return { green: 'тесты зелёные', red: 'тесты красные', flaky: 'тесты нестабильны', not_run: 'тесты не запускались' }[checks.tests.status]
    case 'eval_worse':
      return checks ? evalShort(checks.eval) : undefined
    case 'forbidden_zone':
      return 'запретная зона'
    case 'protected_path':
      return 'защищённые пути'
    case 'existing_test_changed':
      return 'изменён существующий тест'
    case 'suspicious_change':
      return 'подозрительный код'
    case 'diff_too_large':
      return 'правка слишком большая'
    case 'stop_switch':
      return 'включён стоп-кран'
    case 'attempts_exhausted':
      return 'лимит выкаток исчерпан'
    case 'needs_human_after_rollback':
      return 'после отката эта причина ждёт человека'
    case 'budget_exhausted':
      return 'потолок расходов за сутки'
    case 'rebase_conflict':
      return 'конфликт с основной веткой'
    case 'facts_invalid':
      return 'не хватает данных для решения'
  }
}

/** Правка готова, а выкатки нет: решение `report_only` и все его причины. */
export function gateReport(input: {
  case: ReportCase
  diagnosis: Diagnosis
  fix: FixSummary
  branch: string
  commit: string
  pushed: boolean
  /** Нет — правку не проверяли: ей нельзя доверить собственную проверку. */
  checks?: ChecksResult
  decision: GateDecision
  /** Готовая задача для агента SDK, если правка полезла в Agent Chat SDK. */
  sdkTask?: string
}): ReportText {
  const { decision, checks } = input
  const labels = [...new Set(decision.reasons.flatMap((reason) => reasonLabel(reason.code, checks) ?? []))].join(', ')
  const operational = decision.reasons.every((reason) => OPERATIONAL.includes(reason.code))
  const what = operational
    ? `правка готова в ветке ${input.branch}, но не выкачена: ${labels}.`
    : checks
      ? `правка в ветке ${input.branch} не выкачена: ${labels}.`
      : `правку в ветке ${input.branch} я не проверял и не отправлял: ${labels}.`
  const short = [
    `${head(input.case)}: ${what}`,
    checks && !input.pushed ? ' Ветка не отправлена в origin.' : '',
    input.sdkTask ? ' Причина в Agent Chat SDK: ниже задача для его агента.' : '',
    operational ? '' : ' Нужен человек.',
  ].join('')
  const full = [
    short,
    '',
    ...caseLines(input.case),
    ...diagnosisLines(input.diagnosis),
    `Правка: ${input.fix.summary}`,
    `Тесты в правке: ${input.fix.testsAdded.join(', ') || 'нет'}`,
    ...(input.fix.notes ? [`Заметки: ${input.fix.notes}`] : []),
    'Почему не выкачено:',
    ...decision.reasons.flatMap((reason) => [`- ${reason.message}`, ...(reason.paths ?? []).map((path) => `  - ${path}`)]),
    input.pushed ? `Ветка: ${input.branch}, коммит ${input.commit.slice(0, 12)}` : `Ветка (только у врача): ${input.branch}, коммит ${input.commit.slice(0, 12)}`,
    ...(checks ? checksLines(checks) : []),
    ...(input.sdkTask ? ['', 'Задача для агента Agent Chat SDK:', input.sdkTask] : []),
  ].join('\n')
  return { short, full, ...(decision.reasons.some((reason) => reason.code === 'stop_switch') ? { stopSwitch: true as const } : {}) }
}

/** Готовый текст задачи для агента, который отвечает за Agent Chat SDK: его можно переслать как есть. */
export function agentChatSdkTask(input: { case: ReportCase; stack: string; diagnosis: Diagnosis; packageName: string }): string {
  const stack = input.stack.trim().split('\n').slice(0, STACK_LINES).join('\n')
  const { diagnosis } = input
  return [
    `В приложении «${input.case.appName}» сбой, причина которого — в пакете ${input.packageName} (Agent Chat SDK).`,
    `Сбой: ${input.case.kind} в ${input.case.where || 'неизвестном месте'} — ${input.case.message}`,
    'Стек:',
    stack || '(нет)',
    `Причина по диагнозу Ремонтника: ${diagnosis.cause}`,
    `Уверенность: ${diagnosis.confidence}`,
    ...(diagnosis.evidence.length > 0 ? ['Улики:', ...diagnosis.evidence.map((item) => `- ${item}`)] : []),
    ...(diagnosis.fixPlan ? [`Как исправить, по мнению Ремонтника: ${diagnosis.fixPlan}`] : []),
    `Что нужно: проверить причину, исправить её в ${input.packageName} с тестом и выпустить новую версию SDK. Код SDK в приложении Ремонтник не правит.`,
  ].join('\n')
}

/** Причина в Agent Chat SDK: правки нет, есть задача для агента SDK. */
export function agentChatSdkReport(input: { case: ReportCase; stack: string; diagnosis: Diagnosis; packageName: string }): ReportText {
  const short = `${head(input.case)}: причина в Agent Chat SDK (${input.packageName}), его я не правлю. Причина: ${input.diagnosis.cause}. Нужен человек: передать задачу агенту SDK.`
  const full = [short, '', ...caseLines(input.case), ...diagnosisLines(input.diagnosis), '', 'Задача для агента Agent Chat SDK:', agentChatSdkTask(input)].join('\n')
  return { short, full }
}
