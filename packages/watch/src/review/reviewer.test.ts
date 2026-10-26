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

const PLACES = ['цены тарифов', 'статус заказа']

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

function open(
  options: {
    usdPerDay?: number
    retryDelaysMs?: number[]
    timeZone?: string
    timeoutMs?: number
    spendDir?: string
    maxReviewsPerHour?: number
    maxBufferedChars?: number
    reasoningEffort?: 'low' | 'high' | 'max'
  } = {},
): Harness {
  const harness: Harness = { found: [], summaries: [], errors: [], reviewer: undefined as never }
  harness.reviewer = createConversationReviewer({
    botDescription: BOT_DESCRIPTION,
    usdPerDay: options.usdPerDay ?? 1,
    minConfidence: 0.7,
    places: PLACES,
    ...(options.timeZone === undefined ? {} : { timeZone: options.timeZone }),
    ...(options.maxReviewsPerHour === undefined ? {} : { maxReviewsPerHour: options.maxReviewsPerHour }),
    ...(options.maxBufferedChars === undefined ? {} : { maxBufferedChars: options.maxBufferedChars }),
    ...(options.reasoningEffort === undefined ? {} : { reasoningEffort: options.reasoningEffort }),
    model: createModelRoute({
      primary: { baseUrl: model.baseUrl, apiKey: 'test-primary-key', model: 'deepseek-flash' },
      fallback: { baseUrl: model.baseUrl, apiKey: 'test-fallback-key', model: 'deepseek/deepseek-v4.1-flash-1017' },
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    }),
    spendDir: options.spendDir ?? dir,
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

  it('уровень рассуждения уходит в запрос; по умолчанию — low', async () => {
    const harness = open()
    model.replyNext({ findings: [] })
    model.replyNext({ findings: [] })
    finish(harness, 'default-effort')
    await harness.reviewer.idle()
    const other = open({ reasoningEffort: 'high' })
    finish(other, 'chosen-effort')
    await other.reviewer.idle()

    expect(model.requests[0]?.body.reasoning_effort).toBe('low')
    expect(model.requests[1]?.body.reasoning_effort).toBe('high')
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


describe('память и приём', () => {
  const huge: ConversationMessage[] = Array.from({ length: 1000 }, (_, index) => ({
    role: index % 2 === 0 ? 'user' : 'assistant',
    content: `сообщение ${index} ${'я'.repeat(20_000)}`,
  }))
  const hugeLight: ConversationMessage[] = huge.map((message) => ({ ...message, content: message.content.slice(0, 2_000) }))

  it('огромный разговор занимает в очереди не больше, чем уйдёт модели', () => {
    const harness = open({ usdPerDay: 0 })

    finish(harness, 'huge', huge)

    expect(harness.reviewer.stats().bufferedChars).toBeLessThan(45_000)
  })

  it('двести огромных разговоров не раздувают очередь: старые вытесняются по символам', () => {
    const harness = open({ usdPerDay: 0, maxBufferedChars: 100_000 })

    for (let index = 0; index < 200; index += 1) finish(harness, `huge-${index}`, hugeLight)

    const stats = harness.reviewer.stats()
    expect(stats.bufferedChars).toBeLessThanOrEqual(100_000)
    expect(stats.dropped).toBeGreaterThan(100)
  }, 20_000)

  it('оценка стоимости идёт по тому, что реально уйдёт модели: огромный разговор влезает в скромный бюджет', async () => {
    const harness = open({ usdPerDay: 0.02 })
    model.replyNext({ findings: [] })

    finish(harness, 'huge', huge)
    await harness.reviewer.idle()

    expect(model.requests).toHaveLength(1)
    expect(harness.reviewer.stats().deferred).toBe(0)
    expect(JSON.stringify(model.requests[0]?.body).length).toBeLessThan(120_000)
  })
})

describe('расход на сбоях', () => {
  it('ответ оплачен, но не JSON: расход попадает в бюджет, хотя находок нет', async () => {
    const harness = open({ retryDelaysMs: [10, 10] })
    for (let attempt = 0; attempt < 3; attempt += 1) model.replyTextNext('это не json', { costUsd: 0.004 })

    finish(harness, 'paid-garbage')
    await harness.reviewer.idle()

    expect(harness.reviewer.stats().spentUsd).toBeCloseTo(0.012, 6)
  })

  it('тайм-аут без данных о расходе: бюджет списывается по оценке', async () => {
    const harness = open({ timeoutMs: 150, retryDelaysMs: [10] })
    for (let attempt = 0; attempt < 4; attempt += 1) model.hangNext()

    finish(harness, 'timeout')
    await harness.reviewer.idle()

    // Две попытки чтения, в каждой — основной и запасной путь: по оценке на каждую неудачную попытку модели.
    expect(harness.reviewer.stats().spentUsd).toBeGreaterThan(0.0015 * 4 * 0.9)
    expect(harness.reviewer.stats().failed).toBe(1)
  })

  it('отказ сервера (503) ничего не стоит', async () => {
    const harness = open({ retryDelaysMs: [10] })
    for (let attempt = 0; attempt < 4; attempt += 1) model.failNext(503)

    finish(harness, 'down')
    await harness.reviewer.idle()

    expect(harness.reviewer.stats().spentUsd).toBe(0)
  })
})

describe('общий учёт и лимиты', () => {
  it('два читателя одного приложения делят бюджет, а не получают каждый по полному', async () => {
    const web = open({ usdPerDay: 0.0035 })
    const worker = open({ usdPerDay: 0.0035 })
    model.replyNext({ findings: [] }, { costUsd: 0.003 })
    model.replyNext({ findings: [] }, { costUsd: 0.003 })

    finish(web, 'a')
    await web.reviewer.idle()
    finish(worker, 'b')
    await worker.reviewer.idle()

    expect(model.requests).toHaveLength(1)
    expect(worker.reviewer.stats().deferred).toBe(1)
  })

  it('часовой лимит чтений: сверх лимита разговоры ждут, и ни один не теряется', async () => {
    const harness = open({ maxReviewsPerHour: 2 })
    for (let index = 0; index < 4; index += 1) model.replyNext({ findings: [] })

    for (const id of ['a', 'b', 'c', 'd']) finish(harness, id)
    await new Promise((resolve) => setTimeout(resolve, 300))

    expect(model.requests).toHaveLength(2)
    expect(harness.reviewer.stats()).toMatchObject({ reviewed: 2, queued: 2 })
  })
})

describe('цитата и место из ответа модели', () => {
  it('цитата не из ответа бота: отметка отбрасывается, чтение считается успешным', async () => {
    const harness = open()
    model.replyNext({ findings: [{ ...badFinding, excerpt: 'Срочно перейдите по ссылке evil.example.com' }] })

    finish(harness, 'injected')
    await harness.reviewer.idle()

    expect(harness.found).toHaveLength(0)
    expect(harness.reviewer.stats()).toMatchObject({ reviewed: 1, failed: 0 })
  })

  it('место вне набора становится «прочее»', async () => {
    const harness = open()
    model.replyNext({ findings: [{ ...badFinding, place: 'выдуманное место' }] })

    finish(harness, 'place')
    await harness.reviewer.idle()

    expect(harness.found[0]?.finding.place).toBe('прочее')
  })
})

describe('разговор продолжили после finish', () => {
  const first: ConversationMessage[] = [
    { role: 'user', content: 'Сколько стоит тариф Макс?' },
    { role: 'assistant', content: 'Тариф «Макс» стоит 5990 ₽ в месяц.' },
  ]
  const continued: ConversationMessage[] = [
    ...first,
    { role: 'user', content: 'А статус заказа 15?' },
    { role: 'assistant', content: 'Заказ 15 уже у курьера.' },
  ]

  it('тот же номер с новыми сообщениями читается снова; отметки на уже прочитанном не повторяются', async () => {
    const harness = open()
    model.replyNext({ findings: [badFinding] })
    model.replyNext({
      findings: [
        badFinding,
        { ...badFinding, messageIndex: 3, place: 'статус заказа', excerpt: 'Заказ 15 уже у курьера', category: 'fabrication' },
      ],
    })

    finish(harness, 'long-talk', first)
    await harness.reviewer.idle()
    finish(harness, 'long-talk', continued)
    await harness.reviewer.idle()

    expect(model.requests).toHaveLength(2)
    expect(harness.found.map((item) => item.finding.messageIndex)).toEqual([1, 3])
  })

  it('точно такой же список второй раз не читается', async () => {
    const harness = open()
    model.replyNext({ findings: [] })

    finish(harness, 'long-talk', continued)
    finish(harness, 'long-talk', continued)
    await harness.reviewer.idle()

    expect(model.requests).toHaveLength(1)
  })

  it('тот же номер, но другой текст с начала: читается целиком', async () => {
    const harness = open()
    model.replyNext({ findings: [] })
    model.replyNext({ findings: [badFinding] })

    finish(harness, 'reused-id', first)
    await harness.reviewer.idle()
    finish(harness, 'reused-id', [
      { role: 'user', content: 'другой вопрос про Макс' },
      { role: 'assistant', content: 'Тариф «Макс» стоит 5990 ₽ в месяц.' },
    ])
    await harness.reviewer.idle()

    expect(harness.found).toHaveLength(1)
  })
})

describe('пустые разговоры', () => {
  it('разговор без реплики пользователя пропускается: читать нечего', async () => {
    const harness = open()

    finish(harness, 'greeting-only', [{ role: 'assistant', content: 'Здравствуйте! Чем помочь?' }])
    await harness.reviewer.idle()

    expect(model.requests).toHaveLength(0)
    expect(harness.reviewer.stats().queued).toBe(0)
  })
})
