import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createCaseNetworks, type CaseNetworks, type CaseNetworksOptions } from './index.js'

// Сети случая: на каждую копию — свои закрытые сети верстака и проверок. Врач подключается к ним сам и слушает
// там зеркало реестра и прокси eval. Перед каждой командой сеть сверяется по ID: та же и всё ещё закрытая.

const dirs: string[] = []
const opened: CaseNetworks[] = []
afterEach(async () => {
  while (opened.length > 0) await opened.pop()!.close()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

interface FakeNetwork {
  id: string
  name: string
  internal: boolean
  inhibit: boolean
  subnet: string
  labels: Record<string, string>
}

/** Подставной `docker`: сети хранятся в файле, вызовы пишутся в журнал. */
function fakeDocker() {
  const root = mkdtempSync(join(tmpdir(), 'remontnik-case-net-'))
  dirs.push(root)
  const state = join(root, 'state.json')
  const calls = join(root, 'calls.json')
  writeFileSync(state, JSON.stringify({ networks: [], taken: [], next: 1 }))
  writeFileSync(calls, '[]')
  const docker = join(root, 'docker')
  writeFileSync(
    docker,
    `#!/usr/bin/env node
const fs = require('node:fs')
const args = process.argv.slice(2)
const state = JSON.parse(fs.readFileSync(${JSON.stringify(state)}, 'utf8'))
const calls = JSON.parse(fs.readFileSync(${JSON.stringify(calls)}, 'utf8'))
calls.push(args)
fs.writeFileSync(${JSON.stringify(calls)}, JSON.stringify(calls))
const save = () => fs.writeFileSync(${JSON.stringify(state)}, JSON.stringify(state))
const flag = (name) => { const i = args.indexOf(name); return i === -1 ? undefined : args[i + 1] }
const flags = (name) => args.flatMap((a, i) => (a === name ? [args[i + 1]] : []))
const fail = (text) => { process.stderr.write(text + '\\n'); process.exit(1) }
const [group, verb] = args
if (group !== 'network') fail('неизвестная команда')
if (verb === 'create') {
  const subnet = flag('--subnet')
  if (state.taken.includes(subnet)) fail('Error response from daemon: invalid pool request: Pool overlaps with other one on this address space')
  const labels = Object.fromEntries(flags('--label').map((l) => l.split('=')))
  const id = String(state.next++).padStart(64, 'a')
  state.networks.push({ id, name: args[args.length - 1], internal: args.includes('--internal'), inhibit: flags('--opt').includes('com.docker.network.bridge.inhibit_ipv4=true'), subnet, labels })
  save()
  console.log(id)
} else if (verb === 'inspect') {
  const network = state.networks.find((n) => n.id === args[args.length - 1])
  if (!network) fail('Error: No such network')
  console.log([network.id, network.internal, network.inhibit ? 'true' : '<no value>'].join(' '))
} else if (verb === 'connect') {
  if (fs.existsSync(${JSON.stringify(join(root, 'connect-fails'))})) fail('connect failed')
} else if (verb === 'disconnect') {
} else if (verb === 'rm') {
  state.networks = state.networks.filter((n) => n.id !== args[2])
  save()
} else if (verb === 'ls') {
  const label = flag('--filter').replace(/^label=/, '')
  for (const n of state.networks) if (label in n.labels) console.log(n.id)
} else fail('неизвестная команда сети')
`,
    { mode: 0o755 },
  )
  const read = () => JSON.parse(readFileSync(state, 'utf8')) as { networks: FakeNetwork[]; taken: string[] }
  return {
    docker,
    calls: () => JSON.parse(readFileSync(calls, 'utf8')) as string[][],
    networks: () => read().networks,
    tamper: (id: string, change: Partial<FakeNetwork>) => {
      const current = read()
      current.networks = current.networks.map((n) => (n.id === id ? { ...n, ...change } : n))
      writeFileSync(state, JSON.stringify(current))
    },
    occupy: (subnet: string) => {
      const current = read()
      current.taken.push(subnet)
      writeFileSync(state, JSON.stringify(current))
    },
    addForeign: (network: FakeNetwork) => {
      const current = read()
      current.networks.push(network)
      writeFileSync(state, JSON.stringify(current))
    },
    connectFails: () => writeFileSync(join(root, 'connect-fails'), ''),
  }
}

function networks(docker: string, overrides: Partial<CaseNetworksOptions> = {}) {
  const attached: string[] = []
  const detached: string[] = []
  const created = createCaseNetworks({
    docker,
    gatewayContainer: 'remontnik-doctor',
    subnetPool: '10.213.0.0/16',
    attach: {
      workbench: async (ip) => {
        attached.push(`workbench ${ip}`)
        return async () => void detached.push(`workbench ${ip}`)
      },
      checks: async (ip) => {
        attached.push(`checks ${ip}`)
        return async () => void detached.push(`checks ${ip}`)
      },
    },
    idleMs: 60_000,
    ...overrides,
  })
  opened.push(created)
  return { created, attached, detached }
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

describe('сети случая', () => {
  it('первая команда копии создаёт закрытую сеть без адреса моста, врач подключается на свой адрес', async () => {
    const fake = fakeDocker()
    const { created, attached } = networks(fake.docker)
    const lease = await created.use('/srv/worktrees/case-1', 'workbench')
    lease.done()
    const create = fake.calls().find((call) => call[1] === 'create')!
    expect(create).toEqual(expect.arrayContaining(['--internal', '--opt', 'com.docker.network.bridge.inhibit_ipv4=true', '--subnet', '10.213.0.0/27', '--gateway', '10.213.0.1', '--ip-range', '10.213.0.16/28']))
    expect(create).toEqual(expect.arrayContaining(['--label', 'remontnik.case-network=workbench']))
    const connect = fake.calls().find((call) => call[1] === 'connect')!
    expect(connect).toEqual(['network', 'connect', '--ip', '10.213.0.2', lease.network.id, 'remontnik-doctor'])
    expect(lease.network).toMatchObject({ gatewayIp: '10.213.0.2' })
    expect(lease.network.id).toMatch(/^[0-9a-f]{64}$/)
    expect(attached).toEqual(['workbench 10.213.0.2'])
  })

  it('та же копия и тот же вид — та же сеть; другая копия или другой вид — своя сеть и своя подсеть', async () => {
    const fake = fakeDocker()
    const { created } = networks(fake.docker)
    const first = await created.use('/srv/worktrees/case-1', 'workbench')
    const again = await created.use('/srv/worktrees/case-1', 'workbench')
    const checks = await created.use('/srv/worktrees/case-1', 'checks')
    const other = await created.use('/srv/worktrees/case-2', 'workbench')
    for (const lease of [first, again, checks, other]) lease.done()
    expect(again.network.id).toBe(first.network.id)
    expect(new Set([first.network.id, checks.network.id, other.network.id]).size).toBe(3)
    expect(fake.networks().map((n) => n.subnet).sort()).toEqual(['10.213.0.0/27', '10.213.0.32/27', '10.213.0.64/27'])
  })

  it('одновременные первые команды копии создают одну сеть', async () => {
    const fake = fakeDocker()
    const { created } = networks(fake.docker)
    const leases = await Promise.all([1, 2, 3].map(() => created.use('/srv/worktrees/case-1', 'checks')))
    for (const lease of leases) lease.done()
    expect(fake.networks()).toHaveLength(1)
  })

  it('подсеть занята чужой сетью → следующая', async () => {
    const fake = fakeDocker()
    fake.occupy('10.213.0.0/27')
    const { created } = networks(fake.docker)
    const lease = await created.use('/srv/worktrees/case-1', 'workbench')
    lease.done()
    expect(lease.network.gatewayIp).toBe('10.213.0.34')
  })

  it('врач не подключился → сеть удаляется, команда не идёт', async () => {
    const fake = fakeDocker()
    fake.connectFails()
    const { created } = networks(fake.docker)
    await expect(created.use('/srv/worktrees/case-1', 'workbench')).rejects.toThrow(/не подключился/)
    expect(fake.networks()).toEqual([])
  })
})

describe('сверка сети перед каждой командой', () => {
  it.each([
    ['стала открытой', { internal: false }, /не закрыта/],
    ['у моста появился адрес на хосте', { inhibit: false }, /inhibit_ipv4/],
  ])('сеть %s → отказ запуска', async (_what, change, error) => {
    const fake = fakeDocker()
    const { created } = networks(fake.docker)
    const first = await created.use('/srv/worktrees/case-1', 'workbench')
    first.done()
    fake.tamper(first.network.id, change)
    await expect(created.use('/srv/worktrees/case-1', 'workbench')).rejects.toThrow(error)
  })

  it('сеть удалили и создали заново с тем же именем → отказ: сверка по ID', async () => {
    const fake = fakeDocker()
    const { created } = networks(fake.docker)
    const first = await created.use('/srv/worktrees/case-1', 'workbench')
    first.done()
    const old = fake.networks()[0]!
    fake.tamper(old.id, { id: 'f'.repeat(64) })
    await expect(created.use('/srv/worktrees/case-1', 'workbench')).rejects.toThrow(/не найдена|сменилась/)
    expect(fake.calls().filter((call) => call[1] === 'inspect').at(-1)!.at(-1)).toBe(old.id)
  })

  it('сверка не прошла → сеть освобождается целиком; следующая команда — новая закрытая сеть', async () => {
    const fake = fakeDocker()
    const { created, detached } = networks(fake.docker)
    const first = await created.use('/srv/worktrees/case-1', 'workbench')
    first.done()
    fake.tamper(first.network.id, { internal: false })
    await expect(created.use('/srv/worktrees/case-1', 'workbench')).rejects.toThrow(/не закрыта/)
    // Слушатель закрыт, врач отключён, сеть удалена — не ждёт простоя и перезапуска врача.
    expect(detached).toEqual([`workbench ${first.network.gatewayIp}`])
    expect(fake.calls()).toEqual(expect.arrayContaining([['network', 'disconnect', '--force', first.network.id, 'remontnik-doctor'], ['network', 'rm', first.network.id]]))
    expect(fake.networks()).toEqual([])
    const next = await created.use('/srv/worktrees/case-1', 'workbench')
    expect(next.network.id).not.toBe(first.network.id)
    expect(fake.networks()).toEqual([expect.objectContaining({ id: next.network.id, internal: true })])
    next.done()
  })
})

describe('жизнь сетей', () => {
  it('после простоя сеть удаляется: врач уходит из неё, слушатель закрывается; следующая команда — новая сеть', async () => {
    const fake = fakeDocker()
    const { created, detached } = networks(fake.docker, { idleMs: 100 })
    const lease = await created.use('/srv/worktrees/case-1', 'checks')
    const id = lease.network.id
    await wait(250)
    expect(fake.networks()).toHaveLength(1) // пока команда идёт, сеть живёт
    lease.done()
    await wait(300)
    expect(detached).toEqual(['checks 10.213.0.2'])
    expect(fake.calls()).toEqual(expect.arrayContaining([['network', 'disconnect', '--force', id, 'remontnik-doctor'], ['network', 'rm', id]]))
    expect(fake.networks()).toEqual([])
    const next = await created.use('/srv/worktrees/case-1', 'checks')
    next.done()
    expect(next.network.id).not.toBe(id)
  })

  it('остатки прошлого запуска удаляются; чужие сети не трогаются', async () => {
    const fake = fakeDocker()
    const stale = { id: 'b'.repeat(64), name: 'remontnik-case-old', internal: true, inhibit: true, subnet: '10.213.1.0/27', labels: { 'remontnik.case-network': 'checks' } }
    const foreign = { id: 'c'.repeat(64), name: 'app', internal: false, inhibit: false, subnet: '172.20.0.0/16', labels: {} }
    fake.addForeign(stale)
    fake.addForeign(foreign)
    const { created } = networks(fake.docker)
    await created.removeStale()
    expect(fake.networks().map((n) => n.id)).toEqual([foreign.id])
  })

  it('закрытие удаляет все сети', async () => {
    const fake = fakeDocker()
    const { created } = networks(fake.docker)
    ;(await created.use('/srv/worktrees/case-1', 'workbench')).done()
    ;(await created.use('/srv/worktrees/case-2', 'checks')).done()
    await created.close()
    expect(fake.networks()).toEqual([])
  })

  it('пул подсетей шире /27 обязателен', () => {
    expect(() => createCaseNetworks({ gatewayContainer: 'x', subnetPool: '10.213.0.0/28', attach: { workbench: async () => async () => {}, checks: async () => async () => {} } })).toThrow(/подсет/)
  })
})
