import type { RemontnikConfig } from '@ykurilov/remontnik-core/config'
import type { ReportText } from '../reports/texts.js'
import type { BrowserClient } from './client.js'

// Проверка страниц после выкатки (`browser.pagesToCheck`): каждая открывается в браузере врача, на ней ищется
// `expectText`, снимок экрана идёт в отчёт. Браузер выключен или служба не отвечает — отчёт помечен
// «без проверки в браузере»; служба упала посреди проверки — уже проверенные страницы остаются в отчёте, остальные
// помечены «не проверена». Проверка только сообщает: решение о судьбе выкатки принимает наблюдение.

export type PageCheckStatus = 'checked' | 'failed' | 'unavailable' | 'disabled'

export interface PageCheck {
  status: PageCheckStatus
  /** `unchecked` — до страницы не дошли: служба браузера перестала отвечать. */
  pages: { url: string; ok: boolean; problem?: string; unchecked?: true }[]
  screenshots: string[]
  /** Почему проверки не было. */
  note?: string
}

const NO_BROWSER_CHECK = 'без проверки в браузере'

/** `undefined` — браузера в настройке нет или проверять нечего. `signal` — врач закрывается: проверка обрывается. */
export async function checkPages(
  client: BrowserClient | undefined,
  browser: RemontnikConfig['browser'],
  signal?: AbortSignal,
): Promise<PageCheck | undefined> {
  if (!browser || browser.pagesToCheck.length === 0) return undefined
  if (!browser.enabled) return { status: 'disabled', pages: [], screenshots: [], note: 'браузер выключен в настройке' }
  if (!client) return { status: 'unavailable', pages: [], screenshots: [], note: 'у врача не задана служба браузера' }
  const pages: PageCheck['pages'] = []
  const screenshots: string[] = []
  for (const [index, page] of browser.pagesToCheck.entries()) {
    signal?.throwIfAborted()
    const opened = await client.call('url', { profile: browser.profile, url: page.url })
    if (!opened.ok && opened.code === 'unavailable') {
      const unchecked = browser.pagesToCheck.slice(index).map((rest) => ({ url: rest.url, ok: false, unchecked: true as const }))
      const status = pages.some((checked) => !checked.ok) ? 'failed' : 'unavailable'
      return { status, pages: [...pages, ...unchecked], screenshots, note: opened.message }
    }
    const problem = !opened.ok
      ? `${opened.code}: ${opened.message}`
      : page.expectText !== undefined && !String(opened.snapshot ?? '').includes(page.expectText)
        ? `на странице нет текста «${page.expectText}»`
        : undefined
    pages.push({ url: page.url, ok: problem === undefined, ...(problem ? { problem } : {}) })
    signal?.throwIfAborted()
    const shot = await client.call('shot', { profile: browser.profile })
    if (shot.ok && typeof shot.path === 'string') screenshots.push(shot.path)
  }
  return { status: pages.every((page) => page.ok) ? 'checked' : 'failed', pages, screenshots }
}

/** Итог проверки страниц — в отчёт о выкатке: строка в короткий текст, подробности и снимки. */
export function withPageCheck(text: ReportText, check: PageCheck | undefined): ReportText {
  if (!check) return text
  const failed = check.pages.filter((page) => !page.ok && !page.unchecked)
  const unchecked = check.pages.filter((page) => page.unchecked)
  const list = (pages: PageCheck['pages']) => pages.map((page) => page.url).join(', ')
  const lines: string[] = []
  if (check.status === 'checked') lines.push('Страницы проверил в браузере: работают.')
  if (failed.length > 0) lines.push(`Проверка страниц в браузере: не работает ${list(failed)}.`)
  if (unchecked.length > 0 || check.pages.length === 0) {
    const what = unchecked.length > 0 && unchecked.length < check.pages.length ? `Страницы ${list(unchecked)}` : 'Выкатка'
    lines.push(`${what} ${NO_BROWSER_CHECK} (${check.note ?? 'браузер недоступен'}).`)
  }
  const short = lines.join(' ')
  const details = check.pages.map((page) => `- ${page.url}: ${page.ok ? 'работает' : page.unchecked ? 'не проверена' : page.problem}`)
  const screenshots = [...(text.screenshots ?? []), ...check.screenshots]
  return {
    ...text,
    short: `${text.short} ${short}`,
    full: [text.full, '', short, ...details].join('\n'),
    ...(screenshots.length > 0 ? { screenshots } : {}),
  }
}
