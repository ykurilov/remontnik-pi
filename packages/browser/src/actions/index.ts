// Команды врача над профилем: открыть, перейти, снимок, клик, ввод, клавиша, прокрутка, снимок экрана,
// входы и вписывание пароля. Команды одного профиля идут по очереди. Своего кода на странице нет.
import { randomBytes } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { ElementHandle, Locator, Page } from 'playwright-core'
import { checkDanger, findHumanCheck, isAllowedOrigin } from '../guard/index.js'
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

/** Сайт входа или его поддомен, та же схема и порт. */
function belongsToSite(frameUrl: string, site: string): boolean {
  try {
    const frame = new URL(frameUrl)
    const login = new URL(site)
    return (
      frame.protocol === login.protocol &&
      frame.port === login.port &&
      (frame.hostname === login.hostname || frame.hostname.endsWith(`.${login.hostname}`))
    )
  } catch {
    return false
  }
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
    if ((await locator.count().catch(() => 0)) === 0) throw new Refused('not_found', `элемента ${ref} нет: сделайте read заново`)
    return locator
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
    const snapshot = await takeSnapshot(page, session.fields)
    const human = await findHumanCheck(page, snapshot.text)
    session.humanCheck = human.needsHuman ? human.reason : null
    const blocked = session.takeBlocked()
    if (blocked.length > 0) {
      return fail(blocked[0]!.code, `заблокировано замком: ${blocked.map((request) => request.reason).join('; ')}`)
    }
    if (human.needsHuman) return fail('needs_human', `${human.reason}: нужен человек, браузер остановился`)
    return { ok: true, url: snapshot.url, title: snapshot.title, snapshot: snapshot.snapshot }
  }

  async function shot(session: ProfileSession): Promise<ActionResult> {
    const page = session.page
    await settle(page)
    const snapshot = await takeSnapshot(page, session.fields)
    const mask = [...snapshot.sensitiveRefs.map((ref) => page.getByRef(ref)), ...page.frames().map((frame) => frame.locator(PASSWORD_FIELDS))]
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
    if (!frame || !belongsToSite(frame.url(), site)) {
      return fail('refused_origin', `поле не на сайте входа ${site}: пароль не вписан`)
    }
    await session.fields.mark(handle, 'filled')
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
        session.takeBlocked()
        await element.click({ timeout: ACTION_TIMEOUT_MS })
        return outcome(session)
      }
      case 'type': {
        const danger = checkDanger(input.danger)
        if (!danger.ok) return danger
        if (typeof input.text !== 'string') return fail('bad_request', 'text обязателен')
        const element = await elementOf(page, input.ref)
        session.takeBlocked()
        await element.fill(input.text, { timeout: ACTION_TIMEOUT_MS })
        if (input.submit === true) await element.press('Enter', { timeout: ACTION_TIMEOUT_MS })
        return outcome(session)
      }
      case 'key': {
        if (typeof input.key !== 'string' || !/^[\w+-]{1,32}$/.test(input.key)) return fail('bad_request', 'key — имя клавиши, например Enter или Shift+Tab')
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
      if (status.ok && status.state === 'ready') {
        const human = (await profiles.get(profile)).humanCheck
        if (human) return { ok: true, state: 'needs_human', reason: human }
      }
      return status
    }
    const refused = refuseIfHumanControl(control, profile)
    if (refused) return refused

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
