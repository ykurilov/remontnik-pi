import type { RemontnikConfig } from '@ykurilov/remontnik-core/config'
import type { ReportText } from '../reports/texts.js'
import type { BrowserClient } from './client.js'

// Проверка страниц после выкатки (`browser.pagesToCheck`): каждая открывается в браузере врача, на ней ищется
// `expectText`, снимок экрана идёт в отчёт. Браузер выключен или служба не отвечает — отчёт помечен
// «без проверки в браузере». Проверка только сообщает: решение о судьбе выкатки принимает наблюдение.

export type PageCheckStatus = 'checked' | 'failed' | 'unavailable' | 'disabled'

export interface PageCheck {
  status: PageCheckStatus
  pages: { url: string; ok: boolean; problem?: string }[]
  screenshots: string[]
  /** Почему проверки не было. */
  note?: string
}

const NO_BROWSER_CHECK = 'без проверки в браузере'

/** `undefined` — браузера в настройке нет или проверять нечего. */
export async function checkPages(client: BrowserClient | undefined, browser: RemontnikConfig['browser']): Promise<PageCheck | undefined> {
  if (!browser || browser.pagesToCheck.length === 0) return undefined
  if (!browser.enabled) return { status: 'disabled', pages: [], screenshots: [], note: 'браузер выключен в настройке' }
  if (!client) return { status: 'unavailable', pages: [], screenshots: [], note: 'у врача не задана служба браузера' }
  const pages: PageCheck['pages'] = []
  const screenshots: string[] = []
  for (const page of browser.pagesToCheck) {
    const opened = await client.call('url', { profile: browser.profile, url: page.url })
    if (!opened.ok && opened.code === 'unavailable') return { status: 'unavailable', pages: [], screenshots, note: opened.message }
    const problem = !opened.ok
      ? `${opened.code}: ${opened.message}`
      : page.expectText !== undefined && !String(opened.snapshot ?? '').includes(page.expectText)
        ? `на странице нет текста «${page.expectText}»`
        : undefined
    pages.push({ url: page.url, ok: problem === undefined, ...(problem ? { problem } : {}) })
    const shot = await client.call('shot', { profile: browser.profile })
    if (shot.ok && typeof shot.path === 'string') screenshots.push(shot.path)
  }
  return { status: pages.every((page) => page.ok) ? 'checked' : 'failed', pages, screenshots }
}

/** Итог проверки страниц — в отчёт о выкатке: строка в короткий текст, подробности и снимки. */
export function withPageCheck(text: ReportText, check: PageCheck | undefined): ReportText {
  if (!check) return text
  const failed = check.pages.filter((page) => !page.ok)
  const short =
    check.status === 'checked'
      ? 'Страницы проверил в браузере: работают.'
      : check.status === 'failed'
        ? `Проверка страниц в браузере: не работает ${failed.map((page) => page.url).join(', ')}.`
        : `Выкатка ${NO_BROWSER_CHECK} (${check.note ?? 'браузер недоступен'}).`
  const details = check.pages.map((page) => `- ${page.url}: ${page.ok ? 'работает' : page.problem}`)
  const screenshots = [...(text.screenshots ?? []), ...check.screenshots]
  return {
    ...text,
    short: `${text.short} ${short}`,
    full: [text.full, '', short, ...details].join('\n'),
    ...(screenshots.length > 0 ? { screenshots } : {}),
  }
}
