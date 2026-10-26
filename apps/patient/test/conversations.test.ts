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
  function open(options: { idleAfterMs?: number; maxMessages?: number; maxOpen?: number } = {}) {
    const finished: FinishedConversation[] = []
    let clock = 1_000
    const log = createConversationLog({ onFinished: (conversation) => finished.push(conversation), now: () => clock, ...options })
    return { log, finished, advance: (ms: number) => (clock += ms) }
  }

  it('собирает реплики по номеру разговора и отдаёт законченный один раз', () => {
    const { log, finished } = open()

    log.record('talk-1', 'Привет', 'Здравствуйте!')
    log.record('talk-1', 'Сколько стоит Про?', '2990 ₽')
    expect(log.finish('talk-1')).toBe(true)
    expect(log.finish('talk-1')).toBe(false)

    expect(finished).toEqual([
      {
        id: 'talk-1',
        messages: [
          { role: 'user', content: 'Привет' },
          { role: 'assistant', content: 'Здравствуйте!' },
          { role: 'user', content: 'Сколько стоит Про?' },
          { role: 'assistant', content: '2990 ₽' },
        ],
      },
    ])
  })

  it('неизвестный разговор закончить нельзя', () => {
    const { log, finished } = open()

    expect(log.finish('нет такого')).toBe(false)
    expect(finished).toEqual([])
  })

  it('молчащий разговор закрывается сам через заданное время', () => {
    const { log, finished, advance } = open({ idleAfterMs: 60_000 })
    log.record('quiet', 'Привет', 'Здравствуйте!')
    advance(30_000)
    log.record('busy', 'Привет', 'Здравствуйте!')

    advance(40_000)
    log.finishIdle()

    expect(finished.map((conversation) => conversation.id)).toEqual(['quiet'])
    advance(60_000)
    log.finishIdle()
    expect(finished.map((conversation) => conversation.id)).toEqual(['quiet', 'busy'])
  })

  it('потолки: не больше открытых разговоров и сообщений в разговоре', () => {
    const { log, finished } = open({ maxOpen: 2, maxMessages: 4 })
    for (let turn = 0; turn < 5; turn += 1) log.record('long', `вопрос ${turn}`, `ответ ${turn}`)
    log.record('b', 'раз', 'раз')
    log.record('c', 'два', 'два')

    expect(finished.map((conversation) => conversation.id)).toEqual(['long'])
    expect(finished[0]?.messages).toHaveLength(4)
    expect(finished[0]?.messages.at(-1)?.content).toBe('ответ 4')
  })

  it('ошибка получателя не ломает журнал', () => {
    const log = createConversationLog({
      onFinished: () => {
        throw new Error('сторож недоступен')
      },
    })
    log.record('talk-1', 'Привет', 'Здравствуйте!')

    expect(() => log.finish('talk-1')).not.toThrow()
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
    const post = (path: string, body: unknown) =>
      fetch(`${url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    return { finished, post }
  }

  it('чат с номером разговора запоминается, /api/chat/finish отдаёт его сторожу', async () => {
    const { finished, post } = await start('bad_answer')

    await post('/api/chat', { message: 'Сколько стоит тариф Макс?', conversationId: 'talk-1' })
    expect(finished).toEqual([])
    const response = await post('/api/chat/finish', { conversationId: 'talk-1' })

    expect(response.status).toBe(200)
    expect(finished).toHaveLength(1)
    expect(finished[0]).toMatchObject({ id: 'talk-1' })
    expect(finished[0]?.messages[1]).toEqual({ role: 'assistant', content: expect.stringContaining('5990') })
  })

  it('чат без номера разговора работает как раньше и ничего не запоминает', async () => {
    const { finished, post } = await start()

    expect((await post('/api/chat', { message: 'Привет' })).status).toBe(200)
    expect((await post('/api/chat/finish', { conversationId: 'нет' })).status).toBe(404)
    expect(finished).toEqual([])
  })

  it('завершение без номера — 400', async () => {
    const { post } = await start()

    expect((await post('/api/chat/finish', {})).status).toBe(400)
  })
})
