import { execFile } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { dockerClientEnv } from '../workbench/runner.js'

// Сети случая. Контейнеры одной сети видят друг друга, поэтому у каждой копии случая свои закрытые сети:
// `workbench` — команды модели и установка зависимостей (там слушает зеркало реестра), `checks` — тесты,
// проверка типов и eval (там слушает прокси eval). Сеть — `internal` (шлюза наружу нет) и с
// `com.docker.network.bridge.inhibit_ipv4` (у моста нет адреса на хосте, службы сервера не видны).
//
// Врач подключается к сети на свой постоянный адрес `.2` и слушает только на нём. Адреса контейнеров Docker
// выдаёт из верхней половины подсети (`--ip-range`), поэтому адрес врача занять нельзя. Перед каждой командой сеть
// сверяется по ID: та же сеть и всё ещё закрытая; иначе команда не запускается. После простоя сеть удаляется.

export type CaseNetworkKind = 'workbench' | 'checks'

export interface CaseNetwork {
  id: string
  name: string
  kind: CaseNetworkKind
  /** Адрес врача в этой сети: на нём зеркало или прокси eval. */
  gatewayIp: string
}

export interface CaseNetworkLease {
  network: CaseNetwork
  /** Команда закончилась: без команд сеть живёт ещё `idleMs` и удаляется. */
  done(): void
}

export interface CaseNetworks {
  /** Сеть копии для одной команды: создаётся при первой, сверяется перед каждой. */
  use(copyDir: string, kind: CaseNetworkKind): Promise<CaseNetworkLease>
  /** Удалить сети прошлого запуска врача (по метке). */
  removeStale(): Promise<void>
  close(): Promise<void>
}

export interface CaseNetworksOptions {
  docker?: string
  /** Контейнер врача: подключается к каждой сети случая. */
  gatewayContainer: string
  /** Откуда брать подсети `/27`; по умолчанию `10.213.0.0/16`. Не должен пересекаться с сетями сервера. */
  subnetPool?: string
  /** Что слушать на адресе врача в сети; возвращает закрытие. */
  attach: Record<CaseNetworkKind, (ip: string) => Promise<() => Promise<void>>>
  /** Сколько сеть живёт без команд; по умолчанию 10 минут. */
  idleMs?: number
  log?: (line: string) => void
}

export const CASE_NETWORK_LABEL = 'remontnik.case-network'
const DEFAULT_SUBNET_POOL = '10.213.0.0/16'
const SUBNET_BITS = 27
const SUBNET_SIZE = 2 ** (32 - SUBNET_BITS)
const IDLE_MS = 10 * 60_000
const DOCKER_TIMEOUT_MS = 60_000
const MAX_SUBNET_ATTEMPTS = 64

function ipToInt(ip: string): number {
  const parts = ip.split('.').map(Number)
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) throw new Error(`не адрес IPv4: ${ip}`)
  return parts.reduce((sum, part) => sum * 256 + part, 0)
}

function intToIp(value: number): string {
  return [24, 16, 8, 0].map((shift) => Math.floor(value / 2 ** shift) % 256).join('.')
}

function parsePool(pool: string): { base: number; count: number } {
  const match = /^([\d.]+)\/(\d{1,2})$/.exec(pool.trim())
  const bits = Number(match?.[2])
  if (!match || bits > SUBNET_BITS - 1 || bits < 8) throw new Error(`пул подсетей сетей случая: нужен IPv4 вида a.b.c.d/N, N от 8 до ${SUBNET_BITS - 1}, а не «${pool}»`)
  const size = 2 ** (32 - bits)
  const base = ipToInt(match[1]!)
  if (base % size !== 0) throw new Error(`пул подсетей сетей случая «${pool}»: адрес не на границе сети`)
  return { base, count: size / SUBNET_SIZE }
}

interface Entry {
  kind: CaseNetworkKind
  /** Создание сети; общее для одновременных первых команд. */
  ready: Promise<CaseNetwork>
  network?: CaseNetwork
  index?: number
  closeListener?: () => Promise<void>
  active: number
  timer?: NodeJS.Timeout
  releasing?: Promise<void>
}

