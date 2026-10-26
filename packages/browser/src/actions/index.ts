// Команды врача над профилем: открыть, перейти, снимок, клик, ввод, клавиша, прокрутка, снимок экрана,
// входы и вписывание пароля. Команды одного профиля идут по очереди. Своего кода на странице нет.
import { randomBytes } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { ElementHandle, Locator, Page } from 'playwright-core'
import { checkDanger, findHumanCheck, isAllowedOrigin, isFrameAllowed, isLoginOrigin, refuseDangerousTarget } from '../guard/index.js'
import { type ControlLock, refuseIfHumanControl } from '../live/control.js'
import type { ServiceLog } from '../log.js'
import type { SitePolicy } from '../policy/index.js'
import type { ProfileSession, Profiles } from '../profiles/index.js'
import { takeSnapshot } from '../snapshot/index.js'
import type { LoginVault } from '../vault/index.js'

export type ActionResult = { ok: true; [field: string]: unknown } | { ok: false; code: string; message: string }

export interface BrowserCommandRunner {
  run(command: string, input: Record<string, unknown>): Promise<ActionResult>
}

export const BROWSER_COMMANDS = ['open', 'url', 'back', 'read', 'click', 'type', 'key', 'scroll', 'shot', 'logins', 'fill-password', 'status'] as const
export type BrowserCommand = (typeof BROWSER_COMMANDS)[number]

const fail = (code: string, message: string): ActionResult => ({ ok: false, code, message })
const REF = /^(?:f\d+)?e\d+$/
const ACTION_TIMEOUT_MS = 5000
const NAVIGATION_TIMEOUT_MS = 30_000
const SCROLL_DIRECTIONS = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] } as const
const PASSWORD_FIELDS = 'input[type="password" i], input[autocomplete~="current-password" i], input[autocomplete~="new-password" i]'

class Refused extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

/** Пока страница ждёт человека (капча, код), врачу можно только смотреть. */
const ALLOWED_WHILE_HUMAN_CHECK: ReadonlySet<string> = new Set(['open', 'read', 'shot'])
const SUBMIT_KEYS = /(?:^|\+)(?:Enter|NumpadEnter|Space| )$/

type TargetMode = 'click' | 'submit' | 'key'

/**
 * Что видит человек у цели действия: подписи, текст, адрес ссылки или формы. Для отправки формы — её кнопки
 * отправки, для клавиши — элемент в фокусе. Выполняется на странице, поэтому без внешних имён.
 */
function describeTarget(element: Element, mode: TargetMode): string {
  const parts: string[] = []
  const describe = (target: Element | null) => {
    if (!target) return
    const isField = target instanceof HTMLTextAreaElement || (target instanceof HTMLInputElement && !['submit', 'button', 'reset', 'image'].includes(target.type))
    for (const attribute of ['aria-label', 'title', 'alt', 'id', 'name', 'href', 'formaction', ...(isField ? [] : ['value'])]) {
      const value = target.getAttribute(attribute)
      if (value) parts.push(value)
    }
    for (const id of (target.getAttribute('aria-labelledby') ?? '').split(/\s+/)) if (id) parts.push(document.getElementById(id)?.textContent ?? '')
    if (!isField) parts.push(((target as HTMLElement).innerText ?? target.textContent ?? '').slice(0, 300))
  }
  const describeSubmit = (form: HTMLFormElement | null) => {
    if (!form) return
    parts.push(form.getAttribute('action') ?? '')
    for (const button of Array.from(form.querySelectorAll('button, input[type="submit" i], input[type="image" i]'))) {
      const type = (button.getAttribute('type') ?? 'submit').toLowerCase()
      if (type === 'submit' || type === 'image') describe(button)
    }
  }
  const CLICKABLE = 'a, button, summary, label, [role="button"], [role="link"], [role="menuitem"], [role="tab"], input[type="submit" i], input[type="button" i], input[type="image" i]'
  const isTextField = element instanceof HTMLInputElement && !['submit', 'button', 'reset', 'image', 'checkbox', 'radio'].includes(element.type)
  if (mode === 'submit' || (mode === 'key' && isTextField)) {
    describeSubmit(element instanceof HTMLInputElement || element instanceof HTMLButtonElement ? element.form : element.closest('form'))
    return parts.join('\n')
  }
  if (mode === 'key' && (element instanceof HTMLTextAreaElement || isTextField)) return ''
  const clickable = element.closest(CLICKABLE) ?? element
  describe(clickable)
  if (clickable !== element) describe(element)
  const type = (clickable.getAttribute('type') ?? (clickable instanceof HTMLButtonElement ? 'submit' : '')).toLowerCase()
  if ((clickable instanceof HTMLButtonElement || clickable instanceof HTMLInputElement) && (type === 'submit' || type === 'image')) {
    parts.push(clickable.form?.getAttribute('action') ?? '')
  }
  return parts.join('\n')
}

