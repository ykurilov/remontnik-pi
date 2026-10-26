import { writeFileSync } from 'node:fs'
import { createModelRoute, FALLBACK_MODEL, PRIMARY_MODEL, type ModelRoute } from '@ykurilov/remontnik-core/model-route'
import { describe, expect, it } from 'vitest'
import { createConversationReviewer, type ReviewedFinding } from '../../src/review/index.js'
import { BOT_DESCRIPTION, loadConversations } from '../fixtures/conversations.js'

// Живой тест качества чтения (SC-009): настоящий DeepSeek на выдуманном размеченном наборе.
// Запуск: DEEPSEEK_API_KEY=… [OPENROUTER_API_KEY=…] pnpm --filter @ykurilov/remontnik-watch test:live
// Без ключа DeepSeek тест пропускается. Ключи в вывод и файлы не попадают.
// REMONTNIK_LIVE_REPORT=<файл> — дополнительно записать отчёт в файл (vitest не показывает вывод зелёных тестов).

const deepseekKey = process.env.DEEPSEEK_API_KEY
const openRouterKey = process.env.OPENROUTER_API_KEY
const MIN_FOUND_SHARE = 0.8
const MAX_FALSE_SHARE = 0.1

describe.skipIf(!deepseekKey)('качество чтения разговоров на настоящей модели', () => {
  it(`находит не меньше ${MIN_FOUND_SHARE * 100}% плохих ответов и ложно отмечает не больше ${MAX_FALSE_SHARE * 100}% хороших`, async () => {
    const conversations = loadConversations()
    const route = createModelRoute({
      primary: { apiKey: deepseekKey ?? '', model: PRIMARY_MODEL },
      fallback: { apiKey: openRouterKey ?? 'нет-ключа', model: FALLBACK_MODEL },
    })
    const usages: { route: string; model: string; prompt: number; cached: number; completion: number; costUsd: number | null }[] = []
    const measured: ModelRoute = {
      state: () => route.state(),
      async completeJson(request, options) {
        const result = await route.completeJson(request, options).catch((error: unknown) => {
          callFailures.push(error instanceof Error ? error.message.slice(0, 200) : String(error))
          throw error
        })
        usages.push({
          route: result.route,
          model: result.model,
          prompt: result.usage.promptTokens,
          cached: result.usage.cachedPromptTokens,
          completion: result.usage.completionTokens,
          costUsd: result.usage.costUsd,
        })
        return result
      },
    }
    const callFailures: string[] = []
    const found = new Map<string, ReviewedFinding[]>()
    const errors: string[] = []
    const reviewer = createConversationReviewer({
      botDescription: BOT_DESCRIPTION,
      usdPerDay: 5,
      minConfidence: 0.7,
      model: measured,
      retryDelaysMs: [2_000, 5_000],
      onFinding: (item) => found.set(item.conversationId, [...(found.get(item.conversationId) ?? []), item]),
      onError: (what, error) => errors.push(`${what}: ${error instanceof Error ? error.message : String(error)}`),
    })

    for (const item of conversations) reviewer.conversationFinished({ id: item.id, messages: item.messages })
    await reviewer.idle()
    reviewer.close()

    const bad = conversations.filter((item) => item.label === 'bad')
    const good = conversations.filter((item) => item.label === 'good')
    const hit = (id: string, badMessageIndex: number | undefined) =>
      (found.get(id) ?? []).some((entry) => entry.finding.messageIndex === badMessageIndex)
    const foundBad = bad.filter((item) => hit(item.id, item.badMessageIndex))
    const missed = bad.filter((item) => !hit(item.id, item.badMessageIndex))
    const falseAlarms = good.filter((item) => (found.get(item.id) ?? []).length > 0)
    const wrongCategory = foundBad.filter((item) => !(found.get(item.id) ?? []).some((entry) => entry.finding.category === item.category))

    const spent = reviewer.stats().spentUsd
    const promptTokens = usages.reduce((sum, usage) => sum + usage.prompt, 0)
    const cachedTokens = usages.reduce((sum, usage) => sum + usage.cached, 0)
    const report = [
      `плохих: найдено ${foundBad.length} из ${bad.length} (${((foundBad.length / bad.length) * 100).toFixed(0)}%)`,
      `хороших: ложных ${falseAlarms.length} из ${good.length} (${((falseAlarms.length / good.length) * 100).toFixed(0)}%)`,
      `вид нарушения не совпал у ${wrongCategory.length}: ${wrongCategory.map((item) => item.id).join(', ') || '—'}`,
      `пропущены: ${missed.map((item) => item.id).join(', ') || '—'}`,
      `ложные: ${falseAlarms.map((item) => `${item.id} → ${(found.get(item.id) ?? []).map((entry) => `${entry.finding.category}/${entry.finding.confidence}: ${entry.finding.explanation}`).join(' | ')}`).join('; ') || '—'}`,
      `запросов: ${usages.length + callFailures.length} (ответили ${usages.length}, упали ${callFailures.length}: ${callFailures.join(' | ') || '—'}), пути: ${[...new Set(usages.map((usage) => `${usage.route}:${usage.model}`))].join(', ')}`,
      `токены входа ${promptTokens}, из кэша ${cachedTokens} (${promptTokens === 0 ? 0 : ((cachedTokens / promptTokens) * 100).toFixed(0)}%), выхода ${usages.reduce((sum, usage) => sum + usage.completion, 0)}`,
      `цена прогона по расчёту сторожа: ${spent.toFixed(4)} $, по данным поставщика: ${usages.some((usage) => usage.costUsd !== null) ? usages.reduce((sum, usage) => sum + (usage.costUsd ?? 0), 0).toFixed(4) : 'не сообщил'}`,
      `ошибки чтения: ${errors.length === 0 ? '—' : errors.join('; ')}`,
    ].join('\n')
    console.log(`\n=== Качество чтения ===\n${report}\n`)
    if (process.env.REMONTNIK_LIVE_REPORT) writeFileSync(process.env.REMONTNIK_LIVE_REPORT, `${report}\n`)

    expect(errors, report).toEqual([])
    expect(foundBad.length / bad.length, report).toBeGreaterThanOrEqual(MIN_FOUND_SHARE)
    expect(falseAlarms.length / good.length, report).toBeLessThanOrEqual(MAX_FALSE_SHARE)
  })
})
