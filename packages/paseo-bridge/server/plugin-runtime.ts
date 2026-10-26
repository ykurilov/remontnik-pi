import type { AgentState, PaseoAgentsPort } from './agent-post.js'
import { DEFAULT_CONFIG_PATH, DEFAULT_STATE_FILE, loadBridgeConfig } from './bridge-config.js'
import { createPaseoBridge, startBridgeServer, type BridgeServer, type PaseoBridge } from './bridge-http.js'
import { errorText, type BridgeLog } from './report-relay.js'

// Мост внутри Paseo. Paseo отдаёт плагину доступ к себе только в контексте хука (README, T120),
// поэтому доступ берётся из первого пришедшего хука и хранится всю жизнь процесса плагина.

/** Часть API Paseo, которой пользуется мост: `agents.ref(id)` из `@getpaseo/client`. */
export interface PaseoAgentsApi {
  agents: {
    ref(id: string): {
      refresh(): Promise<unknown>
      current(): { status?: string | null; archivedAt?: string | null } | null
      send(text: string, options?: { activeTurnBehavior?: 'interrupt' | 'steer' }): Promise<void>
    }
  }
}

/** Часть контекста серверной части плагина: подписка на хуки. */
export interface PluginHooks {
  on(name: HookName, handler: (event: { agent: { id: string } }, context: { paseo: PaseoAgentsApi }) => void): () => void
}

const AGENT_HOOKS = [
  'agent.created',
  'agent.turn_started',
  'agent.turn_ended',
  'agent.permission_requested',
  'agent.permission_resolved',
  'agent.closed',
  'agent.archived',
] as const
type HookName = (typeof AGENT_HOOKS)[number]

export const LISTEN_RETRY_MS = 30_000
export const REPORT_POLL_MS = 60_000

/** Paseo через доступ из хуков. `closed` (после перезапуска Paseo) — агент есть, письмо его поднимет. */
export function paseoAgentsFromHooks(currentApi: () => PaseoAgentsApi | null): PaseoAgentsPort {
  return {
    async state(agentId): Promise<AgentState> {
      const api = currentApi()
      if (!api) return 'not_ready'
      const handle = api.agents.ref(agentId)
      try {
        await handle.refresh()
      } catch (error) {
        if (/not found/i.test(errorText(error))) return 'missing'
        throw error
      }
      const agent = handle.current()
      if (!agent || agent.archivedAt) return 'missing'
      return agent.status === 'running' || agent.status === 'initializing' ? 'running' : 'idle'
    },
    async send(agentId, text) {
      const api = currentApi()
      if (!api) throw new Error('Paseo ещё не дал доступ')
      // Мост пишет только свободному агенту; если ход начался в эту секунду — дописать в него, а не прервать.
      await api.agents.ref(agentId).send(text, { activeTurnBehavior: 'steer' })
    },
  }
}

export interface PluginPlaces {
  configPath?: string
  stateFile?: string
  log?: BridgeLog
  reportPollMs?: number
  idlePollMs?: number
}

export interface PaseoBridgeRuntime {
  /** Адрес, когда мост начал слушать. Нужен проверкам. */
  listening(): Promise<string>
  stop(): Promise<void>
}

export function startPaseoBridgePlugin(server: PluginHooks, places: PluginPlaces = {}): PaseoBridgeRuntime {
  const log: BridgeLog = places.log ?? ((entry) => console.log(JSON.stringify({ plugin: 'remontnik-paseo-bridge', ...entry })))
  let api: PaseoAgentsApi | null = null
  let stopped = false
  let bridge: PaseoBridge | null = null
  let httpServer: BridgeServer | null = null
  const timers = new Set<ReturnType<typeof setTimeout>>()
  let resolveListening: (url: string) => void = () => {}
  const listening = new Promise<string>((resolve) => (resolveListening = resolve))

  const offs = AGENT_HOOKS.map((name) =>
    server.on(name, (event, context) => {
      try {
        const firstAccess = api === null
        api = context.paseo
        if (firstAccess) {
          log({ event: 'paseo_ready' })
          void bridge?.pullAllReports()
        }
        if (name === 'agent.turn_ended' || name === 'agent.created') bridge?.agentMayBeIdle(event.agent.id)
      } catch (error) {
        log({ event: 'hook_failed', hook: name, reason: errorText(error) })
      }
    }),
  )

  const later = (fn: () => void, ms: number) => {
    const timer = setTimeout(() => {
      timers.delete(timer)
      fn()
    }, ms)
    timers.add(timer)
  }

  try {
    const config = loadBridgeConfig(places.configPath ?? DEFAULT_CONFIG_PATH)
    const activeBridge = createPaseoBridge({
      config,
      paseo: paseoAgentsFromHooks(() => api),
      stateFile: places.stateFile ?? DEFAULT_STATE_FILE,
      log,
      ...(places.idlePollMs === undefined ? {} : { idlePollMs: places.idlePollMs }),
    })
    bridge = activeBridge

    // Адрес частной сети при загрузке Mac может появиться позже Paseo — пробуем снова.
    const listen = async () => {
      if (stopped) return
      try {
        const started = await startBridgeServer({ listen: config.listen, handler: activeBridge.handler })
        if (stopped) {
          await started.close()
          return
        }
        httpServer = started
        log({ event: 'listening', url: started.url })
        resolveListening(started.url)
      } catch (error) {
        log({ event: 'listen_failed', reason: errorText(error), retryInMs: LISTEN_RETRY_MS })
        later(() => void listen(), LISTEN_RETRY_MS)
      }
    }
    void listen()

    const poll = () => {
      if (stopped) return
      void activeBridge.pullAllReports()
      later(poll, places.reportPollMs ?? REPORT_POLL_MS)
    }
    later(poll, places.reportPollMs ?? REPORT_POLL_MS)
  } catch (error) {
    // Без настройки мост молчит: врач увидит это по /health и будет лечить сам.
    log({ event: 'config_failed', reason: errorText(error) })
  }

  return {
    listening: () => listening,
    async stop() {
      stopped = true
      for (const off of offs) off()
      for (const timer of timers) clearTimeout(timer)
      timers.clear()
      await httpServer?.close()
      await bridge?.dispose()
    },
  }
}