/** Ждём, пока страница загрузилась и сеть затихла: без жёстких пауз, с верхним пределом. */
function trackNetwork(page: Page) {
  let inflight = 0
  let lastChange = Date.now()
  const change = (delta: number) => {
    inflight = Math.max(0, inflight + delta)
    lastChange = Date.now()
  }
  page.on('request', () => change(1))
  page.on('requestfinished', () => change(-1))
  page.on('requestfailed', () => change(-1))
  return async function settle(): Promise<void> {
    await page.waitForLoadState('domcontentloaded', { timeout: NAVIGATION_TIMEOUT_MS }).catch(() => {})
    const deadline = Date.now() + 3000
    while (Date.now() < deadline && (inflight > 0 || Date.now() - lastChange < 150)) {
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
  }
}

export function createBrowserActions(options: {
  profiles: Profiles
  vault: LoginVault
  policy: SitePolicy
  shotsDir: string
  control: ControlLock
  log: ServiceLog
}): BrowserCommandRunner {
  const { profiles, vault, policy, shotsDir, control, log } = options
  const queues = new Map<string, Promise<unknown>>()
  const busy = new Set<string>()
  const settlers = new WeakMap<Page, () => Promise<void>>()
  // Найденная проверка человеком и сколько раз к тому моменту владелец возвращал управление.
  const humanChecks = new Map<string, { reason: string; releases: number }>()
  const snapshotOptions = { allowedOrigins: policy.allowedOrigins, secrets: () => vault.knownPasswords() }

  /** Проверка человеком снята, если владелец после неё сам вернул управление с живого экрана. */
  function pendingHumanCheck(profile: string): string | null {
    const check = humanChecks.get(profile)
    if (check && control.releases(profile) > check.releases) humanChecks.delete(profile)
    return humanChecks.get(profile)?.reason ?? null
  }

  const settle = (page: Page) => {
    let settler = settlers.get(page)
    if (!settler) settlers.set(page, (settler = trackNetwork(page)))
    return settler()
  }

  function inQueue<T>(profile: string, work: () => Promise<T>): Promise<T> {
    const previous = queues.get(profile) ?? Promise.resolve()
    const next = previous.then(async () => {
      busy.add(profile)
      try {
        return await work()
      } finally {
        busy.delete(profile)
      }
    })
    queues.set(
      profile,
      next.catch(() => {}),
    )
    return next
  }

  async function elementOf(page: Page, ref: unknown): Promise<Locator> {
    if (typeof ref !== 'string' || !REF.test(ref)) throw new Refused('bad_request', 'ref — номер элемента из снимка, например e12')
    const locator = page.getByRef(ref)
    const handle = await locator.elementHandle({ timeout: 2000 }).catch(() => null)
    if (!handle) throw new Refused('not_found', `элемента ${ref} нет: сделайте read заново`)
    const frame = await handle.ownerFrame()
    await handle.dispose()
    if (!frame || !isFrameAllowed(frame, policy.allowedOrigins)) throw new Refused('refused_origin', `элемент ${ref} во фрейме сайта вне allowedOrigins`)
    return locator
  }

  async function refuseDangerous(locator: Locator, mode: TargetMode) {
    return refuseDangerousTarget(await locator.evaluate(describeTarget, mode, { timeout: ACTION_TIMEOUT_MS }))
  }

  /** Элемент в фокусе на разрешённой части страницы (для клавиш). */
  async function focusedElement(page: Page): Promise<Locator | null> {
    for (const frame of page.frames()) {
      if (!isFrameAllowed(frame, policy.allowedOrigins)) continue
      const focused = frame.locator('*:focus:not(iframe):not(frame)')
      if ((await focused.count().catch(() => 0)) > 0) return focused.first()
    }
    return null
  }

  /** Итог действия: снимок, а также отказ, если сработал замок, страница ушла с сайта или нужен человек. */
  async function outcome(session: ProfileSession): Promise<ActionResult> {
    await settle(session.page)
    const page = session.page
    if (page.url() !== 'about:blank' && !isAllowedOrigin(page.url(), policy.allowedOrigins)) {
      await page.goto('about:blank').catch(() => {})
      session.takeBlocked()
      return fail('refused_origin', 'страница ушла на сайт вне allowedOrigins и закрыта')
    }
    const snapshot = await takeSnapshot(page, session.fields, snapshotOptions)
    const human = await findHumanCheck(page, snapshot.text)
    if (human.needsHuman) humanChecks.set(session.name, { reason: human.reason, releases: control.releases(session.name) })
    else humanChecks.delete(session.name)
    // Чужой фрейм просто не загружен и скрыт из снимка — само действие на странице прошло.
    const blocked = session.takeBlocked().filter((request) => request.code !== 'refused_frame')
    if (blocked.length > 0) {
      return fail(blocked[0]!.code, `заблокировано замком: ${blocked.map((request) => request.reason).join('; ')}`)
    }
    if (human.needsHuman) return fail('needs_human', `${human.reason}: нужен человек, браузер остановился`)
    return { ok: true, url: snapshot.url, title: snapshot.title, snapshot: snapshot.snapshot }
  }

  async function shot(session: ProfileSession): Promise<ActionResult> {
    const page = session.page
    await settle(page)
    const snapshot = await takeSnapshot(page, session.fields, snapshotOptions)
    const mask = [...snapshot.sensitiveRefs.map((ref) => page.getByRef(ref)), ...page.frames().map((frame) => frame.locator(PASSWORD_FIELDS))]
    // Поле, которое сайт пересоздал после вписывания, узнаём по значению: значения сравниваются здесь, не на странице.
    const secrets = vault.knownPasswords()
    for (const frame of page.frames()) {
      const inputs = frame.locator('input, textarea')
      const values = await inputs.evaluateAll((elements) => elements.map((element) => (element as HTMLInputElement).value)).catch(() => [] as string[])
      values.forEach((value, index) => {
        if (secrets.some((secret) => value.includes(secret))) mask.push(inputs.nth(index))
      })
    }
    mkdirSync(shotsDir, { recursive: true })
    const path = join(shotsDir, `${session.name}-${Date.now()}-${randomBytes(3).toString('hex')}.jpg`)
    await page.screenshot({ path, type: 'jpeg', quality: 70, mask, timeout: 15_000 })
    return { ok: true, path }
  }

  async function fillPassword(session: ProfileSession, input: Record<string, unknown>): Promise<ActionResult> {
    const entryId = Number(input.entryId)
    if (!Number.isInteger(entryId) || entryId <= 0) return fail('bad_request', 'entryId — номер входа из logins')
    const { entry, password } = vault.passwordFor(entryId)
    if (entry.profile !== session.name) return fail('refused_profile', `вход ${entryId} принадлежит другому профилю`)
    const locator = await elementOf(session.page, input.ref)
    const handle = (await locator.elementHandle({ timeout: ACTION_TIMEOUT_MS })) as ElementHandle<HTMLElement>
    const isPasswordField = await handle.evaluate((element) => element instanceof HTMLInputElement && element.type.toLowerCase() === 'password')
    if (!isPasswordField) return fail('refused_field', 'элемент — не поле пароля; пароль вписывается только в поле пароля')
    const frame = await handle.ownerFrame()
    const { site } = entry
    if (!frame || !isFrameAllowed(frame, policy.allowedOrigins) || !isLoginOrigin(frame.url(), site)) {
      return fail('refused_origin', `поле не на сайте входа ${site} (нужен точно этот адрес и https): пароль не вписан`)
    }
    await session.fields.mark(handle, 'filled')
    session.passwordFilled()
    await handle.fill(password, { timeout: ACTION_TIMEOUT_MS })
    return outcome(session)
  }

  async function pageCommand(command: BrowserCommand, session: ProfileSession, input: Record<string, unknown>): Promise<ActionResult> {
    const page = session.page
    switch (command) {
      case 'open':
        return { ok: true }
      case 'read':
        return outcome(session)
      case 'url': {
        if (typeof input.url !== 'string') return fail('bad_request', 'url обязателен')
        if (!isAllowedOrigin(input.url, policy.allowedOrigins)) return fail('refused_origin', 'сайт вне allowedOrigins')
        session.takeBlocked()
        await page.goto(input.url, { waitUntil: 'domcontentloaded', timeout: NAVIGATION_TIMEOUT_MS }).catch((error: Error) => {
          if (!/ERR_BLOCKED_BY_CLIENT|ERR_ABORTED/.test(error.message)) throw error
        })
        return outcome(session)
      }
      case 'back':
        session.takeBlocked()
        await page.goBack({ waitUntil: 'domcontentloaded', timeout: NAVIGATION_TIMEOUT_MS }).catch(() => null)
        return outcome(session)
      case 'click': {
        const danger = checkDanger(input.danger)
        if (!danger.ok) return danger
        const element = await elementOf(page, input.ref)
        const dangerous = await refuseDangerous(element, 'click')
        if (dangerous) return dangerous
        session.takeBlocked()
        await element.click({ timeout: ACTION_TIMEOUT_MS })
        return outcome(session)
      }
      case 'type': {
        const danger = checkDanger(input.danger)
        if (!danger.ok) return danger
        if (typeof input.text !== 'string') return fail('bad_request', 'text обязателен')
        const element = await elementOf(page, input.ref)
        if (input.submit === true) {
          const dangerous = await refuseDangerous(element, 'submit')
          if (dangerous) return dangerous
        }
        session.takeBlocked()
        await element.fill(input.text, { timeout: ACTION_TIMEOUT_MS })
        if (input.submit === true) await element.press('Enter', { timeout: ACTION_TIMEOUT_MS })
        return outcome(session)
      }
      case 'key': {
        if (typeof input.key !== 'string' || !/^[\w+-]{1,32}$/.test(input.key)) return fail('bad_request', 'key — имя клавиши, например Enter или Shift+Tab')
        if (SUBMIT_KEYS.test(input.key)) {
          const focused = await focusedElement(page)
          const dangerous = focused ? await refuseDangerous(focused, 'key') : null
          if (dangerous) return dangerous
        }
        session.takeBlocked()
        await page.keyboard.press(input.key)
        return outcome(session)
      }
      case 'scroll': {
        const direction = SCROLL_DIRECTIONS[input.direction as keyof typeof SCROLL_DIRECTIONS]
        if (!direction) return fail('bad_request', 'direction: up | down | left | right')
        const px = input.px === undefined ? 600 : Number(input.px)
        if (!Number.isFinite(px) || px <= 0 || px > 10_000) return fail('bad_request', 'px — от 1 до 10000')
        await page.mouse.wheel(direction[0] * px, direction[1] * px)
        return outcome(session)
      }
      case 'shot':
        return shot(session)
      case 'fill-password':
        return fillPassword(session, input)
      default:
        return fail('bad_request', `команда ${command} не относится к странице`)
    }
  }

  function statusOf(profile: string): ActionResult {
    if (control.holder(profile) === 'owner') return { ok: true, state: 'busy', reason: 'управление у владельца' }
    if (busy.has(profile)) return { ok: true, state: 'busy', reason: 'выполняется команда' }
    return { ok: true, state: 'ready' }
  }

  async function run(command: string, input: Record<string, unknown>): Promise<ActionResult> {
    if (!(BROWSER_COMMANDS as readonly string[]).includes(command)) return fail('not_found', `нет команды ${command}`)
    if (command === 'logins') {
      const { site } = input
      return { ok: true, logins: vault.list(typeof site === 'string' ? { site } : {}) }
    }
    const profile = input.profile
    if (typeof profile !== 'string' || profile === '') return fail('bad_request', 'profile обязателен')
    if (!profiles.knows(profile)) return fail('not_found', `профиль «${profile}» не задан в настройке`)
    if (command === 'status') {
      const status = statusOf(profile)
      const human = pendingHumanCheck(profile)
      if (status.ok && status.state === 'ready' && human) return { ok: true, state: 'needs_human', reason: human }
      return status
    }
    const refused = refuseIfHumanControl(control, profile)
    if (refused) return refused
    const human = pendingHumanCheck(profile)
    if (human && !ALLOWED_WHILE_HUMAN_CHECK.has(command)) {
      return fail('needs_human', `${human}: пока человек не прошёл проверку на живом экране, доступны только read и shot`)
    }

    const started = Date.now()
    const result = await inQueue(profile, async () => {
      const session = await profiles.get(profile)
      try {
        return await pageCommand(command as BrowserCommand, session, input)
      } catch (error) {
        if (error instanceof Refused) return fail(error.code, error.message)
        const message = error instanceof Error ? error.message.split('\n')[0]! : String(error)
        if (error instanceof Error && error.name === 'TimeoutError') return fail('timeout', message)
        if ((error as { code?: unknown }).code === 'not_found') return fail('not_found', message)
        throw error
      }
    })
    log({ event: 'command', profile, command, ...(typeof input.ref === 'string' ? { ref: input.ref } : {}), ok: result.ok, ...(result.ok ? {} : { code: result.code }), ms: Date.now() - started })
    return result
  }

  return { run }
}
