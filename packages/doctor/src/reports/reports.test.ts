import { STOP_DEPLOYS_CALLBACK, createTelegramClient } from '@ykurilov/remontnik-core/telegram'
import { startFakeTelegram, type FakeTelegramServer } from '@ykurilov/remontnik-core/testing'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createMemoryRecordStore } from '../records/index.js'
import { REPORT_RETRY_DELAYS_MS, createReports } from './index.js'

const start = Date.parse('2026-10-26T10:00:00Z')
let telegram: FakeTelegramServer
let now: number

function reportsWithTelegram(store = createMemoryRecordStore(), autoDeploy?: () => Promise<'on' | 'stopped'>) {
  return createReports({
    store,
    telegram: { client: createTelegramClient({ botToken: '123456:test-bot-token', apiBaseUrl: telegram.baseUrl }), chatId: 'owner-chat' },
    now: () => now,
    ...(autoDeploy ? { autoDeploy } : {}),
  })
}

beforeEach(async () => {
  telegram = await startFakeTelegram()
  now = start
})

afterEach(async () => {
  await telegram.close()
})

describe('отчёты врача', () => {
  it('номера по порядку — курсор для Paseo', async () => {
    const reports = reportsWithTelegram()

    const first = await reports.add({ type: 'case_received', caseId: 1, short: 'a', telegram: 'not_needed' })
    const second = await reports.add({ type: 'doctor_problem', short: 'b', telegram: 'pending' })

    expect([first.reportId, second.reportId]).toEqual([1, 2])
    expect((await reports.list({ after: 1, limit: 50 })).map((item) => item.reportId)).toEqual([2])
    expect(await reports.get(1)).toMatchObject({ type: 'case_received', caseId: 1, createdAt: new Date(start).toISOString() })
  })

  it('отчёт для Telegram уходит, отметка sent с номером сообщения', async () => {
    const reports = reportsWithTelegram()
    const added = await reports.add({ type: 'doctor_problem', short: 'Врач: задача остановлена', telegram: 'pending' })

    await reports.pump()

    expect(telegram.messages.map((item) => [item.chatId, item.text])).toEqual([['owner-chat', 'Врач: задача остановлена']])
    expect((await reports.get(added.reportId))?.telegram).toEqual({ state: 'sent', attempts: 1, messageId: 1 })
  })

  it('отчёт без Telegram не уходит', async () => {
    const reports = reportsWithTelegram()
    await reports.add({ type: 'case_received', caseId: 1, short: 'принят', telegram: 'not_needed' })

    await reports.pump()

    expect(telegram.messages).toEqual([])
  })

  it('сбой Telegram — повторы 5 с, 30 с, 2 мин, 10 мин; очередь переживает перезапуск', async () => {
    expect(REPORT_RETRY_DELAYS_MS).toEqual([5_000, 30_000, 120_000, 600_000])
    const store = createMemoryRecordStore()
    const reports = reportsWithTelegram(store)
    const added = await reports.add({ type: 'doctor_problem', short: 'x', telegram: 'pending' })
    telegram.failNext(500)
    telegram.failNext(502)

    await reports.pump()
    expect((await reports.get(added.reportId))?.telegram).toMatchObject({ state: 'pending', attempts: 1 })
    now = start + 4_999
    await reports.pump()
    expect(telegram.messages).toEqual([])
    now = start + 5_000
    await reports.pump()
    expect((await reports.get(added.reportId))?.telegram).toMatchObject({ state: 'pending', attempts: 2 })

    const restarted = reportsWithTelegram(store)
    now = start + 5_000 + 30_000
    await restarted.pump()

    expect(telegram.messages).toHaveLength(1)
    expect((await restarted.get(added.reportId))?.telegram).toMatchObject({ state: 'sent', attempts: 3 })
  })

  it('без настроенного Telegram отчёт копится, ошибок нет', async () => {
    const reports = createReports({ store: createMemoryRecordStore(), now: () => now })
    await reports.add({ type: 'doctor_problem', short: 'x', telegram: 'pending' })

    await expect(reports.pump()).resolves.toBeUndefined()
  })

  it('снимки экрана хранятся в отчёте; без снимков поля нет', async () => {
    const reports = createReports({ store: createMemoryRecordStore(), now: () => now })
    const deployed = await reports.add({ type: 'deployed', caseId: 1, short: 'x', telegram: 'not_needed', screenshots: ['/state/shots/1-a.png'] })
    const plain = await reports.add({ type: 'deployed', caseId: 1, short: 'y', telegram: 'not_needed' })

    expect((await reports.get(deployed.reportId))?.screenshots).toEqual(['/state/shots/1-a.png'])
    expect(await reports.get(plain.reportId)).not.toHaveProperty('screenshots')
  })

  it('отчёт можно записать внутри чужой транзакции: откат убирает и его', async () => {
    const store = createMemoryRecordStore()
    const reports = reportsWithTelegram(store)

    await expect(
      store.transaction(async (tx) => {
        await reports.addIn(tx, { type: 'case_received', caseId: 1, short: 'x', telegram: 'not_needed' })
        throw new Error('stop')
      }),
    ).rejects.toThrow('stop')
    const added = await store.transaction((tx) => reports.addIn(tx, { type: 'case_received', caseId: 1, short: 'y', telegram: 'not_needed' }))

    expect(added.reportId).toBe(1)
    expect(await reports.get(1)).toMatchObject({ short: 'y' })
  })

  it('короткий текст не длиннее 1000 знаков', async () => {
    const reports = reportsWithTelegram()

    const added = await reports.add({ type: 'doctor_problem', short: 'x'.repeat(5000), telegram: 'not_needed' })

    expect(added.short.length).toBeLessThanOrEqual(1000)
  })
})

