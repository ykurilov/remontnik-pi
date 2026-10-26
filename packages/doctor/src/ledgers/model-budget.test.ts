import type { AssistantMessage } from '@earendil-works/pi-ai'
import { describe, expect, it } from 'vitest'
import { createMemoryRecordStore } from '../records/index.js'
import { createScriptedModel, say, testRemontnikConfig } from '../testing/index.js'
import { createModelBudget, maxRequestUsd } from './model-budget.js'
import { modelSpentUsd, type CaseSpend, type SpendDay } from './spend-ledger.js'

// Жёсткий потолок модели врача: каждый запрос сначала бронирует наибольшую цену одной транзакцией.
// Денег на бронь нет — запрос к поставщику не уходит, разговор получает ошибку «out of budget».

const NOON = Date.UTC(2026, 10, 2, 12)
const DAY = '2026-11-02'

function setup(options: { costPerResponseUsd: number; maxResponseUsd?: number; limits: { doctorModelUsdPerDay: number; watchModelUsdPerDay?: number; diagnoseUsdPerCase?: number } }) {
  const scripted = createScriptedModel({ costPerResponseUsd: options.costPerResponseUsd, ...(options.maxResponseUsd === undefined ? {} : { maxResponseUsd: options.maxResponseUsd }) })
  const records = createMemoryRecordStore()
  const config = testRemontnikConfig({ limits: options.limits })
  const lines: string[] = []
  const budget = createModelBudget({ models: scripted.models, boot: 'boot-a', now: () => NOON, log: (line) => lines.push(line) })
  budget.attach({ records, loadConfig: async () => config })
  const model = budget.models.getModel(scripted.model.provider, scripted.model.modelId)!
  const ask = async (caseId?: number): Promise<AssistantMessage> => {
    const signal = new AbortController().signal
    if (caseId !== undefined) budget.bind(signal, caseId)
    return budget.models.streamSimple(model, { messages: [{ role: 'user', content: 'привет', timestamp: NOON }] }, { signal }).result()
  }
  return { scripted, records, ask, model, lines }
}

