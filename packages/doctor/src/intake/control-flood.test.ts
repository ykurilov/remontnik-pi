import { connect, type Socket } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { NONCE_HEADER, ReplayGuard, SIGNATURE_HEADER, TIMESTAMP_HEADER, signRequest } from '@ykurilov/remontnik-core/signed-http'
import { createMemoryRecordStore } from '../records/index.js'
import { createControls } from '../ledgers/controls.js'
import { createCaseRetryHandler } from './case-retry.js'
import { createDeployControlsHandler } from './deploy-controls.js'
import { createIntakeHandler, startIntakeServer, type IntakeHandler, type IntakeServer } from './index.js'

// Приложение с общим секретом не должно уметь вытеснить из памяти повторов метку перехваченной команды владельца:
// отказ по роли метку не занимает, полная память отвечает отказом, а не вытесняет; пути управления — с пределом запросов.

const SECRET = 'shared-secret-for-flood-tests'
const CONTROL_SECRET = 'owner-secret-for-flood-tests'

let server: IntakeServer | undefined

afterEach(async () => {
  await server?.close()
  server = undefined
})

async function serve(handler: Partial<Parameters<typeof createIntakeHandler>[0]>): Promise<string> {
  server = await startIntakeServer({
    handler: createIntakeHandler({ secret: SECRET, receiveEvents: async () => ({ accepted: [] }), health: () => ({ ok: true }), ...handler }),
    host: '127.0.0.1',
    port: 0,
  })
  return server.url
}

function signedPost(target: string, body: string, secret: string) {
  return { method: 'POST', headers: { 'content-type': 'application/json', ...signRequest({ method: 'POST', target, body, secret }) }, body }
}

describe('память повторов на путях управления', () => {
  it('отказы общим секретом (403) не вытесняют метку команды владельца: её повтор — 401 replayed', async () => {
    const retried: number[] = []
    const caseRetry: IntakeHandler = createCaseRetryHandler({
      secret: SECRET,
      controlSecret: CONTROL_SECRET,
      replayGuard: new ReplayGuard(600_000, 3),
      retryCase: async (caseId) => {
        retried.push(caseId)
        return { retried: 'parked', attempt: 2 }
      },
    })
    const url = await serve({ caseRetry })
    const command = JSON.stringify({ caseId: 7, action: 'retry', by: 'owner' })
    const owner = signedPost('/v1/control/cases', command, CONTROL_SECRET)
    expect((await fetch(`${url}/v1/control/cases`, owner)).status).toBe(200)

    for (let index = 0; index < 5; index += 1) {
      const flood = await fetch(`${url}/v1/control/cases`, signedPost('/v1/control/cases', command, SECRET))
      expect(flood.status).toBe(403)
    }
    const replay = await fetch(`${url}/v1/control/cases`, owner)
    expect(replay.status).toBe(401)
    expect(await replay.json()).toEqual({ error: 'replayed' })
    expect(retried).toEqual([7])
  })

  it('стоп-кран: «пуск» общим секретом не занимает память; полная память — 503, а не вытеснение', async () => {
    const controls = createControls(createMemoryRecordStore(), () => new Date())
    const deployControls = createDeployControlsHandler({ controls, secret: SECRET, controlSecret: CONTROL_SECRET, replayGuard: new ReplayGuard(600_000, 2) })
    const url = await serve({ deployControls })
    const target = '/v1/control/deploys'
    const resume = signedPost(target, JSON.stringify({ action: 'resume', by: 'owner' }), CONTROL_SECRET)
    expect((await fetch(`${url}${target}`, resume)).status).toBe(200)
    for (let index = 0; index < 4; index += 1) {
      expect((await fetch(`${url}${target}`, signedPost(target, JSON.stringify({ action: 'resume', by: 'app' }), SECRET))).status).toBe(403)
    }
    expect((await fetch(`${url}${target}`, resume)).status).toBe(401)

    // «Стоп» общим секретом разрешён и место занимает: второе место занято — дальше отказ, метка владельца на месте.
    expect((await fetch(`${url}${target}`, signedPost(target, JSON.stringify({ action: 'stop', by: 'app' }), SECRET))).status).toBe(200)
    const full = await fetch(`${url}${target}`, signedPost(target, JSON.stringify({ action: 'stop', by: 'app' }), SECRET))
    expect(full.status).toBe(503)
    expect(await full.json()).toEqual({ error: 'replay_memory_full' })
    const replay = await fetch(`${url}${target}`, resume)
    expect(replay.status).toBe(401)
    expect(await replay.json()).toEqual({ error: 'replayed' })
  })
})

