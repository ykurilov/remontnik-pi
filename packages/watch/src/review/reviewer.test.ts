import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createModelRoute } from '@ykurilov/remontnik-core/model-route'
import { startFakeModel, type FakeModelServer } from '@ykurilov/remontnik-core/testing'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BOT_DESCRIPTION } from '../../test/fixtures/conversations.js'
import { createConversationReviewer, type ConversationReviewer, type ReviewedFinding } from './index.js'
import type { ConversationMessage } from './rubric.js'

let model: FakeModelServer
let dir: string
const reviewers: ConversationReviewer[] = []

const talk: ConversationMessage[] = [
  { role: 'user', content: 'Сколько стоит тариф Макс? Моя почта ivan@example.com' },
  { role: 'assistant', content: 'Тариф «Макс» стоит 5990 ₽ в месяц.' },
]

const badFinding = {
  messageIndex: 1,
  category: 'fabrication',
  place: 'цены тарифов',
  excerpt: 'Тариф «Макс» стоит 5990 ₽',
  explanation: 'Такого тарифа нет.',
  confidence: 0.95,
}

interface Harness {
  reviewer: ConversationReviewer
  found: ReviewedFinding[]
  summaries: unknown[]
  errors: string[]
}

function open(options: { usdPerDay?: number; retryDelaysMs?: number[]; timeZone?: string } = {}): Harness {
  const harness: Harness = { found: [], summaries: [], errors: [], reviewer: undefined as never }
  harness.reviewer = createConversationReviewer({
    botDescription: BOT_DESCRIPTION,
    usdPerDay: options.usdPerDay ?? 1,
    minConfidence: 0.7,
    ...(options.timeZone === undefined ? {} : { timeZone: options.timeZone }),
    model: createModelRoute({
      primary: { baseUrl: model.baseUrl, apiKey: 'test-primary-key', model: 'deepseek-flash' },
      fallback: { baseUrl: model.baseUrl, apiKey: 'test-fallback-key', model: 'deepseek/deepseek-v4.1-flash-1017' },
    }),
    stateFile: join(dir, 'review-web.json'),
    retryDelaysMs: options.retryDelaysMs ?? [20, 20],
    summaryDelayMs: 30,
    onFinding: (finding) => harness.found.push(finding),
    onDeferredSummary: (summary) => harness.summaries.push(summary),
    onError: (what) => harness.errors.push(what),
  })
  reviewers.push(harness.reviewer)
  return harness
}

function finish(harness: Harness, id: string, messages: ConversationMessage[] = talk): void {
  harness.reviewer.conversationFinished({ id, messages, meta: { chatId: 'chat-7' } })
}

beforeEach(async () => {
  model = await startFakeModel()
  dir = mkdtempSync(join(tmpdir(), 'remontnik-reviewer-'))
})

afterEach(async () => {
  for (const reviewer of reviewers.splice(0)) reviewer.close()
  await model.close()
})

