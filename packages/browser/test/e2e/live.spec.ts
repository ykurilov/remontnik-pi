import { type Page, devices, expect, test } from '@playwright/test'
import { cabinetPage, chatPage } from '../../../../apps/patient/src/pages.ts'
import { DEMO_LOGIN, OWNER_TOKEN, VIEWPORT, refOf, startTestBrowser } from './helpers.js'

type TestBrowser = Awaited<ReturnType<typeof startTestBrowser>>

/** Где элемент «Пациента» на экране службы: та же страница в том же размере окна в браузере теста. */
async function remotePoint(reference: Page, html: string, selector: string) {
  await reference.setViewportSize(VIEWPORT)
  await reference.setContent(html)
  const box = (await reference.locator(selector).boundingBox())!
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
}

/** Владелец открывает живой экран и входит по своему ключу. */
async function ownerOpensLive(owner: Page, browser: TestBrowser) {
  await owner.goto(`${browser.service.liveUrl}/live?profile=remontnik`)
  await owner.getByLabel('Ключ владельца').fill(OWNER_TOKEN)
  await owner.getByRole('button', { name: 'Войти' }).click()
  const screen = owner.locator('#screen')
  await expect.poll(() => screen.getAttribute('data-frames').then(Number)).toBeGreaterThan(0)
  return screen
}

/** Клик по точке страницы службы через экран владельца. */
async function ownerPoint(owner: Page, point: { x: number; y: number }) {
  const box = (await owner.locator('#screen').boundingBox())!
  return { x: box.x + (point.x * box.width) / VIEWPORT.width, y: box.y + (point.y * box.height) / VIEWPORT.height }
}

function expectNoFramesLeaked(browser: TestBrowser) {
  const everything = [...browser.outputs, ...browser.logs].join('\n')
  expect(everything).not.toContain('/9j/')
  expect(everything).not.toContain('screencast')
}

test('живой экран: кадры идут, клик и ввод владельца доходят, врач ждёт, замки работают', async ({ page: owner, browser: testBrowser }) => {
  const browser = await startTestBrowser({ live: true })
  const reference = await testBrowser.newPage()
  try {
    const chat = await browser.call('url', { url: `${browser.patientUrl}/chat` })
    expect(chat).toMatchObject({ ok: true })

    const screen = await ownerOpensLive(owner, browser)
    await owner.getByRole('button', { name: 'Взять управление' }).click()
    await expect(owner.getByRole('button', { name: 'Вернуть' })).toBeVisible()
    expect(await browser.call('read')).toMatchObject({ ok: false, code: 'refused_human_control' })
    expect(await browser.call('status')).toMatchObject({ state: 'busy' })

    // Клик владельца по полю, ввод текста и Enter: сообщение уходит боту (разрешённый запрос).
    const input = await ownerPoint(owner, await remotePoint(reference, chatPage(null), '#chat-input'))
    const framesBefore = Number(await screen.getAttribute('data-frames'))
    const clickedAt = Date.now()
    await owner.mouse.click(input.x, input.y)
    await screen.focus()
    await owner.keyboard.type('Привет от владельца')
    await expect.poll(() => screen.getAttribute('data-frames').then(Number), { timeout: 1000 }).toBeGreaterThan(framesBefore)
    expect(Date.now() - clickedAt).toBeLessThan(5000)
    await owner.keyboard.press('Enter')

    // Вернул управление — врач снова работает и видит итог ввода владельца.
    await owner.getByRole('button', { name: 'Вернуть' }).click()
    await expect(owner.getByRole('button', { name: 'Взять управление' })).toBeVisible()
    await expect.poll(async () => (await browser.call('read')).snapshot).toContain('Вы: Привет от владельца')
    await expect.poll(async () => (await browser.call('read')).snapshot).toMatch(/Бот: /)

    // Замок запросов при ручном управлении: оплата из кабинета блокируется.
    const login = await browser.call('url', { url: `${browser.patientUrl}/login` })
    await browser.call('type', { ref: refOf(login.snapshot, 'textbox', 'Почта'), text: DEMO_LOGIN, danger: 'none' })
    await browser.call('fill-password', { entryId: browser.entryId, ref: refOf(login.snapshot, 'textbox', 'Пароль') })
    const cabinet = await browser.call('click', { ref: refOf(login.snapshot, 'button', 'Войти'), danger: 'submit' })
    expect(cabinet).toMatchObject({ ok: true, title: 'Кабинет — Пациент' })
    await owner.getByRole('button', { name: 'Взять управление' }).click()
    await expect(owner.getByRole('button', { name: 'Вернуть' })).toBeVisible()
    const pay = await ownerPoint(owner, await remotePoint(reference, cabinetPage(), '#pay-pro'))
    await owner.mouse.click(pay.x, pay.y)
    await expect.poll(() => browser.logs.some((line) => line.includes('"blocked"') && line.includes('/api/pay'))).toBe(true)
    await owner.getByRole('button', { name: 'Вернуть' }).click()
    await expect.poll(async () => (await browser.call('read')).snapshot).toContain('Оплата не прошла')

    expectNoFramesLeaked(browser)
  } finally {
    await reference.close()
    await browser.close()
  }
})

// Телефон: только узкий экран и касания. Тип браузера задаёт настройка, а не устройство.
const { defaultBrowserType: _browserType, ...phone } = devices['Pixel 7']

test.describe('с телефона', () => {
  test.use(phone)

  test('узкий экран: страница помещается, касание доходит до страницы', async ({ page: owner, browser: testBrowser }) => {
    const browser = await startTestBrowser({ live: true })
    const reference = await testBrowser.newPage()
    try {
      const chat = await browser.call('url', { url: `${browser.patientUrl}/chat` })
      await browser.call('type', { ref: refOf(chat.snapshot, 'textbox', ''), text: 'Сообщение с телефона', danger: 'none' })

      const screen = await ownerOpensLive(owner, browser)
      const screenBox = (await screen.boundingBox())!
      expect(screenBox.x + screenBox.width).toBeLessThanOrEqual(owner.viewportSize()!.width + 1)
      expect(await owner.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)

      await owner.getByRole('button', { name: 'Взять управление' }).tap()
      await expect(owner.getByRole('button', { name: 'Вернуть' })).toBeVisible()
      const send = await ownerPoint(owner, await remotePoint(reference, chatPage(null), '#chat-form button'))
      await owner.touchscreen.tap(send.x, send.y)
      await owner.getByRole('button', { name: 'Вернуть' }).tap()

      await expect.poll(async () => (await browser.call('read')).snapshot).toContain('Вы: Сообщение с телефона')
      expectNoFramesLeaked(browser)
    } finally {
      await reference.close()
      await browser.close()
    }
  })
})