describe('кнопка стоп-крана под отчётами', () => {
  const stopButton = { inline_keyboard: [[{ text: 'Остановить автовыкатку', callback_data: STOP_DEPLOYS_CALLBACK }]] }

  it('под отчётами о выкатке и готовой правке — кнопка «Остановить автовыкатку»', async () => {
    expect(STOP_DEPLOYS_CALLBACK).toBe('remontnik:stop')
    const reports = reportsWithTelegram(createMemoryRecordStore(), async () => 'on')
    for (const type of ['fix_ready', 'deployed', 'rolled_back', 'not_helped'] as const) {
      await reports.add({ type, caseId: 1, short: type, telegram: 'pending' })
    }

    await reports.pump()

    expect(telegram.messages.map((item) => [item.text, item.replyMarkup])).toEqual([
      ['fix_ready', stopButton],
      ['deployed', stopButton],
      ['rolled_back', stopButton],
      ['not_helped', stopButton],
    ])
  })

  it('под прочими отчётами кнопки нет', async () => {
    const reports = reportsWithTelegram(createMemoryRecordStore(), async () => 'on')
    await reports.add({ type: 'needs_human', caseId: 1, short: 'нужен человек', telegram: 'pending' })
    await reports.add({ type: 'doctor_problem', short: 'врач', telegram: 'pending' })

    await reports.pump()

    expect(telegram.messages.map((item) => item.replyMarkup)).toEqual([undefined, undefined])
  })

  it('стоп-кран включён — кнопки нет, в тексте сказано, что он включён', async () => {
    const reports = reportsWithTelegram(createMemoryRecordStore(), async () => 'stopped')
    await reports.add({ type: 'deployed', caseId: 1, short: 'Случай 1: правка выкачена.', telegram: 'pending' })
    await reports.add({ type: 'fix_ready', caseId: 2, short: 'Случай 2: включён стоп-кран, правку не выкатывал.', telegram: 'pending' })

    await reports.pump()

    expect(telegram.messages.map((item) => [item.text, item.replyMarkup])).toEqual([
      ['Случай 1: правка выкачена.\n\nСтоп-кран включён: новые выкатки не начнутся.', undefined],
      ['Случай 2: включён стоп-кран, правку не выкатывал.', undefined],
    ])
  })

  it('состояние стоп-крана берётся в момент отправки, а не записи', async () => {
    let state: 'on' | 'stopped' = 'on'
    const reports = reportsWithTelegram(createMemoryRecordStore(), async () => state)
    await reports.add({ type: 'fix_ready', caseId: 1, short: 'готово', telegram: 'pending' })
    state = 'stopped'

    await reports.pump()

    expect(telegram.messages[0]?.replyMarkup).toBeUndefined()
  })

  it('без сведений о стоп-кране кнопки нет', async () => {
    const reports = reportsWithTelegram()
    await reports.add({ type: 'deployed', caseId: 1, short: 'выкачена', telegram: 'pending' })

    await reports.pump()

    expect(telegram.messages.map((item) => [item.text, item.replyMarkup])).toEqual([['выкачена', undefined]])
  })
})
