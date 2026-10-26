// Замки браузера: опасные действия, разрешённые сайты, сетевой замок изменяющих запросов, признаки капчи и кодов.
// Решения — чистые функции; установка на контекст Chromium — installNetworkGuard.
import type { BrowserContext, Page, Route } from 'playwright-core'
import type { SitePolicy } from '../policy/index.js'

export const DANGER_KINDS = ['none', 'submit', 'send', 'pay', 'delete', 'publish'] as const
export type DangerKind = (typeof DANGER_KINDS)[number]
const FORBIDDEN_DANGER: ReadonlySet<string> = new Set(['send', 'pay', 'delete', 'publish'])

const DANGER_NAMES: Record<string, string> = {
  send: 'отправка сообщений людям',
  pay: 'оплата',
  delete: 'удаление',
  publish: 'публикация',
}

export type Refusal = { ok: false; code: string; message: string }

export function checkDanger(danger: unknown): { ok: true } | Refusal {
  if (typeof danger !== 'string' || !(DANGER_KINDS as readonly string[]).includes(danger)) {
    return { ok: false, code: 'bad_request', message: `danger обязателен: ${DANGER_KINDS.join(' | ')}` }
  }
  if (FORBIDDEN_DANGER.has(danger)) {
    return { ok: false, code: 'refused_danger', message: `${DANGER_NAMES[danger]} запрещена Ремонтнику; сообщите владельцу` }
  }
  return { ok: true }
}

function originOf(url: string): string | null {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.origin : null
  } catch {
    return null
  }
}

export function isAllowedOrigin(url: string, allowedOrigins: readonly string[]): boolean {
  const origin = originOf(url)
  return origin !== null && allowedOrigins.includes(origin)
}

const READING_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])
export const isMutatingMethod = (method: string) => !READING_METHODS.has(method.toUpperCase())

/** `*` — любой кусок внутри одного сегмента пути, `**` — любой остаток пути. */
function pathPatternToRegExp(pattern: string): RegExp {
  const source = pattern
    .split(/(\*\*|\*)/)
    .map((part) => (part === '**' ? '.*' : part === '*' ? '[^/]*' : part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')))
    .join('')
  return new RegExp(`^${source}$`)
}

export function matchesMutation(method: string, url: string, policy: SitePolicy): boolean {
  if (!isMutatingMethod(method) || !isAllowedOrigin(url, policy.allowedOrigins)) return false
  const { pathname } = new URL(url)
  return policy.allowedMutations.some(
    (rule) => (rule.method === '*' || rule.method.toUpperCase() === method.toUpperCase()) && pathPatternToRegExp(rule.pathPattern).test(pathname),
  )
}

export interface RequestFacts {
  method: string
  url: string
  isNavigation: boolean
  isMainFrame: boolean
}

export type RequestDecision = { allow: true } | { allow: false; code: 'refused_origin' | 'refused_mutation'; reason: string }

export function describeRequest(method: string, url: string): string {
  const origin = originOf(url)
  return origin ? `${method.toUpperCase()} ${new URL(url).pathname}` : `${method.toUpperCase()} ${url.split(/[?#]/)[0]?.slice(0, 40)}`
}

export function decideRequest(request: RequestFacts, policy: SitePolicy): RequestDecision {
  const topLevel = request.isNavigation && request.isMainFrame
  if (topLevel && request.url !== 'about:blank' && !isAllowedOrigin(request.url, policy.allowedOrigins)) {
    return { allow: false, code: 'refused_origin', reason: `переход на ${originOf(request.url) ?? 'адрес без сайта'} вне allowedOrigins` }
  }
  if (isMutatingMethod(request.method) && !matchesMutation(request.method, request.url, policy)) {
    const where = originOf(request.url) ?? 'адрес без сайта'
    return { allow: false, code: 'refused_mutation', reason: `${describeRequest(request.method, request.url)} на ${where} вне allowedMutations` }
  }
  return { allow: true }
}

export interface BlockedRequest {
  code: 'refused_origin' | 'refused_mutation'
  reason: string
}

/** Ставит сетевой замок на весь контекст: действует и для врача, и при ручном управлении владельца. */
export async function installNetworkGuard(
  context: BrowserContext,
  policy: SitePolicy,
  onBlocked: (blocked: BlockedRequest) => void,
): Promise<void> {
  await context.route('**/*', async (route: Route) => {
    const request = route.request()
    let isMainFrame = false
    try {
      isMainFrame = request.frame().parentFrame() === null
    } catch {
      // Запрос не из страницы (служебный работник): считаем верхним уровнем — строже.
      isMainFrame = true
    }
    const decision = decideRequest(
      { method: request.method(), url: request.url(), isNavigation: request.isNavigationRequest(), isMainFrame },
      policy,
    )
    if (decision.allow) return route.fallback()
    onBlocked({ code: decision.code, reason: decision.reason })
    if (request.isNavigationRequest()) return route.abort('blockedbyclient')
    return route.fulfill({
      status: 403,
      contentType: 'application/json; charset=utf-8',
      body: JSON.stringify({ error: 'запрос заблокирован Ремонтником' }),
    })
  })
}

const CAPTCHA_SELECTORS = [
  'iframe[src*="captcha" i]',
  'iframe[src*="turnstile" i]',
  'iframe[title*="captcha" i]',
  '.g-recaptcha',
  '.h-captcha',
  '.cf-turnstile',
  '[data-sitekey]',
].join(', ')
const ONE_TIME_CODE_SELECTOR = 'input[autocomplete="one-time-code" i]'
const HUMAN_CHECK_TEXT = [
  /код подтверждения/i,
  /введите код/i,
  /код из (?:sms|смс|письма)/i,
  /verification code/i,
  /one-time (?:code|password)/i,
  /captcha/i,
  /капч/i,
  /подтвердите, что вы (?:не робот|человек)/i,
]

export interface HumanCheckSignals {
  captchaElements: number
  oneTimeCodeFields: number
  text: string
}

export function detectHumanCheck(signals: HumanCheckSignals): { needsHuman: false } | { needsHuman: true; reason: string } {
  if (signals.captchaElements > 0) return { needsHuman: true, reason: 'на странице капча' }
  if (signals.oneTimeCodeFields > 0) return { needsHuman: true, reason: 'страница просит одноразовый код' }
  const phrase = HUMAN_CHECK_TEXT.find((pattern) => pattern.test(signals.text))
  if (phrase) return { needsHuman: true, reason: 'страница просит код подтверждения или проверку человеком' }
  return { needsHuman: false }
}

/** Собирает признаки во всех фреймах страницы; текст — из уже готового снимка. */
export async function findHumanCheck(page: Page, snapshotText: string) {
  let captchaElements = 0
  let oneTimeCodeFields = 0
  for (const frame of page.frames()) {
    captchaElements += await frame.locator(CAPTCHA_SELECTORS).count().catch(() => 0)
    oneTimeCodeFields += await frame.locator(ONE_TIME_CODE_SELECTOR).count().catch(() => 0)
  }
  return detectHumanCheck({ captchaElements, oneTimeCodeFields, text: snapshotText })
}
