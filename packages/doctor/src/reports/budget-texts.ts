import { spendDayKey } from '../ledgers/spend-ledger.js'
import { caseLines, head, type ReportCase, type ReportText } from './texts.js'

// Отчёт «потолок расходов»: случай отложен до следующих суток (FR-033, история 7).

const usd = (value: number) => `$${value.toFixed(2)}`

export function budgetDeferredReport(input: {
  case: ReportCase
  /** Чей дневной потолок: модели врача или eval. */
  what: 'model' | 'eval'
  spentUsd: number
  limitUsd: number
  resumeAt: number
  timeZone: string
}): ReportText {
  const whose = input.what === 'model' ? 'модели' : 'eval'
  const when = `${spendDayKey(input.resumeAt, input.timeZone)} в 00:00 (${input.timeZone})`
  const short = `${head(input.case)}: отложил — дневной бюджет ${whose} исчерпан (${usd(input.spentUsd)} из ${usd(input.limitUsd)}, запас 10%). Продолжу ${when}.`
  const full = [short, '', ...caseLines(input.case), 'Случай записан, работа продолжится с того же шага в новые сутки.'].join('\n')
  return { short, full }
}
