import { describe, expect, it } from 'vitest'
import { selectEvalScenarios, type EvalScopeConfig } from './eval-scope.js'

const config: EvalScopeConfig = {
  evalScope: [
    { paths: ['src/bot/**'], scenarios: 'all' },
    { paths: ['src/pages.ts', 'src/server.ts'], scenarios: ['greeting', 'small-talk'] },
    { paths: ['src/prices/**'], scenarios: ['price-named-plan', 'price-default-plan'] },
  ],
  closedPaths: [],
  maxScenarios: 3,
}

describe('выбор сценариев eval по изменённым путям', () => {
  it('правка вне карты → not_needed', () => {
    expect(selectEvalScenarios(config, ['README.md', 'docs/guide.md'])).toEqual({ status: 'not_needed' })
  })

  it('правка по карте → сценарии этой записи', () => {
    expect(selectEvalScenarios(config, ['src/server.ts'])).toEqual({
      status: 'run',
      scenarios: ['greeting', 'small-talk'],
      truncated: false,
    })
  })

  it('несколько записей объединяются без повторов, в порядке настройки', () => {
    const selected = selectEvalScenarios({ ...config, maxScenarios: 10 }, ['src/prices/plan.ts', 'src/pages.ts'])
    expect(selected).toEqual({
      status: 'run',
      scenarios: ['greeting', 'small-talk', 'price-named-plan', 'price-default-plan'],
      truncated: false,
    })
  })

  it('предел maxScenarios обрезает список и помечает это', () => {
    const selected = selectEvalScenarios({ ...config, maxScenarios: 3 }, ['src/prices/plan.ts', 'src/pages.ts'])
    expect(selected).toEqual({ status: 'run', scenarios: ['greeting', 'small-talk', 'price-named-plan'], truncated: true })
  })

  it('"all" — все сценарии, названные в карте', () => {
    const selected = selectEvalScenarios({ ...config, maxScenarios: 10 }, ['src/bot/bot.ts'])
    expect(selected).toEqual({
      status: 'run',
      scenarios: ['greeting', 'small-talk', 'price-named-plan', 'price-default-plan'],
      truncated: false,
    })
  })

  it('"all" при карте без имён сценариев → сценарий "all" (решает сам eval)', () => {
    const onlyAll: EvalScopeConfig = { evalScope: [{ paths: ['src/**'], scenarios: 'all' }], closedPaths: [], maxScenarios: 3 }
    expect(selectEvalScenarios(onlyAll, ['src/a.ts'])).toEqual({ status: 'run', scenarios: ['all'], truncated: false })
  })

  it('закрытые сценарии не запускаются и не передаются (FR-015), предел считается после их отсева', () => {
    const closed = { ...config, closedPaths: ['eval/scenarios/price-named-plan*'], maxScenarios: 2 }
    expect(selectEvalScenarios(closed, ['src/prices/plan.ts', 'src/pages.ts'])).toEqual({
      status: 'run',
      scenarios: ['greeting', 'small-talk'],
      truncated: true,
    })
    expect(selectEvalScenarios({ ...closed, maxScenarios: 10 }, ['src/prices/plan.ts'])).toEqual({
      status: 'run',
      scenarios: ['price-default-plan'],
      truncated: false,
    })
  })

  it('все подходящие сценарии закрыты → not_needed', () => {
    const closed = { ...config, closedPaths: ['eval/scenarios/**'] }
    expect(selectEvalScenarios(closed, ['src/prices/plan.ts'])).toEqual({ status: 'not_needed' })
  })
})
