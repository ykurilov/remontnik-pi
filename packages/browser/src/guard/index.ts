// Замки браузера: опасные действия, разрешённые сайты, сетевой замок изменяющих запросов, признаки капчи и кодов.
// Решения — чистые функции; установка на контекст Chromium — installNetworkGuard.
import { isIP } from 'node:net'
import type { BrowserContext, Frame, Page, Route, WebSocketRoute } from 'playwright-core'
import { type SitePolicy, sessionOrigins } from '../policy/index.js'

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
  const { origin, pathname } = new URL(url)
  return policy.allowedMutations.some(
    (rule) =>
      (rule.origin === undefined || rule.origin === origin) &&
      (rule.method === '*' || rule.method.toUpperCase() === method.toUpperCase()) &&
      pathPatternToRegExp(rule.pathPattern).test(pathname),
  )
}

export interface RequestFacts {
  method: string
  url: string
  isNavigation: boolean
  isMainFrame: boolean
  /** В профиль уже вписывали пароль: запросы вне allowedOrigins и extraOrigins закрыты, даже чтение. */
  sessionLocked?: boolean
}

export type BlockCode = 'refused_origin' | 'refused_frame' | 'refused_mutation' | 'refused_leak' | 'refused_internal'
export type RequestDecision = { allow: true } | { allow: false; code: BlockCode; reason: string; domain?: string; suspect?: string }

export function describeRequest(method: string, url: string): string {
  const origin = originOf(url)
  return origin ? `${method.toUpperCase()} ${new URL(url).pathname}` : `${method.toUpperCase()} ${url.split(/[?#]/)[0]?.slice(0, 40)}`
}

/**
 * Сайт закрытого адреса для владельца: домен второго уровня без поддоменов и порта (у зон вида `co.<страна>` — третьего).
 * Имя хоста после входа выбирает скрипт страницы, и в поддомене он мог спрятать пароль: поддомены не показываются
 * никому, а числовой адрес — вовсе. Что осталось, проходит через фильтр паролей журнала и ответов службы.
 */
export function siteOf(url: string): string {
  let host: string
  try {
    host = new URL(url.replace(/^ws(s?):/i, 'http$1:')).hostname.toLowerCase().replace(/\.+$/, '')
  } catch {
    return 'адрес без сайта'
  }
  if (host === '' || host.startsWith('[') || isIP(host) !== 0) return 'числовой адрес'
  const labels = host.split('.')
  const keep = labels.length >= 3 && /^[a-z]{2}$/.test(labels.at(-1)!) && SECOND_LEVEL_SUFFIXES.has(labels.at(-2)!) ? 3 : 2
  return labels.slice(-keep).join('.')
}

const SECOND_LEVEL_SUFFIXES = new Set(['ac', 'co', 'com', 'edu', 'gov', 'net', 'org'])

/** Почему адрес закрыт после входа. Без адреса: причину читает модель, а имя хоста выбрал скрипт страницы. */
export const LOCKED_REASON = 'после входа паролем сеанс профиля заперт, сайт вне allowedOrigins и extraOrigins'
/** Подсказка владельцу — только в журнал службы и отчёт, рядом с сайтом из `siteOf`. */
export const LOCKED_HINT = 'если сайт нужен приложению, впишите его точный адрес (origin) в extraOrigins настройки браузера'

export function decideRequest(request: RequestFacts, policy: SitePolicy): RequestDecision {
  const origin = originOf(request.url)
  // Скрипт страницы прочитал бы вписанный пароль — из поля или из хранилища страницы, куда его спрятали раньше, —
  // и унёс в адресе картинки, скрипта, формы или перехода на другой сайт. Адрес такого запроса дальше не уходит:
  // ни в причину для модели, ни в журнал — только сайт из `siteOf`.
  if (request.sessionLocked === true && origin !== null && !sessionOrigins(policy).includes(origin)) {
    const domain = siteOf(request.url)
    if (request.isNavigation && !request.isMainFrame) return { allow: false, code: 'refused_frame', reason: `фрейм с другого сайта: ${LOCKED_REASON}`, domain }
    if (request.isNavigation) return { allow: false, code: 'refused_origin', reason: `переход на другой сайт: ${LOCKED_REASON}`, domain }
    const method = request.method.toUpperCase()
    return {
      allow: false,
      code: 'refused_leak',
      reason: `${method} на другой сайт: ${LOCKED_REASON}`,
      domain,
      ...(isMutatingMethod(method) ? { suspect: `${method} на другой сайт` } : {}),
    }
  }
  if (request.isNavigation && request.url !== 'about:blank' && !isAllowedOrigin(request.url, policy.allowedOrigins)) {
    const where = origin ?? 'адрес без сайта'
    if (!request.isMainFrame) return { allow: false, code: 'refused_frame', reason: `фрейм с ${where} вне allowedOrigins` }
    return { allow: false, code: 'refused_origin', reason: `переход на ${where} вне allowedOrigins` }
  }
  if (isMutatingMethod(request.method) && !matchesMutation(request.method, request.url, policy)) {
    const where = origin ?? 'адрес без сайта'
    return { allow: false, code: 'refused_mutation', reason: `${describeRequest(request.method, request.url)} на ${where} вне allowedMutations` }
  }
  return { allow: true }
}

export interface BlockedRequest {
  code: BlockCode
  reason: string
  /** Сайт закрытого адреса из `siteOf`: владелец по нему поймёт, что вписать в extraOrigins. Модели не показывается. */
  domain?: string
  /** Отказ похож на попытку утечки, а не на безобидный счётчик: запись или сокет на другой сайт, пароль в адресе. */
  suspect?: string
  /** Полный адрес — только чтобы служба проверила его на пароль; ни в журнал, ни в ответы не попадает. */
  url?: string
}

