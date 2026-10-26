// Запуск службы целиком: профили, хранилище входов, замки, HTTP для врача и, если задан адрес, живой экран.
import { join } from 'node:path'
import { createBrowserActions } from '../actions/index.js'
import { createControlLock } from '../live/control.js'
import { type LiveAddress, type LiveScreen, createLiveScreen, parseLiveListen } from '../live/server.js'
import { createLiveTargets } from '../live/stream.js'
import { type LogSink, createServiceLog } from '../log.js'
import { type BrowserPolicy, loadBrowserPolicy } from '../policy/index.js'
import { createProfiles } from '../profiles/index.js'
import { createOutputFilter, loginVaultPath, openLoginVault, parseVaultKey } from '../vault/index.js'
import { createBrowserHttpServer } from './index.js'

/** Только петля; «все адреса» (`0.0.0.0`, нужно в контейнере) — только явно через REMONTNIK_BROWSER_LISTEN. */
export const DEFAULT_BROWSER_LISTEN = '127.0.0.1:7700'

export interface BrowserServiceOptions {
  token: string
  vaultKey: Buffer
  dataDir: string
  policy: BrowserPolicy
  listen: { host: string; port: number }
  live: { listen: LiveAddress; ownerToken: string } | null
  log?: LogSink
  env?: NodeJS.ProcessEnv
  /** Только для тестов: внутренние `ip:port`, куда прокси браузера всё же пускает (например, страница теста на петле). */
  reachableInternal?: readonly string[]
}

export interface RunningBrowserService {
  url: string
  liveUrl: string | null
  close(): Promise<void>
}

export async function startBrowserService(options: BrowserServiceOptions): Promise<RunningBrowserService> {
  if (options.token.length < 16) throw new Error('REMONTNIK_BROWSER_TOKEN: нужен ключ врача не короче 16 знаков')
  const sink = options.log ?? ((line: string) => process.stderr.write(`${line}\n`))
  const vault = openLoginVault({ file: loginVaultPath(options.dataDir), key: options.vaultKey })
  vault.list() // ключ не подходит — падаем сразу, а не на первом вписывании
  const filter = createOutputFilter(() => vault.knownPasswords())
  const log = createServiceLog(sink, filter)
  const control = createControlLock()
  const profiles = createProfiles({
    dataDir: options.dataDir,
    policy: options.policy,
    log,
    ...(options.env ? { env: options.env } : {}),
    ...(options.reachableInternal ? { reachableInternal: options.reachableInternal } : {}),
  })
  const runner = createBrowserActions({ profiles, vault, policy: options.policy, shotsDir: join(options.dataDir, 'shots'), control, log })

  const server = createBrowserHttpServer({ token: options.token, runner, filter, log: sink })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.listen.port, options.listen.host, () => resolve())
  })
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : options.listen.port
  const host = options.listen.host === '0.0.0.0' ? '127.0.0.1' : options.listen.host

  let live: LiveScreen | null = null
  try {
    if (options.live) {
      live = await createLiveScreen({ ...options.live, doctorToken: options.token, control, targets: createLiveTargets(profiles), log })
    }
  } catch (error) {
    server.close()
    throw error
  }
  log({ event: 'started', port, live: live ? 'on' : 'off' })

  return {
    url: `http://${host}:${port}`,
    liveUrl: live?.url ?? null,
    async close() {
      await live?.close()
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await profiles.closeAll()
    },
  }
}

function parseListen(value: string): { host: string; port: number } {
  const match = /^([\d.]+|\[[0-9a-f:]+\]):(\d{1,5})$/i.exec(value)
  if (!match) throw new Error(`REMONTNIK_BROWSER_LISTEN: ожидается «адрес:порт», получено «${value}»`)
  return { host: match[1]!.replace(/^\[|\]$/g, ''), port: Number(match[2]) }
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]
  if (!value) throw new Error(`${name} не задан`)
  return value
}

/** Настройки только из окружения контейнера браузера (contracts/browser-api.md). */
export async function startBrowserServiceFromEnv(env: NodeJS.ProcessEnv = process.env): Promise<RunningBrowserService> {
  const liveListen = env.REMONTNIK_BROWSER_LIVE_LISTEN
  const ownerToken = env.REMONTNIK_BROWSER_OWNER_TOKEN
  if (liveListen && !ownerToken) throw new Error('REMONTNIK_BROWSER_LIVE_LISTEN задан, а REMONTNIK_BROWSER_OWNER_TOKEN нет')
  return startBrowserService({
    token: required(env, 'REMONTNIK_BROWSER_TOKEN'),
    vaultKey: parseVaultKey(env.REMONTNIK_BROWSER_VAULT_KEY),
    dataDir: required(env, 'REMONTNIK_BROWSER_DATA_DIR'),
    policy: loadBrowserPolicy(required(env, 'REMONTNIK_BROWSER_POLICY')),
    listen: parseListen(env.REMONTNIK_BROWSER_LISTEN ?? DEFAULT_BROWSER_LISTEN),
    live: liveListen && ownerToken ? { listen: parseLiveListen(liveListen), ownerToken } : null,
    env,
  })
}
