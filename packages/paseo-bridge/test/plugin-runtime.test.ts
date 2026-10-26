import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { startPaseoBridgePlugin, type PluginHooks } from '../server/index.js'
import { SHOP_SECRET, shopTask, signedGet, signedPost, until } from './bridge-world.js'

// Подставной API плагина Paseo: хуки и agents.ref(id).

interface FakeAgent {
  status: string
  archivedAt?: string | null
}

function fakePaseoApi(agents: Map<string, FakeAgent>, sent: { id: string; text: string; options: unknown }[]) {
  return {
    agents: {
      ref(id: string) {
        return {
          async refresh() {
            if (!agents.has(id)) throw new Error(`Agent not found: ${id}`)
            return null
          },
          current() {
            return agents.get(id) ?? null
          },
          async send(text: string, options?: unknown) {
            sent.push({ id, text, options })
          },
        }
      },
    },
  }
}

function fakeServer() {
  const handlers = new Map<string, ((event: unknown, context: unknown) => unknown)[]>()
  const server: PluginHooks = {
    on(name, handler) {
      const list = handlers.get(name) ?? []
      list.push(handler as (event: unknown, context: unknown) => unknown)
      handlers.set(name, list)
      return () => handlers.set(name, (handlers.get(name) ?? []).filter((item) => item !== handler))
    },
  }
  return {
    server,
    emit(name: string, event: unknown, context: unknown) {
      for (const handler of handlers.get(name) ?? []) void handler(event, context)
    },
    count: () => [...handlers.values()].reduce((sum, list) => sum + list.length, 0),
  }
}

function ownerFiles() {
  const directory = mkdtempSync(join(tmpdir(), 'remontnik-plugin-'))
  const secretFile = join(directory, 'shop-bridge')
  writeFileSync(secretFile, SHOP_SECRET)
  const configPath = join(directory, 'paseo-bridge.json')
  writeFileSync(
    configPath,
    JSON.stringify({
      listen: '127.0.0.1:0',
      apps: { shop: { agentId: 'agent-shop', doctorUrl: 'http://127.0.0.1:9', secretFile } },
    }),
  )
  return { configPath, stateFile: join(directory, 'state.json') }
}

let stops: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const stop of stops) await stop()
  stops = []
})

describe('плагин в Paseo', () => {
  it('доступ к Paseo берёт из первого хука; до него агент считается недоступным', async () => {
    const agents = new Map<string, FakeAgent>([['agent-shop', { status: 'idle' }]])
    const sent: { id: string; text: string; options: unknown }[] = []
    const hooks = fakeServer()
    const runtime = startPaseoBridgePlugin(hooks.server, { ...ownerFiles(), log: () => {}, reportPollMs: 60_000 })
    stops.push(runtime.stop)
    const url = await runtime.listening()

    expect((await signedGet(url, '/health?app=shop', SHOP_SECRET)).body).toEqual({
      paseo: 'up',
      agent: 'missing',
      reason: 'paseo_not_ready',
    })

    hooks.emit('agent.turn_started', { agent: { id: 'other' } }, { paseo: fakePaseoApi(agents, sent) })
    expect((await signedGet(url, '/health?app=shop', SHOP_SECRET)).body).toEqual({ paseo: 'up', agent: 'idle' })

    agents.set('agent-shop', { status: 'running' })
    expect((await signedGet(url, '/health?app=shop', SHOP_SECRET)).body).toEqual({ paseo: 'up', agent: 'running' })
    agents.set('agent-shop', { status: 'idle', archivedAt: '2026-10-26T10:00:00.000Z' })
    expect((await signedGet(url, '/health?app=shop', SHOP_SECRET)).body).toEqual({ paseo: 'up', agent: 'missing' })
    agents.delete('agent-shop')
    expect((await signedGet(url, '/health?app=shop', SHOP_SECRET)).body).toEqual({ paseo: 'up', agent: 'missing' })
  })

  it('занятому агенту письмо уходит после конца его хода и без прерывания', async () => {
    const agents = new Map<string, FakeAgent>([['agent-shop', { status: 'running' }]])
    const sent: { id: string; text: string; options: unknown }[] = []
    const hooks = fakeServer()
    const runtime = startPaseoBridgePlugin(hooks.server, {
      ...ownerFiles(),
      log: () => {},
      reportPollMs: 60_000,
      idlePollMs: 60_000,
    })
    stops.push(runtime.stop)
    const url = await runtime.listening()
    const paseo = fakePaseoApi(agents, sent)
    hooks.emit('agent.created', { agent: { id: 'agent-shop' } }, { paseo })

    expect(await signedPost(`${url}/v1/tasks`, shopTask(), SHOP_SECRET)).toEqual({ status: 200, body: { queued: true } })
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(sent).toEqual([])

    agents.set('agent-shop', { status: 'idle' })
    hooks.emit('agent.turn_ended', { agent: { id: 'agent-shop' } }, { paseo })
    await until(() => sent.length === 1)
    expect(sent[0]!.id).toBe('agent-shop')
    expect(sent[0]!.options).toEqual({ activeTurnBehavior: 'steer' })
  })

  it('остановка снимает хуки и закрывает адрес', async () => {
    const hooks = fakeServer()
    const runtime = startPaseoBridgePlugin(hooks.server, { ...ownerFiles(), log: () => {}, reportPollMs: 60_000 })
    const url = await runtime.listening()
    expect(hooks.count()).toBeGreaterThan(0)
    await runtime.stop()
    expect(hooks.count()).toBe(0)
    await expect(fetch(`${url}/health?app=shop`)).rejects.toThrow()
  })
})
