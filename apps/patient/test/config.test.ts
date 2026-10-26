import { describe, expect, it } from 'vitest'
import { EVAL_SCENARIOS } from '../eval/run-eval.ts'
import config from '../remontnik.config.ts'
import { PLANS } from '../src/bot/plans.ts'

describe('remontnik.config.ts «Пациента»', () => {
  it('проходит проверку и называет зоны оплаты и доступа', () => {
    const { app } = config
    expect(app.name).toBe('patient')
    expect(config.forbidden.money).toContain('src/payments/**')
    expect(config.forbidden.access).toContain('src/auth/**')
    expect(config.forbidden.builtIn.protectedPackages).toContain('@ykurilov/remontnik-*')
  })

  it('команды выкатки и eval — из этого репозитория', () => {
    expect(Object.values(config.deploy.commands).every((command) => command.startsWith('node deploy/remontnik-deploy.ts '))).toBe(true)
    expect(config.checks.eval?.run).toContain('{scenarios}')
    expect(config.checks.eval?.resultFile).toBe('eval-result.json')
  })

  it('карта eval ссылается только на существующие сценарии', () => {
    const known = new Set(EVAL_SCENARIOS.map((scenario) => scenario.id))
    for (const scope of config.evalScope) {
      if (scope.scenarios === 'all') continue
      for (const id of scope.scenarios) expect(known.has(id)).toBe(true)
    }
  })

  it('описание бота называет те же тарифы и цены, что код бота', () => {
    const description = config.review?.botDescription ?? ''
    for (const plan of PLANS) expect(description).toContain(`«${plan.name}» — ${plan.priceRub} ₽ в месяц`)
    expect(description.match(/«[^»]+» — \d+ ₽/g)).toHaveLength(PLANS.length)
  })
})
