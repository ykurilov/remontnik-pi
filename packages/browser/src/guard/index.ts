// Замки браузера: опасные действия, разрешённые сайты, сетевой замок изменяющих запросов, признаки капчи и кодов.
// Решения — чистые функции; установка на контекст Chromium — installNetworkGuard.
import type { BrowserContext, Frame, Page, Request, Route, WebSocketRoute } from 'playwright-core'
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

// Опасное служба узнаёт сама — по подписи, тексту и адресу цели, а не по слову модели в `danger`.
// Обычное «Отправить» не опасно: так отправляется форма или сообщение боту; опасно — сообщение людям.
const DANGER_WORDS: ReadonlyArray<readonly [Exclude<DangerKind, 'none' | 'submit'>, RegExp]> = [
  ['pay', /оплат|заплат|купить|покупк|оформить заказ|\bpay\b|payment|checkout|purchase|\bbuy\b|place order/i],
  ['delete', /удал|стереть|delete|remove|erase/i],
  ['publish', /опубликов|публикац|publish/i],
  ['send', /отправить (?:сообщение|письмо)|написать (?:сообщение|письмо)|разослать|рассылк|send (?:a )?(?:message|e-?mail|mail)/i],
]

export function dangerInText(text: string): Exclude<DangerKind, 'none' | 'submit'> | null {
  return DANGER_WORDS.find(([, pattern]) => pattern.test(text))?.[0] ?? null
}

