// Профили Ремонтника: у каждого своя постоянная папка Chromium на томе службы, одна рабочая вкладка
// и сетевой замок на весь контекст. В сеть Chromium выходит только через свой прокси службы (egress): там замок
// и держится. Прокси профиля, если задан, стоит за ним.
import { join } from 'node:path'
import { type BrowserContext, type Page, chromium } from 'playwright-core'
import { describeTarget, isAllowedTarget, startEgressProxy } from '../egress/index.js'
import { type BlockedRequest, type NetworkGuard, installNetworkGuard } from '../guard/index.js'
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
    let blocked: BlockedRequest[] = []
    const record = (request: BlockedRequest) => {
      blocked.push(request)
      log({ event: 'blocked', profile: profile.name, code: request.code, reason: request.reason })
    }
    let guard: NetworkGuard | undefined
    // Пока замок закрыт, соединения — только с allowedOrigins, что бы ни открывал скрипт страницы: воркеры,
    // SharedWorker, WebTransport, TURN по TCP, предварительные соединения. Постоянный запрет на весь сеанс —
    // это `isLocked` всегда истинно и свой список адресов.
    const egress = await startEgressProxy({
      allows: (target) => !guard?.isLocked() || isAllowedTarget(target, policy.allowedOrigins),
      onRefused: (target) => record({ code: 'refused_leak', reason: `соединение с ${describeTarget(target)}: на странице пароль, адрес вне allowedOrigins` }),
      ...(proxy ? { upstream: proxy } : {}),
    })
    const context = await chromium.launchPersistentContext(join(dataDir, 'profiles', profile.name), {
      headless,
      viewport: profile.viewport ?? DEFAULT_VIEWPORT,
      locale: 'ru-RU',
      serviceWorkers: 'block',
      acceptDownloads: false,
      // Петля (localhost) тоже идёт через прокси: Playwright сам добавляет `<-loopback>` к обходу.
      proxy: { server: egress.url },
      args: [
        // Мимо прокси не уходит ничего: QUIC (WebTransport, HTTP/3) выключен, WebRTC — без UDP мимо прокси,
        // а имена Chromium сам не разрешает вовсе — их разрешает прокси, поэтому пароль в имени хоста дальше
        // браузера не уходит.
        '--disable-quic',
        '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
        `--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE ${new URL(egress.url).hostname}`,
      ],
    }).catch(async (error: unknown) => {
      await egress.close()
      throw error
    })
    context.on('close', () => void egress.close())
    guard = await installNetworkGuard(context, policy, record)
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
      passwordFilled: () => {
        guard!.passwordFilled(page)
        egress.dropRefused()
      },
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
