// Профили Ремонтника: у каждого своя постоянная папка Chromium на томе службы, одна рабочая вкладка
// и сетевой замок на весь контекст. Прокси выключен, если в профиле не задан.
import { join } from 'node:path'
import { type BrowserContext, type Page, chromium } from 'playwright-core'
import { type BlockedRequest, installNetworkGuard } from '../guard/index.js'
import type { BrowserPolicy, BrowserProfileConfig } from '../policy/index.js'
import type { ServiceLog } from '../log.js'
import { type SensitiveFields, createSensitiveFields } from '../snapshot/index.js'

export interface ProfileSession {
  readonly name: string
  readonly context: BrowserContext
  readonly page: Page
  readonly fields: SensitiveFields
  /** Заблокированные запросы с последнего вызова: действие по ним понимает, что его остановил замок. */
  takeBlocked(): BlockedRequest[]
  /** Сейчас в рабочую вкладку впишется пароль: сетевой замок закрывает другие сайты до новой страницы. */
  passwordFilled(): void
}

export interface Profiles {
  get(name: string): Promise<ProfileSession>
  knows(name: string): boolean
  closeAll(): Promise<void>
}

const DEFAULT_VIEWPORT = { width: 1280, height: 800 }

function proxyOf(profile: BrowserProfileConfig, env: NodeJS.ProcessEnv) {
  if (!profile.proxy) return undefined
  const { server, usernameEnv, passwordEnv } = profile.proxy
  return {
    server,
    ...(usernameEnv && env[usernameEnv] ? { username: env[usernameEnv] } : {}),
    ...(passwordEnv && env[passwordEnv] ? { password: env[passwordEnv] } : {}),
  }
}

export function createProfiles(options: {
  dataDir: string
  policy: BrowserPolicy
  log: ServiceLog
  env?: NodeJS.ProcessEnv
  headless?: boolean
}): Profiles {
  const { dataDir, policy, log, env = process.env, headless = true } = options
  const sessions = new Map<string, Promise<ProfileSession>>()

  async function launch(profile: BrowserProfileConfig): Promise<ProfileSession> {
    const proxy = proxyOf(profile, env)
    const context = await chromium.launchPersistentContext(join(dataDir, 'profiles', profile.name), {
      headless,
      viewport: profile.viewport ?? DEFAULT_VIEWPORT,
      locale: 'ru-RU',
      serviceWorkers: 'block',
      acceptDownloads: false,
      // Второй слой к замку каналов: WebRTC не ходит по UDP мимо прокси (сам WebRTC в страницах убран).
      args: ['--force-webrtc-ip-handling-policy=disable_non_proxied_udp'],
      ...(proxy ? { proxy } : {}),
    })
    let blocked: BlockedRequest[] = []
    const guard = await installNetworkGuard(context, policy, (request) => {
      blocked.push(request)
      log({ event: 'blocked', profile: profile.name, code: request.code, reason: request.reason })
    })
    const page = context.pages()[0] ?? (await context.newPage())
    // Рабочая вкладка одна: новые окна закрываются, чтобы ничего не шло мимо снимков и замков.
    context.on('page', (extra) => {
      if (extra === page) return
      log({ event: 'popup_closed', profile: profile.name })
      void extra.close().catch(() => {})
    })
    log({ event: 'profile_opened', profile: profile.name, proxy: proxy ? 'on' : 'off' })
    return {
      name: profile.name,
      context,
      page,
      fields: createSensitiveFields(),
      takeBlocked() {
        const taken = blocked
        blocked = []
        return taken
      },
      passwordFilled: () => guard.passwordFilled(page),
    }
  }

  return {
    knows: (name) => policy.profiles.some((profile) => profile.name === name),
    get(name) {
      const profile = policy.profiles.find((candidate) => candidate.name === name)
      if (!profile) return Promise.reject(Object.assign(new Error(`профиль «${name}» не задан в настройке`), { code: 'not_found' }))
      let session = sessions.get(name)
      if (!session) {
        session = launch(profile)
        session.catch(() => sessions.delete(name))
        sessions.set(name, session)
      }
      return session
    },
    async closeAll() {
      const opened = [...sessions.values()]
      sessions.clear()
      await Promise.all(opened.map(async (session) => (await session.catch(() => null))?.context.close()))
    },
  }
}
