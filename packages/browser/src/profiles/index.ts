// Профили Ремонтника: у каждого своя постоянная папка Chromium на томе службы, одна рабочая вкладка
// и сетевой замок на весь контекст. В сеть Chromium выходит только через свой прокси службы (egress): там замок
// и держится. Прокси профиля, если задан, стоит за ним.
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { type BrowserContext, type Page, chromium } from 'playwright-core'
import { type EgressTarget, describeTarget, isAllowedTarget, startEgressProxy } from '../egress/index.js'
import { type BlockedRequest, LOCKED_HINT, LOCKED_REASON, type NetworkGuard, installNetworkGuard, siteOf } from '../guard/index.js'
import { createBlockedJournal } from './blocked-journal.js'
import { type BrowserPolicy, type BrowserProfileConfig, sessionOrigins } from '../policy/index.js'
import type { ServiceLog } from '../log.js'
import { type SensitiveFields, createSensitiveFields } from '../snapshot/index.js'

export interface ProfileSession {
  readonly name: string
  readonly context: BrowserContext
  readonly page: Page
  readonly fields: SensitiveFields
  /** Заблокированные запросы с последнего вызова: действие по ним понимает, что его остановил замок. */
  takeBlocked(): BlockedRequest[]
  /** Сейчас в рабочую вкладку впишется пароль: сетевой замок закрывает другие сайты до конца сеанса профиля. */
  passwordFilled(): void
}

export interface Profiles {
  get(name: string): Promise<ProfileSession>
  knows(name: string): boolean
  closeAll(): Promise<void>
}

const DEFAULT_VIEWPORT = { width: 1280, height: 800 }
/**
 * Метка в папке профиля: пароль в профиль уже вписывали. Хранилище страниц (localStorage, IndexedDB, cookie)
 * переживает перезапуск службы — значит, и замок тоже. Снимается только вместе с папкой профиля.
 */
const SESSION_LOCK_FILE = 'remontnik-session-locked'

/** Адрес соединения для `siteOf` и проверки на пароль: у туннеля схемы не видно, но сайту она не нужна. */
function targetUrl(target: EgressTarget): string {
  return target.origin ?? `https://${target.host.includes(':') ? `[${target.host}]` : target.host}:${target.port}`
}

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
  /** Только для тестов: внутренние `ip:port` (IPv6 — в скобках), куда прокси службы всё же пускает. */
  reachableInternal?: readonly string[]
  /** Есть ли в тексте сохранённый пароль (в любом виде, который знает фильтр службы): так отказ замка — попытка утечки. */
  passwordIn?: (text: string) => boolean
}): Profiles {
  const { dataDir, policy, log, env = process.env, headless = true, passwordIn = () => false } = options
  const sessions = new Map<string, Promise<ProfileSession>>()

  async function launch(profile: BrowserProfileConfig): Promise<ProfileSession> {
    const proxy = proxyOf(profile, env)
    const blocked = createBlockedJournal(
      (request) => {
        const domain = request.domain ? { domain: request.domain, hint: LOCKED_HINT } : {}
        log({ event: 'blocked', profile: profile.name, code: request.code, reason: request.reason, ...domain })
        if (request.suspect) log({ event: 'leak_attempt', profile: profile.name, how: request.suspect, ...domain })
      },
      () => log({ event: 'blocked_overflow', profile: profile.name }),
    )
    // Счётчик после входа и попытка унести пароль закрываются одинаково, но в журнале различаются: запись или
    // сокет на другой сайт и пароль в адресе — отдельное событие `leak_attempt`. Полный адрес дальше не идёт.
    const record = ({ url, ...request }: BlockedRequest) =>
      blocked.record(request.code === 'refused_leak' && !request.suspect && url !== undefined && passwordIn(url) ? { ...request, suspect: 'пароль в адресе' } : request)
    const userDataDir = join(dataDir, 'profiles', profile.name)
    const lockFile = join(userDataDir, SESSION_LOCK_FILE)
    const lockedBefore = existsSync(lockFile)
    let guard: NetworkGuard | undefined
    const origins = sessionOrigins(policy)
    // Пока сеанс заперт, соединения — только с allowedOrigins и extraOrigins, что бы ни открывал скрипт страницы:
    // воркеры, SharedWorker, WebTransport, TURN по TCP, предварительные соединения. Внутренние адреса (петля,
    // частные сети, метаданные облака) закрыты всегда, кроме allowedOrigins: адрес из extraOrigins проверяется
    // по тому IP, который вернул DNS.
    const egress = await startEgressProxy({
      allows: (target) => !(guard ? guard.isLocked() : lockedBefore) || isAllowedTarget(target, origins),
      exempt: (target) => isAllowedTarget(target, policy.allowedOrigins),
      onRefused: (target, reason) =>
        record(
          reason === 'internal'
            ? { code: 'refused_internal', reason: `соединение с ${describeTarget(target)}: внутренний адрес вне allowedOrigins` }
            : { code: 'refused_leak', reason: `соединение с другим сайтом: ${LOCKED_REASON}`, domain: siteOf(targetUrl(target)), url: targetUrl(target) },
        ),
      ...(proxy ? { upstream: proxy } : {}),
      ...(options.reachableInternal ? { reachableInternal: options.reachableInternal } : {}),
    })
    const context = await chromium.launchPersistentContext(userDataDir, {
      headless,
      viewport: profile.viewport ?? DEFAULT_VIEWPORT,
      locale: 'ru-RU',
      serviceWorkers: 'block',
      acceptDownloads: false,
      // Петля (localhost) тоже идёт через прокси: Playwright сам добавляет `<-loopback>` к обходу. Имя и пароль
      // прокси — свои на каждый запуск: другие программы на машине через него не ходят.
      proxy: { server: egress.url, username: egress.username, password: egress.password },
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
    guard = await installNetworkGuard(context, policy, record, { locked: lockedBefore })
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
      takeBlocked: () => blocked.take(),
      passwordFilled: () => {
        // Сначала метка на диске: служба упадёт посреди ввода — после перезапуска сеанс всё равно заперт.
        writeFileSync(lockFile, '')
        guard!.passwordFilled()
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
