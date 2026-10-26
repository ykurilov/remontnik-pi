import { expect, test } from '@playwright/test'
import { DEMO_LOGIN, refOf, startTestBrowser } from './helpers.js'

test('опасные действия, чужой сайт, запрос вне списка, капча и код → отказы и needs_human', async () => {
  const browser = await startTestBrowser()
  try {
    // Чужой сайт: переход отклонён до сети.
    expect(await browser.call('url', { url: 'https://elsewhere.invalid/' })).toMatchObject({ ok: false, code: 'refused_origin' })

    const login = await browser.call('url', { url: `${browser.patientUrl}/login` })
    const submitRef = refOf(login.snapshot, 'button', 'Войти')
    for (const danger of ['send', 'pay', 'delete', 'publish']) {
      expect(await browser.call('click', { ref: submitRef, danger })).toMatchObject({ ok: false, code: 'refused_danger' })
      expect(await browser.call('type', { ref: refOf(login.snapshot, 'textbox', 'Почта'), text: 'x', danger })).toMatchObject({
        ok: false,
        code: 'refused_danger',
      })
    }
    expect(await browser.call('click', { ref: submitRef })).toMatchObject({ ok: false, code: 'bad_request' })

    // Вход разрешён списком allowedMutations.
    await browser.call('type', { ref: refOf(login.snapshot, 'textbox', 'Почта'), text: DEMO_LOGIN, danger: 'none' })
    await browser.call('fill-password', { entryId: browser.entryId, ref: refOf(login.snapshot, 'textbox', 'Пароль') })
    const cabinet = await browser.call('click', { ref: submitRef, danger: 'submit' })
    expect(cabinet).toMatchObject({ ok: true, title: 'Кабинет — Пациент' })

    // «Оплатить» с неверно указанным видом действия: сетевой замок всё равно режет POST /api/pay.
    const pay = await browser.call('click', { ref: refOf(cabinet.snapshot, 'button', 'Оплатить тариф Про'), danger: 'none' })
    expect(pay).toMatchObject({ ok: false, code: 'refused_mutation' })
    expect(pay.message).toContain('POST /api/pay')
    await expect.poll(async () => (await browser.call('read')).snapshot).toContain('Оплата не прошла')
    expect(browser.logs.some((line) => line.includes('"blocked"') && line.includes('/api/pay'))).toBe(true)

    // Разрешённое изменение — сообщение боту в веб-чате.
    const chat = await browser.call('url', { url: `${browser.patientUrl}/chat` })
    const sent = await browser.call('type', { ref: refOf(chat.snapshot, 'textbox', ''), text: 'Какие тарифы есть?', submit: true, danger: 'submit' })
    expect(sent).toMatchObject({ ok: true })
    await expect.poll(async () => (await browser.call('read')).snapshot).toMatch(/Бот: /)

    // Капча и поле одноразового кода: нужен человек.
    expect(await browser.call('url', { url: `${browser.patientUrl}/captcha` })).toMatchObject({ ok: false, code: 'needs_human' })
    expect(await browser.call('status')).toMatchObject({ state: 'needs_human' })
    expect(await browser.call('url', { url: `${browser.patientUrl}/confirm-code` })).toMatchObject({ ok: false, code: 'needs_human' })
    expect(await browser.call('url', { url: `${browser.patientUrl}/` })).toMatchObject({ ok: true })
    expect(await browser.call('status')).toMatchObject({ state: 'ready' })

    // Профиль обязателен, неизвестный профиль — not_found.
    expect(await browser.call('read', { profile: 'nobody' })).toMatchObject({ ok: false, code: 'not_found' })
  } finally {
    await browser.close()
  }
})
