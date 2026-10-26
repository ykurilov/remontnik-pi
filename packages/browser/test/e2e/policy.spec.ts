import { expect, test } from '@playwright/test'
import { DEMO_LOGIN, refOf, startTestBrowser } from './helpers.js'

test('опасные действия, чужой сайт, запрос вне списка, капча и код → отказы и needs_human', async () => {
  const browser = await startTestBrowser({ live: true })
  try {
    // Профиль ещё не открыт: status не запускает браузер.
    expect(await browser.call('status')).toMatchObject({ ok: true, state: 'ready' })
    expect(browser.logs.some((line) => line.includes('"profile_opened"'))).toBe(false)

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

    // «Оплатить» с заявленным danger: none — служба сама видит оплату по кнопке, до клика.
    const payRef = refOf(cabinet.snapshot, 'button', 'Оплатить тариф Про')
    expect(await browser.call('click', { ref: payRef, danger: 'none' })).toMatchObject({ ok: false, code: 'refused_danger' })
    // Enter на кнопке «Оплатить» в фокусе — та же проверка.
    let focused = cabinet.snapshot ?? ''
    for (let step = 0; step < 8 && !focused.includes('button "Оплатить тариф Про" [active]'); step++) {
      focused = (await browser.call('key', { key: 'Tab' })).snapshot ?? ''
    }
    expect(focused).toContain('button "Оплатить тариф Про" [active]')
    expect(await browser.call('key', { key: 'Enter' })).toMatchObject({ ok: false, code: 'refused_danger' })
    expect(await browser.call('key', { key: 'Space' })).toMatchObject({ ok: false, code: 'refused_danger' })
    expect((await browser.call('read')).snapshot).not.toContain('Оплата не прошла')
    expect(browser.logs.some((line) => line.includes('/api/pay'))).toBe(false)

    // Безобидная по виду кнопка с запросом вне allowedMutations: режет сетевой замок.
    const settings = await browser.call('url', { url: `${browser.patientUrl}/settings` })
    const save = await browser.call('click', { ref: refOf(settings.snapshot, 'button', 'Сохранить настройки'), danger: 'none' })
    expect(save).toMatchObject({ ok: false, code: 'refused_mutation' })
    expect(save.message).toContain('POST /api/settings')
    await expect.poll(async () => (await browser.call('read')).snapshot).toContain('Не сохранено')
    expect(browser.logs.some((line) => line.includes('"blocked"') && line.includes('/api/settings'))).toBe(true)

    // Отправка формы с кнопкой «Удалить аккаунт»: по type+submit, по клику и по Enter в поле.
    const emailRef = refOf(settings.snapshot, 'textbox', 'Почта для подтверждения')
    expect(await browser.call('type', { ref: emailRef, text: DEMO_LOGIN, submit: true, danger: 'submit' })).toMatchObject({ ok: false, code: 'refused_danger' })
    expect(await browser.call('click', { ref: refOf(settings.snapshot, 'button', 'Удалить аккаунт'), danger: 'submit' })).toMatchObject({
      ok: false,
      code: 'refused_danger',
    })
    expect(await browser.call('type', { ref: emailRef, text: DEMO_LOGIN, danger: 'none' })).toMatchObject({ ok: true })
    expect(await browser.call('key', { key: 'Enter' })).toMatchObject({ ok: false, code: 'refused_danger' })
    expect(browser.logs.some((line) => line.includes('/api/account/delete'))).toBe(false)

    // Фрейм чужого сайта не грузится и не попадает в снимок; свой фрейм виден.
    const frames = await browser.call('url', { url: `${browser.patientUrl}/frames` })
    expect(frames).toMatchObject({ ok: true })
    await expect.poll(() => browser.logs.some((line) => line.includes('refused_frame'))).toBe(true)
    const framesRead = await browser.call('read')
    expect(framesRead.snapshot).toContain('Текст своего фрейма')
    expect(framesRead.snapshot).not.toContain('Текст чужого фрейма')
    expect(framesRead.snapshot).toContain('[фрейм=скрыт: сайт вне allowedOrigins]')

    // Разрешённое изменение — сообщение боту в веб-чате.
    const chat = await browser.call('url', { url: `${browser.patientUrl}/chat` })
    const sent = await browser.call('type', { ref: refOf(chat.snapshot, 'textbox', ''), text: 'Какие тарифы есть?', submit: true, danger: 'submit' })
    expect(sent).toMatchObject({ ok: true })
    await expect.poll(async () => (await browser.call('read')).snapshot).toMatch(/Бот: /)

    // Капча: пока её не снял человек, страничные команды врача, кроме read и shot, — отказ.
    expect(await browser.call('url', { url: `${browser.patientUrl}/captcha` })).toMatchObject({ ok: false, code: 'needs_human' })
    expect(await browser.call('status')).toMatchObject({ state: 'needs_human' })
    for (const [command, body] of [
      ['click', { ref: 'f1e2', danger: 'none' }],
      ['type', { ref: 'e2', text: '1', danger: 'none' }],
      ['key', { key: 'Space' }],
      ['scroll', { direction: 'down' }],
      ['back', {}],
      ['url', { url: `${browser.patientUrl}/` }],
      ['fill-password', { entryId: browser.entryId, ref: 'e2' }],
    ] as const) {
      expect(await browser.call(command, body), command).toMatchObject({ ok: false, code: 'needs_human' })
    }
    expect(await browser.call('read')).toMatchObject({ ok: false, code: 'needs_human' })
    expect(await browser.call('shot')).toMatchObject({ ok: true })

    // Владелец решил капчу на живом экране и вернул управление — врач продолжает.
    await browser.ownerControl('take')
    await browser.ownerControl('release')
    expect(await browser.call('status')).toMatchObject({ state: 'ready' })
    expect(await browser.call('url', { url: `${browser.patientUrl}/confirm-code` })).toMatchObject({ ok: false, code: 'needs_human' })
    expect(await browser.call('type', { ref: 'e2', text: '123456', danger: 'none' })).toMatchObject({ ok: false, code: 'needs_human' })
    await browser.ownerControl('take')
    await browser.ownerControl('release')
    expect(await browser.call('url', { url: `${browser.patientUrl}/` })).toMatchObject({ ok: true })
    expect(await browser.call('status')).toMatchObject({ state: 'ready' })

    // Профиль обязателен, неизвестный профиль — not_found.
    expect(await browser.call('read', { profile: 'nobody' })).toMatchObject({ ok: false, code: 'not_found' })
  } finally {
    await browser.close()
  }
})
