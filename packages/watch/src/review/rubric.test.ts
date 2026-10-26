import { describe, expect, it } from 'vitest'
import { BOT_DESCRIPTION } from '../../test/fixtures/conversations.js'
import {
  BAD_ANSWER_CATEGORIES,
  MAX_FINDINGS_PER_CONVERSATION,
  ReviewResponseError,
  buildReviewRequest,
  parseReviewResponse,
  type ConversationMessage,
} from './rubric.js'

const identity = (text: string): string => text

const talk: ConversationMessage[] = [
  { role: 'user', content: 'Сколько стоит тариф Про?' },
  { role: 'assistant', content: 'Тариф «Про» стоит 2990 ₽ в месяц.' },
  { role: 'user', content: 'А Старт?' },
  { role: 'assistant', content: 'Тариф «Старт» стоит 990 ₽ в месяц.' },
]

function finding(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    messageIndex: 1,
    category: 'fabrication',
    place: 'цены тарифов',
    excerpt: 'Тариф «Про» стоит 2990 ₽',
    explanation: 'Названа цена, которой нет в описании бота.',
    confidence: 0.9,
    ...overrides,
  }
}

const parse = (findings: unknown, options: { minConfidence?: number; messages?: ConversationMessage[] } = {}) =>
  parseReviewResponse({ findings }, { messages: options.messages ?? talk, minConfidence: options.minConfidence ?? 0.7 })

describe('рубрика: запрос к модели', () => {
  it('неизменная часть идёт первым сообщением и одинакова байт в байт для любых разговоров', () => {
    const first = buildReviewRequest({ botDescription: BOT_DESCRIPTION, messages: talk, redact: identity })
    const second = buildReviewRequest({
      botDescription: BOT_DESCRIPTION,
      messages: [{ role: 'user', content: 'совсем другой разговор' }, { role: 'assistant', content: 'и другой ответ' }],
      redact: identity,
    })

    expect(first.messages[0]?.role).toBe('system')
    expect(first.messages[0]?.content).toBe(second.messages[0]?.content)
    expect(Buffer.from(first.messages[0]?.content ?? '').equals(Buffer.from(second.messages[0]?.content ?? ''))).toBe(true)
    expect(first.messages).toHaveLength(2)
    expect(first.messages[1]?.role).toBe('user')
    expect(first.messages[1]?.content).not.toBe(second.messages[1]?.content)
  })

  it('в неизменной части — описание бота и все виды нарушений, а текст разговора в неё не попадает', () => {
    const request = buildReviewRequest({ botDescription: BOT_DESCRIPTION, messages: talk, redact: identity })
    const prefix = request.messages[0]?.content ?? ''

    expect(prefix).toContain(BOT_DESCRIPTION)
    for (const category of BAD_ANSWER_CATEGORIES) expect(prefix).toContain(category)
    expect(prefix).not.toContain('Сколько стоит тариф Про?')
    expect(prefix).toMatch(/json/i)
  })

  it('номера сообщений в разговоре — как в исходном списке', () => {
    const request = buildReviewRequest({ botDescription: BOT_DESCRIPTION, messages: talk, redact: identity })
    const conversation = request.messages[1]?.content ?? ''

    expect(conversation).toContain('[0] user')
    expect(conversation).toContain('[3] assistant')
    expect(conversation.indexOf('[1] assistant')).toBeLessThan(conversation.indexOf('[2] user'))
  })

  it('личные данные замаскированы до модели: почта, телефон, ключ, токен', () => {
    const key = `sk-${'a1B2'.repeat(6)}`
    const request = buildReviewRequest({
      botDescription: BOT_DESCRIPTION,
      messages: [
        { role: 'user', content: `Меня зовут Иван, почта ivan.petrov@example.com, телефон +7 900 000-12-34, ключ ${key}` },
        { role: 'assistant', content: 'Пароль: password=hunter2222 передан оператору.' },
      ],
      redact: identity,
    })
    const everything = JSON.stringify(request)

    expect(everything).not.toContain('ivan.petrov@example.com')
    expect(everything).not.toContain('900 000-12-34')
    expect(everything).not.toContain(key)
    expect(everything).not.toContain('hunter2222')
    expect(request.messages[1]?.content).toContain('[почта]')
  })

  it('вычистка приложения применяется к разговору', () => {
    const redact = (text: string) => text.replaceAll('Иван Иванов', '[имя]')
    const request = buildReviewRequest({
      botDescription: 'Бот клиники.',
      messages: [{ role: 'user', content: 'Я Иван Иванов' }, { role: 'assistant', content: 'Здравствуйте!' }],
      redact,
    })

    expect(JSON.stringify(request)).not.toContain('Иван Иванов')
    expect(request.messages[1]?.content).toContain('Я [имя]')
  })

  it('длинные сообщения и длинные разговоры обрезаются, номера не сдвигаются', () => {
    const many: ConversationMessage[] = Array.from({ length: 400 }, (_, index) => ({
      role: index % 2 === 0 ? 'user' : 'assistant',
      content: `сообщение ${index} ${'очень длинный текст '.repeat(200)}`,
    }))
    const request = buildReviewRequest({ botDescription: BOT_DESCRIPTION, messages: many, redact: identity })
    const conversation = request.messages[1]?.content ?? ''

    expect(conversation.length).toBeLessThan(60_000)
    expect(conversation).toContain('[0] user')
    expect(conversation).toContain('[399] assistant')
    expect(conversation).toContain('пропущено')
  })
})