export function refuseDangerousTarget(text: string): Refusal | null {
  const kind = dangerInText(text)
  if (!kind) return null
  return { ok: false, code: 'refused_danger', message: `цель похожа на действие «${DANGER_NAMES[kind]}»: оно запрещено Ремонтнику, что бы ни было указано в danger; сообщите владельцу` }
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

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

/** Пароль входа — только в точный origin входа и только по https (локальный адрес — для проверок). */
export function isLoginOrigin(frameUrl: string, site: string): boolean {
  try {
    const frame = new URL(frameUrl)
    return frame.origin === site && (frame.protocol === 'https:' || (frame.protocol === 'http:' && LOCAL_HOSTS.has(frame.hostname)))
  } catch {
    return false
  }
}

/**
 * Адреса фрейма от него самого до верхней страницы. Фрейм доступен врачу, только если каждый — с разрешённого
 * сайта; пустой фрейм (`about:blank`, `about:srcdoc`) наследует сайт родителя.
 */
export function isAllowedFrameUrl(chain: readonly string[], allowedOrigins: readonly string[]): boolean {
  if (chain.length === 0) return false
  return chain.every((url, index) => isAllowedOrigin(url, allowedOrigins) || ((url === 'about:blank' || url === 'about:srcdoc') && index < chain.length - 1))
}

/** Живой фрейм страницы: он и все его родители — с разрешённых сайтов. */
export function isFrameAllowed(frame: Frame, allowedOrigins: readonly string[]): boolean {
  const chain: string[] = []
  for (let current: Frame | null = frame; current; current = current.parentFrame()) chain.push(current.url())
  return isAllowedFrameUrl(chain, allowedOrigins)
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
  /** На странице вписан пароль из хранилища: запросы на другие сайты закрыты, даже чтение. */
  passwordOnPage?: boolean
}

export type BlockCode = 'refused_origin' | 'refused_frame' | 'refused_mutation' | 'refused_leak'
export type RequestDecision = { allow: true } | { allow: false; code: BlockCode; reason: string }

export function describeRequest(method: string, url: string): string {
  const origin = originOf(url)
  return origin ? `${method.toUpperCase()} ${new URL(url).pathname}` : `${method.toUpperCase()} ${url.split(/[?#]/)[0]?.slice(0, 40)}`
}

export function decideRequest(request: RequestFacts, policy: SitePolicy): RequestDecision {
  if (request.isNavigation && request.url !== 'about:blank' && !isAllowedOrigin(request.url, policy.allowedOrigins)) {
    const where = originOf(request.url) ?? 'адрес без сайта'
    if (!request.isMainFrame) return { allow: false, code: 'refused_frame', reason: `фрейм с ${where} вне allowedOrigins` }
    return { allow: false, code: 'refused_origin', reason: `переход на ${where} вне allowedOrigins` }
  }
  if (isMutatingMethod(request.method) && !matchesMutation(request.method, request.url, policy)) {
    const where = originOf(request.url) ?? 'адрес без сайта'
    return { allow: false, code: 'refused_mutation', reason: `${describeRequest(request.method, request.url)} на ${where} вне allowedMutations` }
  }
  // Скрипт страницы прочитал бы вписанный пароль и унёс его в адресе картинки или скрипта с другого сайта.
  const origin = originOf(request.url)
  if (request.passwordOnPage && origin !== null && !policy.allowedOrigins.includes(origin)) {
    return { allow: false, code: 'refused_leak', reason: `${describeRequest(request.method, request.url)} на ${origin}: на странице пароль, сайт вне allowedOrigins` }
  }
  return { allow: true }
}

export interface BlockedRequest {
  code: BlockCode
  reason: string
}

export interface NetworkGuard {
  /**
   * На странице вписан пароль: до новой страницы (не смены адреса в той же странице) запросы и WebSocket на сайты
   * вне allowedOrigins закрыты.
   */
  passwordFilled(page: Page): void
}

/** Адрес WebSocket как адрес сайта: `ws:` — `http:`, `wss:` — `https:`. */
function webSocketSite(url: string): string {
  return url.replace(/^ws(s?):/i, 'http$1:')
}

/** Ставит сетевой замок на весь контекст: действует и для врача, и при ручном управлении владельца. */
export async function installNetworkGuard(
  context: BrowserContext,
  policy: SitePolicy,
  onBlocked: (blocked: BlockedRequest) => void,
): Promise<NetworkGuard> {
  /** Страницы с вписанным паролем; значение — с тех пор ушёл запрос нового документа верхнего фрейма. */
  const locked = new Map<Page, { newDocument: boolean }>()
  const pageOf = (request: Request): Page | undefined => {
    try {
      return request.frame().page()
    } catch {
      return undefined
    }
  }
  // Запрос не из страницы (служебный работник) считается со страницей с паролем, если такая есть: строже.
  const passwordOn = (page: Page | undefined) => (page ? locked.has(page) : locked.size > 0)

  await context.route('**/*', async (route: Route) => {
    const request = route.request()
    let isMainFrame = false
    try {
      isMainFrame = request.frame().parentFrame() === null
    } catch {
      // Запрос не из страницы (служебный работник): считаем верхним уровнем — строже.
      isMainFrame = true
    }
    const page = pageOf(request)
    const decision = decideRequest(
      { method: request.method(), url: request.url(), isNavigation: request.isNavigationRequest(), isMainFrame, passwordOnPage: passwordOn(page) },
      policy,
    )
    if (decision.allow) {
      if (page && isMainFrame && request.isNavigationRequest()) {
        const lock = locked.get(page)
        if (lock) lock.newDocument = true
      }
      return route.fallback()
    }
    onBlocked({ code: decision.code, reason: decision.reason })
    if (request.isNavigationRequest()) return route.abort('blockedbyclient')
    return route.fulfill({
      status: 403,
      contentType: 'application/json; charset=utf-8',
      body: JSON.stringify({ error: 'запрос заблокирован Ремонтником' }),
    })
  })

  // WebSocket — через замок с самого начала: сокет на другой сайт, открытый до пароля, закрывается, как только
  // пароль вписан, иначе скрипт отправил бы пароль по уже открытому сокету. Рабочая вкладка в контексте одна.
  const foreignSockets = new Set<WebSocketRoute>()
  const closeForeign = (socket: WebSocketRoute) => {
    foreignSockets.delete(socket)
    onBlocked({ code: 'refused_leak', reason: `WebSocket на ${originOf(webSocketSite(socket.url())) ?? 'адрес без сайта'}: на странице пароль, сайт вне allowedOrigins` })
    void socket.close({ code: 1008, reason: 'blocked' }).catch(() => {})
  }
  await context.routeWebSocket(/.*/, (socket: WebSocketRoute) => {
    if (isAllowedOrigin(webSocketSite(socket.url()), policy.allowedOrigins)) {
      socket.connectToServer()
      return
    }
    foreignSockets.add(socket)
    socket.onClose(() => foreignSockets.delete(socket))
    if (locked.size > 0) return closeForeign(socket)
    socket.connectToServer()
  })

  const watched = new WeakSet<Page>()
  return {
    passwordFilled(page) {
      locked.set(page, { newDocument: false })
      for (const socket of [...foreignSockets]) closeForeign(socket)
      if (watched.has(page)) return
      watched.add(page)
      // Смена адреса внутри страницы (history API) запроса документа не шлёт — замок остаётся до новой страницы.
      page.on('framenavigated', (frame) => {
        if (frame === page.mainFrame() && locked.get(page)?.newDocument) locked.delete(page)
      })
      page.on('close', () => locked.delete(page))
    },
  }
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
