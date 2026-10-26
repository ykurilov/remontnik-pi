import type { RemontnikConfig } from '@ykurilov/remontnik-core/config'
import { matchesAnyMask } from '../path-mask/index.js'

// Какие сценарии eval гонять для правки (FR-018): по карте `evalScope` и изменённым путям.
// Закрытый сценарий (закрытый путь накрывает `eval/scenarios/<id>`) врач не запускает и никуда не передаёт (FR-015).

export interface EvalScopeConfig {
  evalScope: RemontnikConfig['evalScope']
  closedPaths: readonly string[]
  maxScenarios: number
}

export type EvalScopeSelection = { status: 'not_needed' } | { status: 'run'; scenarios: string[]; truncated: boolean }

/** Сценарий для «гоняй всё», когда в карте нет ни одного имени: выбор оставлен самому eval. */
export const ALL_SCENARIOS = 'all'

export function scenarioPath(id: string): string {
  return `eval/scenarios/${id}`
}

export function selectEvalScenarios(config: EvalScopeConfig, changedPaths: readonly string[]): EvalScopeSelection {
  const named = [...new Set(config.evalScope.flatMap((entry) => (entry.scenarios === 'all' ? [] : entry.scenarios)))]
  const picked: string[] = []
  for (const entry of config.evalScope) {
    if (!changedPaths.some((path) => matchesAnyMask(entry.paths, path))) continue
    const scenarios = entry.scenarios === 'all' ? (named.length > 0 ? named : [ALL_SCENARIOS]) : entry.scenarios
    for (const id of scenarios) if (!picked.includes(id)) picked.push(id)
  }
  // Порядок итога — порядок первых упоминаний в карте, а не порядок срабатывания записей.
  const order = [...named, ALL_SCENARIOS]
  const open = picked
    .filter((id) => id === ALL_SCENARIOS || !matchesAnyMask(config.closedPaths, scenarioPath(id)))
    .sort((a, b) => order.indexOf(a) - order.indexOf(b))
  if (open.length === 0) return { status: 'not_needed' }
  const scenarios = open.slice(0, config.maxScenarios)
  return { status: 'run', scenarios, truncated: open.length > scenarios.length }
}