describe('чтение разговоров', () => {
  it('conversationFinished возвращается сразу и не ходит в сеть; чтение идёт в фоне', async () => {
    const harness = open()
    model.replyNext({ findings: [badFinding] })

    finish(harness, 'talk-1')

    expect(model.requests).toHaveLength(0)
    expect(harness.found).toHaveLength(0)
    await harness.reviewer.idle()
    expect(model.requests).toHaveLength(1)
    expect(harness.found).toHaveLength(1)
  })

  it('находка уходит с видом, выдержкой, номером сообщения, уверенностью и номером разговора', async () => {
    const harness = open()
    model.replyNext({ findings: [badFinding] })

    finish(harness, 'talk-1')
    await harness.reviewer.idle()

    expect(harness.found[0]).toMatchObject({
      conversationId: 'talk-1',
      meta: { chatId: 'chat-7' },
      finding: { messageIndex: 1, category: 'fabrication', place: 'цены тарифов', confidence: 0.95 },
    })
  })

  it('хороший разговор — без находок; находки ниже порога уверенности не доходят', async () => {
    const harness = open()
    model.replyNext({ findings: [] })
    model.replyNext({ findings: [{ ...badFinding, confidence: 0.4 }] })

    finish(harness, 'good')
    finish(harness, 'unsure')
    await harness.reviewer.idle()

    expect(model.requests).toHaveLength(2)
    expect(harness.found).toHaveLength(0)
  })

  it('разговоры читаются по одному, а модели уходит маскированный текст с неизменным началом', async () => {
    const harness = open()
    model.replyNext({ findings: [] })
    model.replyNext({ findings: [] })

    finish(harness, 'one')
    finish(harness, 'two', [{ role: 'user', content: 'другое' }, { role: 'assistant', content: 'ответ' }])
    await harness.reviewer.idle()

    const [first, second] = model.requests.map((request) => request.body.messages as { role: string; content: string }[])
    expect(first?.[0]?.content).toBe(second?.[0]?.content)
    expect(JSON.stringify(model.requests)).not.toContain('ivan@example.com')
    expect(first?.[1]?.content).toContain('[почта]')
    expect(model.requests[0]?.body.temperature).toBe(0)
    expect(model.requests[0]?.body.response_format).toEqual({ type: 'json_object' })
  })

  it('сбой модели: разговор повторяется позже и в итоге читается', async () => {
    const harness = open()
    model.failNext(503)
    model.failNext(503)
    model.replyNext({ findings: [badFinding] })

    finish(harness, 'flaky')
    await harness.reviewer.idle()

    expect(harness.found).toHaveLength(1)
    expect(harness.errors).toEqual([])
  })

  it('ответ не по контракту: повтор, потом отказ с записью ошибки, находок нет', async () => {
    const harness = open({ retryDelaysMs: [10, 10] })
    for (let attempt = 0; attempt < 3; attempt += 1) model.replyNext({ findings: [{ ...badFinding, category: 'скука' }] })

    finish(harness, 'broken')
    await harness.reviewer.idle()

    expect(model.requests).toHaveLength(3)
    expect(harness.found).toHaveLength(0)
    expect(harness.errors).toHaveLength(1)
    expect(harness.reviewer.stats().failed).toBe(1)
  })

  it('ответ модели не JSON: попытки исчерпаны без находок и без исключений наружу', async () => {
    const harness = open({ retryDelaysMs: [10, 10] })
    for (let attempt = 0; attempt < 3; attempt += 1) model.replyTextNext('это не json')

    finish(harness, 'garbage')
    await harness.reviewer.idle()

    expect(harness.found).toHaveLength(0)
    expect(harness.reviewer.stats().failed).toBe(1)
  })

  it('отказ клиента (401) не повторяется', async () => {
    const harness = open()
    model.failNext(401)

    finish(harness, 'unauthorized')
    await harness.reviewer.idle()

    expect(model.requests).toHaveLength(1)
    expect(harness.reviewer.stats().failed).toBe(1)
  })

  it('мусор вместо разговора не роняет и не ставится в очередь', async () => {
    const harness = open()

    expect(() => harness.reviewer.conversationFinished(null as never)).not.toThrow()
    expect(() => harness.reviewer.conversationFinished({ id: 5, messages: 'x' } as never)).not.toThrow()
    expect(() => harness.reviewer.conversationFinished({ id: 'empty', messages: [] })).not.toThrow()
    expect(() => harness.reviewer.conversationFinished({ id: 'only-user', messages: [{ role: 'user', content: 'привет' }] })).not.toThrow()
    await harness.reviewer.idle()

    expect(model.requests).toHaveLength(0)
  })

  it('разговор повторно с тем же номером читается один раз', async () => {
    const harness = open()
    model.replyNext({ findings: [] })

    finish(harness, 'same')
    finish(harness, 'same')
    await harness.reviewer.idle()

    expect(model.requests).toHaveLength(1)
  })

  it('отправляет учёт стоимости из ответа модели в расход за сутки', async () => {
    const harness = open()
    model.replyNext({ findings: [] }, { promptTokens: 1000, completionTokens: 100, costUsd: 0.0123 })

    finish(harness, 'priced')
    await harness.reviewer.idle()

    expect(harness.reviewer.stats().spentUsd).toBeCloseTo(0.0123, 6)
  })

  it('без стоимости в ответе расход считается по токенам с учётом кэша', async () => {
    const harness = open()
    model.replyNext({ findings: [] }, { promptTokens: 10_000, completionTokens: 1000, cachedPromptTokens: 9_000 })

    finish(harness, 'tokens')
    await harness.reviewer.idle()

    const spent = harness.reviewer.stats().spentUsd
    expect(spent).toBeGreaterThan(0)
    expect(spent).toBeLessThan(10_000 * 0.3e-6 + 1000 * 1.2e-6)
  })
})

describe('суточный бюджет чтения', () => {
  it('бюджет не превышается: лишние разговоры откладываются, владелец получает сводку «отложено N»', async () => {
    // На одну оценку нужно порядка тысячных долей доллара; бюджета хватает меньше чем на два разговора.
    const harness = open({ usdPerDay: 0.0035 })
    for (let index = 0; index < 5; index += 1) model.replyNext({ findings: [] }, { costUsd: 0.003 })

    for (const id of ['a', 'b', 'c', 'd']) finish(harness, id)
    await harness.reviewer.idle()

    const stats = harness.reviewer.stats()
    expect(stats.reviewed).toBe(1)
    expect(stats.deferred).toBe(3)
    expect(stats.spentUsd).toBeLessThanOrEqual(0.0035)
    expect(model.requests).toHaveLength(1)
    expect(harness.summaries).toEqual([expect.objectContaining({ deferred: 3, usdPerDay: 0.0035 })])
  })

  it('нулевой бюджет — ни одного запроса к модели', async () => {
    const harness = open({ usdPerDay: 0 })

    finish(harness, 'a')
    await harness.reviewer.idle()

    expect(model.requests).toHaveLength(0)
    expect(harness.reviewer.stats().deferred).toBe(1)
  })
})