describe('рубрика: разбор ответа модели', () => {
  it('принимает пустой список: хороший разговор', () => {
    expect(parse([])).toEqual([])
  })

  it('принимает полную отметку и отдаёт её без лишнего', () => {
    expect(parse([finding()])).toEqual([
      {
        messageIndex: 1,
        category: 'fabrication',
        place: 'цены тарифов',
        excerpt: 'Тариф «Про» стоит 2990 ₽',
        explanation: 'Названа цена, которой нет в описании бота.',
        confidence: 0.9,
      },
    ])
  })

  it.each([
    ['не объект', 'просто текст'],
    ['null', null],
    ['массив вместо объекта', [finding()]],
    ['нет поля findings', { other: [] }],
    ['findings не список', { findings: 'нет' }],
  ])('отвергает ответ: %s', (_name, json) => {
    expect(() => parseReviewResponse(json, { messages: talk, minConfidence: 0.7 })).toThrow(ReviewResponseError)
  })

  it.each([
    ['номер не число', { messageIndex: '1' }],
    ['номер дробный', { messageIndex: 1.5 }],
    ['номер за пределами разговора', { messageIndex: 40 }],
    ['номер отрицательный', { messageIndex: -1 }],
    ['номер указывает на сообщение пользователя', { messageIndex: 0 }],
    ['вид неизвестен', { category: 'скука' }],
    ['нет выдержки', { excerpt: '' }],
    ['выдержка не строка', { excerpt: 5 }],
    ['нет объяснения', { explanation: '   ' }],
    ['уверенность не число', { confidence: 'высокая' }],
    ['уверенность больше единицы', { confidence: 1.2 }],
    ['уверенность отрицательная', { confidence: -0.1 }],
    ['место не строка', { place: null }],
  ])('отвергает отметку целиком: %s', (_name, broken) => {
    expect(() => parse([finding(), finding(broken)])).toThrow(ReviewResponseError)
  })

  it('отметки ниже порога уверенности отбрасываются, равные порогу остаются', () => {
    const result = parse(
      [
        finding({ messageIndex: 1, confidence: 0.69, place: 'первое' }),
        finding({ messageIndex: 3, confidence: 0.7, place: 'второе' }),
        finding({ messageIndex: 3, confidence: 0.95, place: 'третье' }),
      ],
      { minConfidence: 0.7 },
    )

    expect(result.map((item) => item.place)).toEqual(['третье', 'второе'])
  })

  it('одинаковые отметки (вид + место) склеены: остаётся самая уверенная', () => {
    const result = parse([
      finding({ messageIndex: 1, confidence: 0.75, place: 'Цены тарифов', excerpt: 'первая' }),
      finding({ messageIndex: 3, confidence: 0.92, place: ' цены  тарифов. ', excerpt: 'вторая' }),
      finding({ messageIndex: 3, category: 'rudeness', confidence: 0.8, place: 'цены тарифов' }),
    ])

    expect(result).toHaveLength(2)
    expect(result.find((item) => item.category === 'fabrication')).toMatchObject({ messageIndex: 3, excerpt: 'вторая', confidence: 0.92 })
    expect(result.find((item) => item.category === 'rudeness')).toBeDefined()
  })

  it('отметки идут от самой уверенной и ограничены числом на разговор', () => {
    const many = Array.from({ length: MAX_FINDINGS_PER_CONVERSATION + 3 }, (_, index) =>
      finding({ place: `место ${index}`, confidence: 0.7 + index * 0.01 }),
    )
    const result = parse(many)

    expect(result).toHaveLength(MAX_FINDINGS_PER_CONVERSATION)
    expect(result[0]?.confidence).toBeGreaterThan(result[1]?.confidence ?? 1)
  })

  it('выдержка и объяснение обрезаются по пределам события', () => {
    const [result] = parse([finding({ excerpt: 'я'.repeat(2000), explanation: 'я'.repeat(5000) })])

    expect(result?.excerpt.length).toBeLessThanOrEqual(500)
    expect(result?.explanation.length).toBeLessThanOrEqual(1000)
  })
})
