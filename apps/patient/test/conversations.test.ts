import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { createBot } from '../src/bot/bot.ts'
import { createConversationLog, type FinishedConversation } from '../src/bot/conversations.ts'
import { createPatientServer } from '../src/server.ts'
import type { PatientBug } from '../src/bugs.ts'

// Разговоры «Пациента»: где они закрываются и что отдают сторожу; заложенный плохой ответ.

describe('бот с заложенным плохим ответом (bad_answer)', () => {
  it('на вопрос про несуществующий тариф «Макс» выдумывает цену; без ошибки такого не делает', async () => {
    const broken = createBot({ bug: 'bad_answer' })
    const healthy = createBot({ bug: null })

    expect(await broken.reply('Сколько стоит тариф Макс?')).toContain('5990')
    expect(await healthy.reply('Сколько стоит тариф Макс?')).not.toContain('5990')
  })

  it('остальные ответы при bad_answer обычные', async () => {
    const broken = createBot({ bug: 'bad_answer' })

    expect(await broken.reply('Сколько стоит тариф Про?')).toContain('2990')
    expect(await broken.reply('Привет')).toContain('Здравствуйте')
  })
})

describe('журнал разговоров', () => {
  function open(
    options: { idleAfterMs?: number; maxMessages?: number; maxOpen?: number; maxMessageChars?: number; maxConversationChars?: number; maxOpenChars?: number } = {},
  ) {
    const finished: FinishedConversation[] = []
    let clock = 1_000
    const log = createConversationLog({ onFinished: (conversation) => finished.push(conversation), now: () => clock, ...options })
    return { log, finished, advance: (ms: number) => (clock += ms) }
  }

  it('собирает реплики владельца в один разговор с номером от сервера и отдаёт законченный один раз', () => {
    const { log, finished } = open()

    const first = log.record('alice', 'Привет', 'Здравствуйте!')
    const second = log.record('alice', 'Сколько стоит Про?', '2990 ₽')
    expect(second).toBe(first)
    expect(first).toMatch(/^[0-9a-f]{24}$/)
    expect(log.finish('alice')).toBe(true)
    expect(log.finish('alice')).toBe(false)

    expect(finished).toEqual([
      {
        id: first,
        messages: [
          { role: 'user', content: 'Привет' },
          { role: 'assistant', content: 'Здравствуйте!' },
          { role: 'user', content: 'Сколько стоит Про?' },
          { role: 'assistant', content: '2990 ₽' },
        ],
      },
    ])
  })

  it('после закрытия тот же владелец начинает новый разговор с новым номером', () => {
    const { log } = open()
    const first = log.record('alice', 'Привет', 'Здравствуйте!')
    log.finish('alice')

    expect(log.record('alice', 'Ещё вопрос', 'Слушаю')).not.toBe(first)
  })

  it('чужой разговор закрыть нельзя: у другого владельца своего разговора нет', () => {
    const { log, finished } = open()
    log.record('alice', 'Привет', 'Здравствуйте!')

    expect(log.finish('bob')).toBe(false)
    expect(finished).toEqual([])
  })

  it('молчащий разговор закрывается сам через заданное время', () => {
    const { log, finished, advance } = open({ idleAfterMs: 60_000 })
    const quiet = log.record('quiet', 'Привет', 'Здравствуйте!')
    advance(30_000)
    const busy = log.record('busy', 'Привет', 'Здравствуйте!')

    advance(40_000)
    log.finishIdle()

    expect(finished.map((conversation) => conversation.id)).toEqual([quiet])
    advance(60_000)
    log.finishIdle()
    expect(finished.map((conversation) => conversation.id)).toEqual([quiet, busy])
  })

  it('потолки: не больше открытых разговоров и сообщений в разговоре', () => {
    const { log, finished } = open({ maxOpen: 2, maxMessages: 4 })
    let long = ''
    for (let turn = 0; turn < 5; turn += 1) long = log.record('long', `вопрос ${turn}`, `ответ ${turn}`)
    log.record('b', 'раз', 'раз')
    log.record('c', 'два', 'два')

    expect(finished.map((conversation) => conversation.id)).toEqual([long])
    expect(finished[0]?.messages).toHaveLength(4)
    expect(finished[0]?.messages.at(-1)?.content).toBe('ответ 4')
  })

  it('длинная реплика обрезается, длинный разговор теряет самые старые реплики', () => {
    const { log, finished } = open({ maxMessageChars: 100, maxConversationChars: 450 })
    for (let turn = 0; turn < 6; turn += 1) log.record('talker', `${turn}`.repeat(500), `ответ ${turn}`)
    log.finish('talker')

    const messages = finished[0]?.messages ?? []
    expect(messages.every((message) => message.content.length <= 100)).toBe(true)
    expect(messages.reduce((sum, message) => sum + message.content.length, 0)).toBeLessThanOrEqual(450)
    expect(messages.at(-1)?.content).toBe('ответ 5')
  })

  it('общий объём открытых разговоров ограничен: самые старые закрываются', () => {
    const { log, finished } = open({ maxOpenChars: 1_000, maxMessageChars: 400 })
    for (let index = 0; index < 20; index += 1) log.record(`owner-${index}`, 'в'.repeat(400), 'о'.repeat(400))

    expect(finished.length).toBeGreaterThanOrEqual(18)
    expect(finished.every((conversation) => conversation.messages.length === 2)).toBe(true)
  })

  it('ошибка получателя не ломает журнал', () => {
    const log = createConversationLog({
      onFinished: () => {
        throw new Error('сторож недоступен')
      },
    })
    log.record('alice', 'Привет', 'Здравствуйте!')

    expect(() => log.finish('alice')).not.toThrow()
  })
})

