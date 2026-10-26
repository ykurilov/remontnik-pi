import type { IncidentKind } from '@ykurilov/remontnik-core/incident'
import type { ChecksResult, EvalOutcome } from '../checks/index.js'
import type { Diagnosis, FixSummary } from '../treatment/doc.js'

// Тексты отчётов лечения: короткий — для Telegram, полный — для журнала и Paseo.

export interface ReportText {
  short: string
  full: string
}

export interface ReportCase {
  caseId: number
  appName: string
  kind: IncidentKind
  where: string
  message: string
}

const usd = (value: number) => `$${value.toFixed(2)}`

function head(sick: ReportCase): string {
  return `Случай ${sick.caseId} (${sick.appName})`
}

function caseLines(sick: ReportCase): string[] {
  return [`Сбой: ${sick.kind} в ${sick.where || 'неизвестном месте'} — ${sick.message}`]
}

function diagnosisLines(diagnosis: Diagnosis | undefined): string[] {
  if (!diagnosis) return []
  return [
    `Причина: ${diagnosis.cause}`,
    `Уверенность: ${diagnosis.confidence}`,
    ...(diagnosis.evidence.length > 0 ? ['Улики:', ...diagnosis.evidence.map((item) => `- ${item}`)] : []),
    ...(diagnosis.fixPlan ? [`План правки: ${diagnosis.fixPlan}`] : []),
  ]
}

function worseScenarios(outcome: EvalOutcome): string[] {
  return outcome.scenarios.filter((scenario) => scenario.candidatePass < scenario.basePass).map((scenario) => scenario.id)
}

function evalShort(outcome: EvalOutcome): string {
  switch (outcome.status) {
    case 'not_needed':
      return 'eval не нужен'
    case 'not_worse':
      return 'eval не хуже'
    case 'worse':
      return `eval хуже: ${worseScenarios(outcome).join(', ')}`
    case 'stand_broken':
      return 'стенд eval сломан'
    case 'not_run':
      return `eval не запускался${outcome.note ? ` (${outcome.note})` : ''}`
  }
}

function checksLines(checks: ChecksResult): string[] {
  const { tests } = checks
  return [
    `Тесты: ${tests.status}${tests.failed.length > 0 ? `, упали: ${tests.failed.join(', ')}` : ''} (${Math.round(tests.durationMs / 1000)} с)`,
    ...(tests.outputTail ? ['Хвост вывода:', tests.outputTail] : []),
    `Eval: ${checks.eval.status}${checks.eval.truncated ? ', не все сценарии (предел maxScenarios)' : ''}, расход ${usd(checks.eval.costUsd)}`,
    ...checks.eval.scenarios.map((scenario) => `- ${scenario.id}: ${scenario.basePass}/${scenario.repeats} → ${scenario.candidatePass}/${scenario.repeats}`),
    ...(checks.eval.note ? [`Заметка: ${checks.eval.note}`] : []),
  ]
}

export function fixReadyReport(input: {
  case: ReportCase
  diagnosis: Diagnosis
  fix: FixSummary
  branch: string
  commit: string
  checks: ChecksResult
  pushed: boolean
}): ReportText {
  const tests = input.checks.tests.status === 'flaky' ? 'тесты зелёные со второго раза (нестабильный тест)' : 'тесты зелёные'
  const short = [
    `${head(input.case)}: правка готова в ветке ${input.branch}, ${tests}, ${evalShort(input.checks.eval)}.`,
    input.pushed ? '' : ' Ветка не отправлена в origin.',
    ' Я её не выкатывал.',
    ` Причина: ${input.diagnosis.cause}`,
  ].join('')
  const full = [
    short,
    '',
    ...caseLines(input.case),
    ...diagnosisLines(input.diagnosis),
    `Правка: ${input.fix.summary}`,
    `Тесты в правке: ${input.fix.testsAdded.join(', ') || 'нет'}`,
    ...(input.fix.notes ? [`Заметки: ${input.fix.notes}`] : []),
    `Ветка: ${input.branch}, коммит ${input.commit.slice(0, 12)}`,
    ...checksLines(input.checks),
  ].join('\n')
  return { short, full }
}

export function noCauseFoundReport(input: {
  case: ReportCase
  reason: 'budget' | 'not_found' | 'no_answer'
  spentUsd: number
  limitUsd: number
  diagnosis?: Diagnosis
}): ReportText {
  const why = {
    budget: `кончился бюджет (${usd(input.spentUsd)} из ${usd(input.limitUsd)})`,
    not_found: 'модель не нашла причину',
    no_answer: 'модель не дала диагноза',
  }[input.reason]
  const short = `${head(input.case)}: причину не нашёл — ${why}.${input.diagnosis?.cause ? ` Что понял: ${input.diagnosis.cause}` : ''}`
  const full = [short, '', ...caseLines(input.case), `Почему остановился: ${why}`, `Потрачено на модель: ${usd(input.spentUsd)}`, ...diagnosisLines(input.diagnosis)].join('\n')
  return { short, full }
}

export function causeFoundReport(input: {
  case: ReportCase
  diagnosis: Diagnosis
  reason: 'budget' | 'no_answer' | 'no_changes' | 'checks_red'
  branch?: string
  checks?: ChecksResult
}): ReportText {
  const failed = input.checks?.tests.failed ?? []
  const what = {
    budget: 'правку не сделал: кончился бюджет',
    no_answer: 'правку не сделал: модель не закончила',
    no_changes: 'правку не сделал: модель ничего не изменила',
    checks_red: `правка в ветке ${input.branch ?? '—'} не прошла тесты${failed.length > 0 ? `: ${failed.join(', ')}` : ''}`,
  }[input.reason]
  const short = `${head(input.case)}: причину нашёл, ${what}. Причина: ${input.diagnosis.cause}`
  const full = [short, '', ...caseLines(input.case), ...diagnosisLines(input.diagnosis), ...(input.checks ? checksLines(input.checks) : [])].join('\n')
  return { short, full }
}

export function standBrokenReport(input: { case: ReportCase; branch: string; checks: ChecksResult }): ReportText {
  const short = `${head(input.case)}: стенд проверки сломан, правку в ветке ${input.branch} оценить не смог. Нужен человек.`
  const full = [short, '', ...caseLines(input.case), ...checksLines(input.checks)].join('\n')
  return { short, full }
}