describe('предел запросов с одного адреса на путях управления', () => {
  it('сверх предела — 429 rate_limited для неподписанных и подписанных общим секретом; приём событий и /health предел не считают', async () => {
    const controls = createControls(createMemoryRecordStore(), () => new Date())
    const url = await serve({
      deployControls: createDeployControlsHandler({ controls, secret: SECRET, controlSecret: CONTROL_SECRET }),
      controlRateLimit: { limit: 3, windowMs: 60_000 },
    })
    const target = '/v1/control/deploys'
    expect((await fetch(`${url}${target}`, { method: 'POST', body: '{}' })).status).toBe(401)
    for (let index = 0; index < 2; index += 1) {
      expect((await fetch(`${url}${target}`, signedPost(target, JSON.stringify({ action: 'stop', by: 'app' }), SECRET))).status).toBe(200)
    }
    const limited = await fetch(`${url}${target}`, signedPost(target, JSON.stringify({ action: 'stop', by: 'app' }), SECRET))
    expect(limited.status).toBe(429)
    expect(await limited.json()).toEqual({ error: 'rate_limited' })
    expect((await fetch(`${url}${target}`, { method: 'POST', body: '{}' })).status).toBe(429)
    expect((await fetch(`${url}/health`)).status).toBe(200)
    expect((await fetch(`${url}/v1/events`, { method: 'POST', body: '{}' })).status).toBe(401)
  })

  it('команды владельца чужой поток с того же адреса не тормозит и сами предел не тратят', async () => {
    const controls = createControls(createMemoryRecordStore(), () => new Date())
    const retried: number[] = []
    const url = await serve({
      deployControls: createDeployControlsHandler({ controls, secret: SECRET, controlSecret: CONTROL_SECRET }),
      caseRetry: createCaseRetryHandler({
        secret: SECRET,
        controlSecret: CONTROL_SECRET,
        retryCase: async (caseId) => {
          retried.push(caseId)
          return { retried: 'parked', attempt: 2 }
        },
      }),
      controlRateLimit: { limit: 2, windowMs: 60_000 },
    })
    // Приложение (или мусор) с того же адреса съело весь предел.
    for (let index = 0; index < 5; index += 1) await fetch(`${url}/v1/control/cases`, { method: 'POST', body: '{}' })
    expect((await fetch(`${url}/v1/control/deploys`, signedPost('/v1/control/deploys', JSON.stringify({ action: 'stop', by: 'app' }), SECRET))).status).toBe(429)

    for (let index = 0; index < 4; index += 1) {
      const owner = await fetch(`${url}/v1/control/deploys`, signedPost('/v1/control/deploys', JSON.stringify({ action: index % 2 ? 'resume' : 'stop', by: 'owner' }), CONTROL_SECRET))
      expect(owner.status).toBe(200)
    }
    const retry = await fetch(`${url}/v1/control/cases`, signedPost('/v1/control/cases', JSON.stringify({ caseId: 3, action: 'retry', by: 'owner' }), CONTROL_SECRET))
    expect(retry.status).toBe(200)
    expect(retried).toEqual([3])
  })
})

