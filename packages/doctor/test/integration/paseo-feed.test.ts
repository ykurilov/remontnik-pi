import { mkdtempSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createIncidentEvent } from '@ykurilov/remontnik-core/incident'
import { signBody } from '@ykurilov/remontnik-core/signed-http'
import { startFakeTelegram, type FakeTelegramServer } from '@ykurilov/remontnik-core/testing'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { startDoctorService, type DoctorService } from '../../src/service/index.js'
import { FakePaseo, freshStateFile, startBridge, until } from '../../../paseo-bridge/test/bridge-world.js'
import type { BridgeConfig } from '../../../paseo-bridge/server/index.js'

// История 9, независимая проверка: настоящий врач (SQLite) и настоящий мост с подставным Paseo.
// Мост выключен → три случая → мост включён → агент получает три отчёта по порядку, по одному разу.

const WATCH_SECRET = 'watch-secret-for-tests'
const BRIDGE_SECRET = 'bridge-secret-for-tests'
const TOKEN = 'reports-token-for-tests'
const APP = 'patient'
const AGENT = 'agent-patient-0001'

let stateDir: string
let telegram: FakeTelegramServer
let doctor: DoctorService | null
let closers: (() => Promise<void>)[]

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as { port: number }
      probe.close(() => resolve(port))
    })
  })
}

async function startDoctor(bridgePort: number, withFeed = true): Promise<DoctorService> {
  const service = await startDoctorService({
    stateDir,
    sharedSecret: WATCH_SECRET,
    listen: { host: '127.0.0.1', port: 0 },
    telegram: { botToken: '123456:test-bot-token', chatId: 'owner-chat', apiBaseUrl: telegram.baseUrl },
    ...(withFeed ? { reportsFeed: { token: TOKEN, bridge: { listen: { host: '127.0.0.1', port: bridgePort }, secret: BRIDGE_SECRET, appName: APP } } } : {}),
    exit: vi.fn(),
    log: () => {},
  })
  doctor = service
  return service
}

async function stopDoctor(): Promise<void> {
  await doctor?.close()
  doctor = null
}

async function openCase(where: string): Promise<void> {
  const body = JSON.stringify({ events: [createIncidentEvent({ appName: APP, kind: 'crash', where, message: `сбой в ${where}` })] })
  const response = await fetch(`${doctor!.url}/v1/events`, { method: 'POST', headers: signBody(body, WATCH_SECRET), body })
  expect(response.status).toBe(200)
}

function bridgeConfig(doctorUrl: string, secret = BRIDGE_SECRET): BridgeConfig {
  return { listen: { host: '127.0.0.1', port: 0 }, apps: new Map([[APP, { agentId: AGENT, doctorUrl, secret }]]) }
}

async function startBridgeFor(paseo: FakePaseo, stateFile: string, secret = BRIDGE_SECRET) {
  const world = await startBridge({ config: bridgeConfig(doctor!.bridgeUrl!, secret), paseo, stateFile })
  closers.push(world.close)
  return world
}

const reportNumbers = (paseo: FakePaseo) =>
  paseo.lettersTo(AGENT).map((letter) => Number(/Отчёт Ремонтника №(\d+)/.exec(letter)?.[1]))

beforeEach(async () => {
  stateDir = mkdtempSync(join(tmpdir(), 'remontnik-feed-'))
  telegram = await startFakeTelegram()
  doctor = null
  closers = []
})

afterEach(async () => {
  for (const close of closers.reverse()) await close()
  await stopDoctor()
  await telegram.close()
})