export function createCaseNetworks(options: CaseNetworksOptions): CaseNetworks {
  const docker = options.docker ?? 'docker'
  const pool = parsePool(options.subnetPool ?? DEFAULT_SUBNET_POOL)
  const idleMs = options.idleMs ?? IDLE_MS
  const log = options.log ?? (() => {})
  const entries = new Map<string, Entry>()
  const usedSubnets = new Set<number>()
  let nextSubnet = 0
  let closed = false

  function dockerRun(args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile(docker, args, { env: dockerClientEnv(), timeout: DOCKER_TIMEOUT_MS, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
        if (error) reject(new Error(`${String(stderr || error.message).trim().slice(-300)}`))
        else resolve(stdout.trim())
      })
    })
  }

  /** Сеть существует под тем же ID, закрыта и без адреса моста на хосте. */
  async function verify(network: CaseNetwork): Promise<void> {
    let answer: string
    try {
      answer = await dockerRun(['network', 'inspect', '--format', '{{.Id}} {{.Internal}} {{index .Options "com.docker.network.bridge.inhibit_ipv4"}}', network.id])
    } catch (error) {
      throw new Error(`сеть случая ${network.name} не найдена по ID: ${(error as Error).message}`)
    }
    const [id, internal, inhibit] = answer.split(/\s+/)
    if (id !== network.id) throw new Error(`сеть случая ${network.name} сменилась: другой ID`)
    if (internal !== 'true') throw new Error(`сеть случая ${network.name} не закрыта: нужна internal`)
    if (inhibit !== 'true') throw new Error(`у сети случая ${network.name} мост с адресом на хосте: нужна com.docker.network.bridge.inhibit_ipv4`)
  }

  async function createNetwork(copyDir: string, kind: CaseNetworkKind, entry: Entry): Promise<CaseNetwork> {
    const copy = createHash('sha256').update(copyDir).digest('hex').slice(0, 12)
    const name = `remontnik-case-${copy}-${kind}-${randomBytes(3).toString('hex')}`
    let lastError: Error | undefined
    for (let attempt = 0; attempt < MAX_SUBNET_ATTEMPTS && usedSubnets.size < pool.count; attempt += 1) {
      while (usedSubnets.has(nextSubnet % pool.count)) nextSubnet += 1
      const index = nextSubnet % pool.count
      nextSubnet += 1
      const subnet = pool.base + index * SUBNET_SIZE
      usedSubnets.add(index)
      let id: string
      try {
        id = await dockerRun([
          'network', 'create',
          '--driver', 'bridge',
          '--internal',
          '--opt', 'com.docker.network.bridge.inhibit_ipv4=true',
          '--subnet', `${intToIp(subnet)}/${SUBNET_BITS}`,
          '--gateway', intToIp(subnet + 1),
          '--ip-range', `${intToIp(subnet + SUBNET_SIZE / 2)}/${SUBNET_BITS + 1}`,
          '--label', `${CASE_NETWORK_LABEL}=${kind}`,
          '--label', `remontnik.copy=${copy}`,
          name,
        ])
      } catch (error) {
        usedSubnets.delete(index)
        lastError = error as Error
        if (/overlap/i.test(lastError.message)) continue
        throw new Error(`сеть случая не создалась: ${lastError.message}`)
      }
      const network: CaseNetwork = { id, name, kind, gatewayIp: intToIp(subnet + 2) }
      entry.index = index
      try {
        await dockerRun(['network', 'connect', '--ip', network.gatewayIp, id, options.gatewayContainer])
      } catch (error) {
        await removeNetwork(network, entry)
        throw new Error(`врач не подключился к сети случая ${name}: ${(error as Error).message}`)
      }
      try {
        entry.closeListener = await options.attach[kind](network.gatewayIp)
      } catch (error) {
        await removeNetwork(network, entry)
        throw new Error(`врач не начал слушать в сети случая ${name}: ${(error as Error).message}`)
      }
      log(`[врач] сеть случая ${name} (${kind}) создана, врач на ${network.gatewayIp}`)
      return network
    }
    throw new Error(`свободной подсети для сети случая нет: ${lastError?.message ?? 'пул занят'}`)
  }

  async function removeNetwork(network: CaseNetwork, entry: Entry): Promise<void> {
    await entry.closeListener?.().catch(() => {})
    await dockerRun(['network', 'disconnect', '--force', network.id, options.gatewayContainer]).catch(() => {})
    try {
      await dockerRun(['network', 'rm', network.id])
    } catch (error) {
      log(`[врач] сеть случая ${network.name} не удалилась: ${(error as Error).message}`)
    }
    if (entry.index !== undefined) usedSubnets.delete(entry.index)
  }

  function release(key: string, entry: Entry): Promise<void> {
    entry.releasing ??= (async () => {
      clearTimeout(entry.timer)
      const network = await entry.ready.catch(() => undefined)
      if (network) await removeNetwork(network, entry)
      if (entries.get(key) === entry) entries.delete(key)
    })()
    return entry.releasing
  }

  return {
    async use(copyDir, kind) {
      if (closed) throw new Error('сети случая закрыты: врач останавливается')
      const key = `${copyDir}\0${kind}`
      let entry = entries.get(key)
      if (entry?.releasing) {
        await entry.releasing
        entry = entries.get(key)
      }
      if (!entry) {
        const fresh: Entry = { kind, active: 0, ready: Promise.resolve(undefined as never) }
        fresh.ready = createNetwork(copyDir, kind, fresh)
        fresh.ready.catch(() => {
          if (entries.get(key) === fresh) entries.delete(key)
        })
        entries.set(key, fresh)
        entry = fresh
      }
      const current = entry
      current.active += 1
      clearTimeout(current.timer)
      let network: CaseNetwork
      try {
        network = await current.ready
        await verify(network)
      } catch (error) {
        current.active -= 1
        throw error
      }
      let finished = false
      return {
        network,
        done() {
          if (finished) return
          finished = true
          current.active -= 1
          if (current.active > 0 || current.releasing) return
          current.timer = setTimeout(() => void release(key, current), idleMs)
          current.timer.unref()
        },
      }
    },
    async removeStale() {
      const ids = (await dockerRun(['network', 'ls', '--filter', `label=${CASE_NETWORK_LABEL}`, '--format', '{{.ID}}'])).split('\n').filter(Boolean)
      for (const id of ids) {
        await dockerRun(['network', 'disconnect', '--force', id, options.gatewayContainer]).catch(() => {})
        await dockerRun(['network', 'rm', id]).catch((error: Error) => log(`[врач] старая сеть случая ${id} не удалилась: ${error.message}`))
      }
    },
    async close() {
      closed = true
      for (const [key, entry] of [...entries]) await release(key, entry)
    },
  }
}

/** Адрес контейнера в сети по её имени: врач слушает приём событий только там. */
export async function containerAddress(container: string, network: string, docker = 'docker'): Promise<string> {
  const answer = await new Promise<string>((resolve, reject) => {
    execFile(docker, ['inspect', '--format', '{{json .NetworkSettings.Networks}}', container], { env: dockerClientEnv(), timeout: DOCKER_TIMEOUT_MS }, (error, stdout, stderr) => {
      if (error) reject(new Error(`контейнер ${container} не найден: ${String(stderr || error.message).trim().slice(-300)}`))
      else resolve(stdout.trim())
    })
  })
  let networks: Record<string, { IPAddress?: string }>
  try {
    networks = JSON.parse(answer) as Record<string, { IPAddress?: string }>
  } catch {
    throw new Error(`сети контейнера ${container} не разобрались`)
  }
  const ip = networks[network]?.IPAddress
  if (!ip) throw new Error(`контейнер ${container} не подключён к сети ${network}`)
  return ip
}