export interface NetworkGuard {
  /**
   * В профиль вписывается пароль: запросы вне allowedOrigins и extraOrigins и WebSocket вне allowedOrigins закрыты во всём контексте
   * до конца сеанса. Страница могла спрятать пароль в localStorage, IndexedDB, cookie или `window.name`, и унесёт его
   * любая следующая страница или окно — поэтому замок не снимается ни новым документом, ни закрытием окон.
   */
  passwordFilled(): void
  /** Заперт ли сеанс: по этому решает и прокси выхода службы. */
  isLocked(): boolean
}

/** Адрес WebSocket как адрес сайта: `ws:` — `http:`, `wss:` — `https:`. */
function webSocketSite(url: string): string {
  return url.replace(/^ws(s?):/i, 'http$1:')
}

/**
 * Каналы мимо перехвата запросов: WebRTC (TURN-сервер с паролем в имени пользователя) и WebTransport (QUIC).
 * Служебному браузеру они не нужны — их нет в каждом окне и фрейме с самого начала документа. Фоновые скрипты
 * из `blob:` и `data:` (их пишет сам скрипт страницы) получают то же вступление и ту же обёртку для вложенных.
 * Выполняется в странице: функция самодостаточна и ссылается на себя по имени.
 */
function sealNetworkChannels(): void {
  const scope = globalThis as unknown as Record<string, unknown>
  for (const name of ['RTCPeerConnection', 'webkitRTCPeerConnection', 'RTCDataChannel', 'RTCIceTransport', 'RTCSctpTransport', 'RTCDtlsTransport', 'WebTransport']) {
    try {
      delete scope[name]
    } catch {}
  }
  for (const name of ['Worker', 'SharedWorker']) {
    const Original = scope[name] as (new (url: string | URL, options?: unknown) => object) | undefined
    if (typeof Original !== 'function') continue
    const Sealed = function (this: unknown, url: string | URL, options?: unknown) {
      if (!new.target) throw new TypeError(`Failed to construct '${name}': Please use the 'new' operator`)
      const target = String(url instanceof URL ? url.href : new URL(String(url), location.href).href)
      if (!/^(blob|data):/i.test(target)) return new Original(url, options)
      const isModule = typeof options === 'object' && options !== null && (options as { type?: unknown }).type === 'module'
      const load = isModule ? `await import(${JSON.stringify(target)})` : `importScripts(${JSON.stringify(target)})`
      const prelude = new Blob([`(${sealNetworkChannels.toString()})();\n${load}`], { type: 'text/javascript' })
      return new Original(URL.createObjectURL(prelude), options)
    } as unknown as { prototype: object }
    Sealed.prototype = Original.prototype
    Object.defineProperty(Original.prototype, 'constructor', { value: Sealed, writable: true, configurable: true })
    Object.defineProperty(scope, name, { value: Sealed, writable: true, configurable: true })
  }
}

/**
 * Ставит сетевой замок на весь контекст: действует и для врача, и при ручном управлении владельца.
 * `locked` — сеанс заперт с самого начала: пароль в профиль уже вписывали до перезапуска службы.
 */
export async function installNetworkGuard(
  context: BrowserContext,
  policy: SitePolicy,
  onBlocked: (blocked: BlockedRequest) => void,
  options: { locked?: boolean } = {},
): Promise<NetworkGuard> {
  let locked = options.locked === true

  await context.addInitScript(sealNetworkChannels)

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
      { method: request.method(), url: request.url(), isNavigation: request.isNavigationRequest(), isMainFrame, sessionLocked: locked },
      policy,
    )
    if (decision.allow) return route.fallback()
    const { allow: _allow, ...blocked } = decision
    onBlocked({ ...blocked, ...(decision.code === 'refused_leak' ? { url: request.url() } : {}) })
    if (request.isNavigationRequest()) return route.abort('blockedbyclient')
    return route.fulfill({
      status: 403,
      contentType: 'application/json; charset=utf-8',
      body: JSON.stringify({ error: 'запрос заблокирован Ремонтником' }),
    })
  })

  // WebSocket — через замок с самого начала: сокет на другой сайт, открытый до пароля, закрывается, как только
  // пароль вписан, иначе скрипт отправил бы пароль по уже открытому сокету. После входа сокет пускается только
  // к allowedOrigins: extraOrigins — для подресурсов (CDN, шрифты), а по сокету скрипт унёс бы что угодно.
  const foreignSockets = new Set<WebSocketRoute>()
  const closeForeign = (socket: WebSocketRoute) => {
    foreignSockets.delete(socket)
    onBlocked({
      code: 'refused_leak',
      reason: `WebSocket на сайт вне allowedOrigins: ${LOCKED_REASON}`,
      domain: siteOf(socket.url()),
      suspect: 'WebSocket на другой сайт',
      url: socket.url(),
    })
    void socket.close({ code: 1008, reason: 'blocked' }).catch(() => {})
  }
  await context.routeWebSocket(/.*/, (socket: WebSocketRoute) => {
    if (isAllowedOrigin(webSocketSite(socket.url()), policy.allowedOrigins)) {
      socket.connectToServer()
      return
    }
    foreignSockets.add(socket)
    socket.onClose(() => foreignSockets.delete(socket))
    if (locked) return closeForeign(socket)
    socket.connectToServer()
  })

  return {
    passwordFilled() {
      locked = true
      for (const socket of [...foreignSockets]) closeForeign(socket)
    },
    isLocked: () => locked,
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