describe('отчёты врача → агент Paseo через мост', () => {
  it('мост выключен: три случая копятся; мост включён — три отчёта по порядку, по одному разу', async () => {
    const bridgePort = await freePort()
    await startDoctor(bridgePort)
    for (const where of ['src/a.ts:1:1', 'src/b.ts:2:2', 'src/c.ts:3:3']) await openCase(where)

    const paseo = new FakePaseo()
    paseo.states.set(AGENT, 'idle')
    const world = await startBridgeFor(paseo, freshStateFile())
    await world.bridge.pullReports(APP)

    expect(reportNumbers(paseo)).toEqual([1, 2, 3])
    expect(paseo.lettersTo(AGENT)[0]).toContain('src/a.ts:1:1')
    expect(await doctor!.reports.paseoAcked()).toBe(3)

    await world.bridge.pullReports(APP)
    expect(reportNumbers(paseo)).toEqual([1, 2, 3])
  })

  it('мост выключали и включали, врач перезапускался: уходят только новые отчёты, номера не повторяются', async () => {
    const bridgePort = await freePort()
    await startDoctor(bridgePort)
    const paseo = new FakePaseo()
    paseo.states.set(AGENT, 'idle')
    const stateFile = freshStateFile()
    for (const where of ['src/a.ts:1:1', 'src/b.ts:2:2']) await openCase(where)
    const first = await startBridgeFor(paseo, stateFile)
    await first.bridge.pullReports(APP)
    await first.close()
    closers.pop()

    await stopDoctor()
    await startDoctor(bridgePort)
    for (const where of ['src/c.ts:3:3', 'src/d.ts:4:4']) await openCase(where)
    const second = await startBridgeFor(paseo, stateFile)
    await second.bridge.pullReports(APP)

    expect(reportNumbers(paseo)).toEqual([1, 2, 3, 4])
    expect(await doctor!.reports.paseoAcked()).toBe(4)
  })

  it('агента нет в Paseo: отчёты ждут у врача и уходят, когда агент появился', async () => {
    const bridgePort = await freePort()
    await startDoctor(bridgePort)
    for (const where of ['src/a.ts:1:1', 'src/b.ts:2:2']) await openCase(where)
    const paseo = new FakePaseo()
    const world = await startBridgeFor(paseo, freshStateFile())

    await world.bridge.pullReports(APP)
    expect(paseo.letters).toEqual([])
    expect(await doctor!.reports.paseoAcked()).toBe(0)

    paseo.states.set(AGENT, 'idle')
    await world.bridge.pullReports(APP)

    expect(reportNumbers(paseo)).toEqual([1, 2])
  })

  it('мост с чужим секретом ничего не получает, подтверждение не двигается', async () => {
    const bridgePort = await freePort()
    await startDoctor(bridgePort)
    await openCase('src/a.ts:1:1')
    const paseo = new FakePaseo()
    paseo.states.set(AGENT, 'idle')
    const world = await startBridgeFor(paseo, freshStateFile(), 'foreign-secret')

    await world.bridge.pullReports(APP)

    expect(paseo.letters).toEqual([])
    expect(world.journal.some((entry) => entry.event === 'reports_failed')).toBe(true)
    expect(await doctor!.reports.paseoAcked()).toBe(0)
  })

  it('отчёты о Telegram и Paseo не мешают друг другу: сообщение владельцу уходит, отчёт попадает и в ленту', async () => {
    const bridgePort = await freePort()
    const service = await startDoctor(bridgePort)
    service.handleHarnessReport(new Error('crash loop'), {
      type: 'task_parked',
      task: { id: 'task-1' as never, kind: 'remontnik.treatment', conversationId: 'conv-1' as never },
    })
    await until(() => telegram.messages.length === 1)
    const paseo = new FakePaseo()
    paseo.states.set(AGENT, 'idle')
    const world = await startBridgeFor(paseo, freshStateFile())

    await world.bridge.pullReports(APP)

    expect(reportNumbers(paseo)).toEqual([1])
    expect(paseo.lettersTo(AGENT)[0]).toContain('doctor_problem')
  })
})

describe('доступ к ленте', () => {
  it('адрес для моста — только частная сеть: публичный адрес и «все адреса» не открываются', async () => {
    for (const host of ['0.0.0.0', '::', '203.0.113.7', 'doctor.example.com']) {
      const attempt = startDoctorService({
        stateDir,
        sharedSecret: WATCH_SECRET,
        listen: { host: '127.0.0.1', port: 0 },
        telegram: { botToken: '123456:test-bot-token', chatId: 'owner-chat', apiBaseUrl: telegram.baseUrl },
        reportsFeed: { bridge: { listen: { host, port: 0 }, secret: BRIDGE_SECRET, appName: APP } },
        exit: vi.fn(),
        log: () => {},
      })
      await expect(attempt, host).rejects.toThrow(/частной сети/)
    }
  })

  it('лента на основном адресе — только по ключу владельца; без настройки её нет', async () => {
    const bridgePort = await freePort()
    await startDoctor(bridgePort)
    await openCase('src/a.ts:1:1')

    const open = await fetch(`${doctor!.url}/v1/reports?after=0`)
    const owner = await fetch(`${doctor!.url}/v1/reports?after=0`, { headers: { authorization: `Bearer ${TOKEN}` } })

    expect(open.status).toBe(401)
    expect(owner.status).toBe(200)
    expect((await owner.json()).reports).toHaveLength(1)

    await stopDoctor()
    await startDoctor(bridgePort, false)
    const bare = await fetch(`${doctor!.url}/v1/reports?after=0`, { headers: { authorization: `Bearer ${TOKEN}` } })
    expect(bare.status).toBe(404)
    expect(doctor!.bridgeUrl).toBeNull()
  })
})