describe('сервер «Пациента»: закрытие разговора', () => {
  const closers: (() => Promise<void>)[] = []
  afterEach(async () => {
    for (const close of closers.splice(0)) await close()
  })

  async function start(bug: PatientBug | null = null) {
    const finished: FinishedConversation[] = []
    const server = createPatientServer({ bug, conversationFinished: (conversation) => finished.push(conversation) })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    closers.push(() => new Promise<void>((resolve) => server.close(() => resolve())))
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    /** Посетитель с собственной кукой; без `fresh` отправляет её, как браузер. */
    function visitor() {
      let cookie = ''
      return {
        async post(path: string, body: unknown) {
          const response = await fetch(`${url}${path}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
            body: JSON.stringify(body),
          })
          const setCookie = response.headers.get('set-cookie')
          if (setCookie) cookie = setCookie.split(';')[0] ?? ''
          return response
        },
      }
    }
    return { finished, visitor }
  }

  it('чат запоминает разговор посетителя; /api/chat/finish отдаёт его сторожу под номером сервера', async () => {
    const { finished, visitor } = await start('bad_answer')
    const alice = visitor()

    const reply = (await (await alice.post('/api/chat', { message: 'Сколько стоит тариф Макс?' })).json()) as { conversationId: string }
    expect(finished).toEqual([])
    const response = await alice.post('/api/chat/finish', {})

    expect(response.status).toBe(200)
    expect(finished).toHaveLength(1)
    expect(finished[0]).toMatchObject({ id: reply.conversationId })
    expect(finished[0]?.messages[1]).toEqual({ role: 'assistant', content: expect.stringContaining('5990') })
  })

  it('номер разговора от посетителя не принимается: сервер выдаёт свой', async () => {
    const { finished, visitor } = await start()
    const alice = visitor()

    const reply = (await (await alice.post('/api/chat', { message: 'Привет', conversationId: 'мой-номер' })).json()) as { conversationId: string }
    await alice.post('/api/chat/finish', { conversationId: 'мой-номер' })

    expect(reply.conversationId).not.toBe('мой-номер')
    expect(finished.map((conversation) => conversation.id)).toEqual([reply.conversationId])
  })

  it('чужой разговор закрыть нельзя: ни по своей куке, ни без неё, ни подставив чужой номер', async () => {
    const { finished, visitor } = await start()
    const alice = visitor()
    const mallory = visitor()
    const reply = (await (await alice.post('/api/chat', { message: 'Привет' })).json()) as { conversationId: string }
    await mallory.post('/api/chat', { message: 'Привет' })

    const stranger = visitor()
    expect((await stranger.post('/api/chat/finish', { conversationId: reply.conversationId })).status).toBe(404)
    expect(finished).toEqual([])
    expect((await mallory.post('/api/chat/finish', { conversationId: reply.conversationId })).status).toBe(200)
    expect(finished).toHaveLength(1)
    expect(finished[0]?.id).not.toBe(reply.conversationId)
  })

  it('завершение без разговора — 404', async () => {
    const { finished, visitor } = await start()

    expect((await visitor().post('/api/chat/finish', {})).status).toBe(404)
    expect(finished).toEqual([])
  })
})