describe('бронь перед запросом к модели', () => {
  it('наибольшая цена: вход по самой дорогой ставке из байтов, выход — предел длины ответа', () => {
    const { model } = setup({ costPerResponseUsd: 0, limits: { doctorModelUsdPerDay: 1 } })
    const priced = { ...model, maxTokens: 2_000, cost: { input: 1, output: 4, cacheRead: 0.1, cacheWrite: 2, tiers: [{ input: 3, output: 8, cacheRead: 0.3, cacheWrite: 3, inputTokensAbove: 100 }] } }
    const context = { messages: [{ role: 'user' as const, content: 'x'.repeat(3_000), timestamp: NOON }] }
    const bytes = Buffer.byteLength(JSON.stringify(context))
    expect(maxRequestUsd(priced, context, undefined)).toBeCloseTo(((bytes / 3) * 3 + 2_000 * 8) / 1_000_000)
    expect(maxRequestUsd(priced, context, 500)).toBeCloseTo(((bytes / 3) * 3 + 500 * 8) / 1_000_000)
  })

  it('денег на бронь нет → запрос не уходит к поставщику, ответ — ошибка out of budget, отказ записан у случая и в журнале', async () => {
    const { scripted, records, ask, lines } = setup({ costPerResponseUsd: 0.3, limits: { doctorModelUsdPerDay: 0.5 } })
    scripted.script(say('один'), say('два'))
    expect((await ask(1)).stopReason).not.toBe('error')
    const refused = await ask(1)
    expect(refused.stopReason).toBe('error')
    expect(refused.errorMessage).toContain('out of budget')
    expect(scripted.requests).toHaveLength(1)
    expect(scripted.pending()).toBe(1)
    expect((await records.read<CaseSpend>('spend-case', '1'))?.refused).toBe('day_budget')
    expect(lines).toEqual(['запрос к модели не отправлен (случай 1): дневной потолок модели врача'])
  })

  it('после ответа бронь заменяется настоящей ценой', async () => {
    const { scripted, records, ask } = setup({ costPerResponseUsd: 0.05, maxResponseUsd: 0.4, limits: { doctorModelUsdPerDay: 1 } })
    scripted.script(say('один'), say('два'), say('три'))
    await ask(1)
    await ask(1)
    await ask(2)
    const day = await records.read<SpendDay>('spend', DAY)
    expect(day?.modelHolds).toEqual({})
    expect(day?.model).toEqual({ '1': 0.1, '2': 0.05 })
    expect((await records.read<CaseSpend>('spend-case', '1'))?.modelUsd).toBeCloseTo(0.1)
  })

  it('параллельные запросы разных случаев вместе не выходят за дневной потолок', async () => {
    const { scripted, records, ask } = setup({ costPerResponseUsd: 0.2, limits: { doctorModelUsdPerDay: 1 } })
    scripted.script(...Array.from({ length: 8 }, () => say('ответ')))
    const answers = await Promise.all(Array.from({ length: 8 }, (_, index) => ask(index + 1)))
    // Работать можно до 0.9: проходят 4 запроса по 0.2.
    expect(answers.filter((answer) => answer.stopReason !== 'error')).toHaveLength(4)
    expect(scripted.requests).toHaveLength(4)
    expect(modelSpentUsd(await records.read<SpendDay>('spend', DAY))).toBeLessThanOrEqual(0.9 + 1e-9)
  })

  it('потолок врача — свой, `doctorModelUsdPerDay`: потолок сторожа на него не влияет', async () => {
    const { scripted, ask } = setup({ costPerResponseUsd: 0.2, limits: { doctorModelUsdPerDay: 1, watchModelUsdPerDay: 0 } })
    scripted.script(...Array.from({ length: 5 }, () => say('ответ')))
    const answers = []
    for (let caseId = 1; caseId <= 5; caseId += 1) answers.push(await ask(caseId))
    // Сторожу ноль, а врач работает до своих 0.9: четыре запроса по 0.2, пятый не уходит.
    expect(answers.map((answer) => answer.stopReason === 'error')).toEqual([false, false, false, false, true])
    expect(scripted.requests).toHaveLength(4)
  })

  it('потолок случая: случай упёрся — другие случаи работают дальше', async () => {
    const { scripted, records, ask } = setup({ costPerResponseUsd: 0.3, limits: { doctorModelUsdPerDay: 5, diagnoseUsdPerCase: 0.5 } })
    scripted.script(say('один'), say('два'))
    await ask(1)
    expect((await ask(1)).errorMessage).toContain('out of budget')
    expect((await records.read<CaseSpend>('spend-case', '1'))?.refused).toBe('budget')
    expect((await ask(2)).stopReason).not.toBe('error')
  })

  it('запрос не от случая (например, сжатие) тоже бронирует и считается в день', async () => {
    const { scripted, records, ask } = setup({ costPerResponseUsd: 0.3, limits: { doctorModelUsdPerDay: 0.5 } })
    scripted.script(say('сжатие'), say('случай'))
    await ask()
    expect(modelSpentUsd(await records.read<SpendDay>('spend', DAY))).toBeCloseTo(0.3)
    expect((await ask(1)).errorMessage).toContain('out of budget')
  })

  it('учёт не подключён или не отвечает → запрос не уходит', async () => {
    const scripted = createScriptedModel({ costPerResponseUsd: 0.1 })
    scripted.script(say('один'))
    const budget = createModelBudget({ models: scripted.models, boot: 'boot-a', now: () => NOON })
    const model = budget.models.getModel(scripted.model.provider, scripted.model.modelId)!
    const answer = await budget.models.streamSimple(model, { messages: [] }).result()
    expect(answer.stopReason).toBe('error')
    expect(scripted.requests).toHaveLength(0)
  })
})
