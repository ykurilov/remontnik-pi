import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { DEMO_LOGIN, DEMO_PASSWORD, countOccurrences, refOf, startTestBrowser } from './helpers.js'

// SC-010: пароль сохранённого входа не встречается ни в одном снимке, ответе или журнале.
test('вход по сохранённому входу, «глаз», смена типа поля, снимки — пароль не утёк', async ({ page }) => {
  const browser = await startTestBrowser()
  try {
    expect(await browser.call('open')).toMatchObject({ ok: true })
    const loginPage = await browser.call('url', { url: `${browser.patientUrl}/login` })
    expect(loginPage).toMatchObject({ ok: true, title: 'Вход — Пациент' })

    const emailRef = refOf(loginPage.snapshot, 'textbox', 'Почта')
    const passwordRef = refOf(loginPage.snapshot, 'textbox', 'Пароль')
    const eyeRef = refOf(loginPage.snapshot, 'button', 'Показать пароль')
    expect(loginPage.snapshot).toContain(`[ref=${passwordRef}] [поле пароля]`)

    // Номера стабильны: второй снимок той же страницы даёт те же номера.
    const again = await browser.call('read')
    expect([refOf(again.snapshot, 'textbox', 'Почта'), refOf(again.snapshot, 'textbox', 'Пароль')]).toEqual([emailRef, passwordRef])

    const logins = await browser.call('logins', { site: browser.patientUrl })
    expect(logins.logins).toEqual([{ id: browser.entryId, site: browser.patientUrl, login: DEMO_LOGIN, profile: 'remontnik' }])

    expect(await browser.call('type', { ref: emailRef, text: DEMO_LOGIN, danger: 'none' })).toMatchObject({ ok: true })

    // Отказы: не поле пароля; вход другого сайта.
    expect(await browser.call('fill-password', { entryId: browser.entryId, ref: emailRef })).toMatchObject({ ok: false, code: 'refused_field' })
    expect(await browser.call('fill-password', { entryId: browser.foreignEntryId, ref: passwordRef })).toMatchObject({ ok: false, code: 'refused_origin' })

    const filled = await browser.call('fill-password', { entryId: browser.entryId, ref: passwordRef })
    expect(filled).toMatchObject({ ok: true })
    expect(filled.snapshot).toContain(`[ref=${passwordRef}] [пароль вписан]: [скрыто]`)

    // «Глаз» меняет тип поля на текст: значение всё равно скрыто.
    const shown = await browser.call('click', { ref: eyeRef, danger: 'none' })
    expect(shown).toMatchObject({ ok: true })
    expect(shown.snapshot).toContain(`[ref=${passwordRef}] [пароль вписан]: [скрыто]`)
    expect((await browser.call('read')).snapshot).toContain('[пароль вписан]')

    // Снимок экрана: поле пароля под маской.
    const shot = await browser.call('shot')
    expect(shot).toMatchObject({ ok: true })
    const jpeg = readFileSync(shot.path!)
    expect(jpeg.subarray(0, 2).toString('hex')).toBe('ffd8')
    expect(countOccurrences(jpeg.toString('latin1'), DEMO_PASSWORD)).toBe(0)
    await page.setContent(`<img id="shot" src="data:image/jpeg;base64,${jpeg.toString('base64')}">`)
    const maskedPixels = await page.evaluate(async () => {
      const image = document.querySelector<HTMLImageElement>('#shot')!
      await image.decode()
      const canvas = document.createElement('canvas')
      canvas.width = image.naturalWidth
      canvas.height = image.naturalHeight
      const context = canvas.getContext('2d')!
      context.drawImage(image, 0, 0)
      const { data } = context.getImageData(0, 0, canvas.width, canvas.height)
      let magenta = 0
      for (let index = 0; index < data.length; index += 4) {
        if (data[index]! > 200 && data[index + 1]! < 80 && data[index + 2]! > 200) magenta++
      }
      return magenta
    })
    expect(maskedPixels).toBeGreaterThan(500)

    const submitted = await browser.call('click', { ref: refOf(shown.snapshot, 'button', 'Войти'), danger: 'submit' })
    expect(submitted).toMatchObject({ ok: true, title: 'Кабинет — Пациент' })

    const everything = [...browser.outputs, ...browser.logs, ...filesUnder(browser.dataDir, 'logins.json')].join('\n')
    expect(countOccurrences(everything, DEMO_PASSWORD)).toBe(0)
    expect(countOccurrences(everything, encodeURIComponent(DEMO_PASSWORD))).toBe(0)
    expect(browser.logs.length).toBeGreaterThan(0)
  } finally {
    await browser.close()
  }
})

/** Текстовые файлы службы, кроме самого зашифрованного хранилища и папок профилей Chromium. */
function filesUnder(directory: string, ...skip: string[]): string[] {
  const texts: string[] = []
  for (const entry of readdirSync(directory)) {
    if (skip.includes(entry) || entry === 'profiles') continue
    const full = join(directory, entry)
    if (statSync(full).isDirectory()) texts.push(...filesUnder(full))
    else if (!/\.jpe?g$/.test(entry)) texts.push(readFileSync(full, 'utf8'))
  }
  return texts
}