describe('медленные тела на путях управления', () => {
  /** Подписанный запрос сырым сокетом: заголовки сразу, тело — через `bodyDelayMs` (или только `{`, и соединение висит). */
  function rawPost(url: string, target: string, options: { secret?: string; body?: string; bodyDelayMs?: number; signed?: boolean } = {}) {
    const { port } = new URL(url)
    const body = options.body ?? '{"action":"stop","by":"app"}'
    const headers = signRequest({ method: 'POST', target, body, secret: options.secret ?? SECRET })
    const slow = options.bodyDelayMs === undefined
    let answer = ''
    return new Promise<{ socket: Socket; answer: () => string }>((resolve) => {
      const socket = connect(Number(port), '127.0.0.1', () => {
        socket.write(
          `POST ${target} HTTP/1.1\r\nHost: x\r\ncontent-type: application/json\r\ncontent-length: ${slow ? 1000 : Buffer.byteLength(body)}\r\n` +
            (options.signed === false ? '' : `${SIGNATURE_HEADER}: ${headers[SIGNATURE_HEADER]}\r\n${TIMESTAMP_HEADER}: ${headers[TIMESTAMP_HEADER]}\r\n${NONCE_HEADER}: ${headers[NONCE_HEADER]}\r\n`) +
            `\r\n${slow ? '{' : ''}`,
        )
        if (!slow) setTimeout(() => socket.write(body), options.bodyDelayMs)
        resolve({ socket, answer: () => answer })
      })
      socket.on('data', (chunk) => (answer += chunk.toString()))
      socket.on('error', () => {})
    })
  }
  const slowBody = async (url: string, target: string) => (await rawPost(url, target)).socket
  const closed = (socket: Socket) => socket.destroyed || socket.readableEnded
  const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

  function serveControls(controlBodyReads: Parameters<typeof createIntakeHandler>[0]['controlBodyReads']) {
    const controls = createControls(createMemoryRecordStore(), () => new Date())
    return serve({ deployControls: createDeployControlsHandler({ controls, secret: SECRET, controlSecret: CONTROL_SECRET }), controlSecret: CONTROL_SECRET, controlBodyReads })
  }

  it('с одного адреса одновременно читается не больше предела тел: лишнее вытесняет висящее, команда владельца проходит', async () => {
    const url = await serveControls({ perAddress: 2, total: 10, graceMs: 0 })
    const target = '/v1/control/deploys'
    const sockets: Socket[] = []
    for (let index = 0; index < 5; index += 1) {
      sockets.push(await slowBody(url, target))
      await pause(30)
    }
    await expect.poll(() => sockets.filter((socket) => !closed(socket)).length).toBe(2)

    const owner = await fetch(`${url}${target}`, signedPost(target, JSON.stringify({ action: 'stop', by: 'owner' }), CONTROL_SECRET))
    expect(owner.status).toBe(200)
    for (const socket of sockets) socket.destroy()
  })

  it('поток новых медленных тел с того же адреса не вытесняет команду владельца, чьё тело ещё в пути', async () => {
    const url = await serveControls({ perAddress: 2, total: 10, graceMs: 300 })
    const target = '/v1/control/deploys'
    const sockets: Socket[] = []
    for (let index = 0; index < 2; index += 1) sockets.push(await slowBody(url, target))
    await pause(400)

    // Тело владельца приходит через 150 мс; всё это время с того же адреса каждые 10 мс открывается новое медленное тело.
    const owner = await rawPost(url, target, { secret: CONTROL_SECRET, body: JSON.stringify({ action: 'stop', by: 'owner' }), bodyDelayMs: 150 })
    for (let index = 0; index < 30; index += 1) {
      sockets.push(await slowBody(url, target))
      await pause(10)
    }
    await expect.poll(() => owner.answer()).toMatch(/^HTTP\/1\.1 200/)
    for (const socket of [...sockets, owner.socket]) socket.destroy()
  })

  it('отказ без чтения тела сразу освобождает место: соединение ещё открыто, а команда владельца проходит', async () => {
    const url = await serveControls({ perAddress: 1, total: 10, graceMs: 60_000 })
    const target = '/v1/control/deploys'
    const unsigned = await rawPost(url, target, { signed: false })
    await expect.poll(() => unsigned.answer()).toMatch(/^HTTP\/1\.1 401/)
    expect(closed(unsigned.socket)).toBe(false)

    const owner = await fetch(`${url}${target}`, signedPost(target, JSON.stringify({ action: 'stop', by: 'owner' }), CONTROL_SECRET))
    expect(owner.status).toBe(200)
    unsigned.socket.destroy()
  })

  it('мест нет и вытеснить некого — чужой запрос получает 503 body_reads_full', async () => {
    const url = await serveControls({ perAddress: 1, total: 10, graceMs: 60_000 })
    const target = '/v1/control/deploys'
    const hanging = await slowBody(url, target)
    await pause(30)
    const refused = await fetch(`${url}${target}`, signedPost(target, JSON.stringify({ action: 'stop', by: 'app' }), SECRET))
    expect(refused.status).toBe(503)
    expect(await refused.json()).toEqual({ error: 'body_reads_full' })
    hanging.destroy()
  })

  it('атакующий держит все места адреса и переоткрывает их до срока вытеснения — стоп-кран владельца с того же адреса проходит', async () => {
    const graceMs = 300
    const url = await serveControls({ perAddress: 2, total: 10, graceMs })
    const target = '/v1/control/deploys'
    let held = await Promise.all([slowBody(url, target), slowBody(url, target)])
    const all = [...held]
    let flooding = true
    // Каждое место переоткрывается раньше срока: старше `graceMs` чтений нет, вытеснять по сроку некого.
    const flood = (async () => {
      while (flooding) {
        await pause(graceMs - 100)
        const fresh = await Promise.all(held.map(() => slowBody(url, target)))
        for (const socket of held) socket.destroy()
        held = fresh
        all.push(...fresh)
      }
    })()
    await pause(graceMs * 2)
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const owner = await fetch(`${url}${target}`, signedPost(target, JSON.stringify({ action: attempt % 2 ? 'resume' : 'stop', by: 'owner' }), CONTROL_SECRET))
      expect(owner.status).toBe(200)
      await pause(graceMs / 2)
    }
    flooding = false
    await flood
    for (const socket of all) socket.destroy()
  })

  it('подпись заголовков владельца без верной подписи тела не проходит: 401, а не исполнение', async () => {
    const url = await serveControls({ perAddress: 1, total: 10, graceMs: 60_000 })
    const target = '/v1/control/deploys'
    const hanging = await slowBody(url, target)
    await pause(30)
    const request = signedPost(target, JSON.stringify({ action: 'stop', by: 'owner' }), CONTROL_SECRET)
    const forged = await fetch(`${url}${target}`, { ...request, body: JSON.stringify({ action: 'resume', by: 'owner' }) })
    expect(forged.status).toBe(401)
    hanging.destroy()
  })
})
