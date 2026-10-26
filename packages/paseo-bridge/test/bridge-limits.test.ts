import { connect, type Socket } from 'node:net'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SIGNATURE_HEADER, signRequest } from '@ykurilov/remontnik-core/signed-http'
import { FakeDoctor, FakePaseo, SHOP_AGENT, SHOP_SECRET, makeConfig, shopTask, signedPostRequest, startBridge } from './bridge-world.js'

// Мост слушает частную сеть, но запросы к нему может слать кто угодно в ней: заголовки подписи проверяются
// до чтения тела, а соединения ограничены — числом и сроком до заголовков (как у врача).

let doctor: FakeDoctor
let started: Awaited<ReturnType<typeof startBridge>> | undefined

beforeEach(async () => {
  doctor = new FakeDoctor(SHOP_SECRET)
  await doctor.start()
})

afterEach(async () => {
  await started?.close()
  started = undefined
  await doctor.stop()
})

async function bridgeWith(limits?: Parameters<typeof startBridge>[0]['limits']) {
  const paseo = new FakePaseo()
  paseo.states.set(SHOP_AGENT, 'idle')
  started = await startBridge({ config: makeConfig({ shop: doctor.url, blog: doctor.url }), paseo, ...(limits ? { limits } : {}) })
  return new URL(started.server.url)
}

function open(url: URL): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = connect(Number(url.port), url.hostname, () => resolve(socket))
    socket.once('error', reject)
  })
}

/** Всё, что пришло в сокет, пока его не закрыли (или до срока). */
function received(socket: Socket, timeoutMs = 3_000): Promise<{ text: string; closed: boolean }> {
  return new Promise((resolve) => {
    let text = ''
    const timer = setTimeout(() => resolve({ text, closed: false }), timeoutMs)
    socket.on('data', (chunk) => (text += chunk.toString('utf8')))
    socket.on('error', () => {})
    socket.once('close', () => {
      clearTimeout(timer)
      resolve({ text, closed: true })
    })
  })
}

/** Заголовки POST с обещанным, но не присланным телом. */
function headersWithoutBody(headers: Record<string, string>, path = '/v1/tasks', length = 4_000): string {
  const lines = [`POST ${path} HTTP/1.1`, 'Host: bridge', 'Content-Type: application/json', `Content-Length: ${length}`]
  for (const [name, value] of Object.entries(headers)) lines.push(`${name}: ${value}`)
  return `${lines.join('\r\n')}\r\n\r\n`
}

describe('заголовки подписи — до чтения тела', () => {
  it('старая, кривая или повторная подпись: 401 сразу, тело не ждём', async () => {
    const url = await bridgeWith()
    const body = JSON.stringify(shopTask())
    const stale = signRequest({ method: 'POST', target: '/v1/tasks', body, secret: SHOP_SECRET, now: Date.now() - 60 * 60_000 })
    const malformed = { ...signRequest({ method: 'POST', target: '/v1/tasks', body, secret: SHOP_SECRET }), [SIGNATURE_HEADER]: 'sha256=zz' }

    const accepted = signedPostRequest(`${url.origin}/v1/tasks`, shopTask(), SHOP_SECRET)
    expect((await fetch(`${url.origin}/v1/tasks`, accepted)).status).toBe(200)
    const replayed = accepted.headers as Record<string, string>

    for (const headers of [stale, malformed, replayed]) {
      const socket = await open(url)
      const answer = received(socket, 1_000)
      socket.write(headersWithoutBody(headers))
      const { text } = await answer
      socket.destroy()
      expect(text).toMatch(/^HTTP\/1\.1 401/)
    }
  })
})

describe('пределы соединений', () => {
  it('заголовки не пришли в срок — соединение закрыто', async () => {
    const url = await bridgeWith({ headersTimeoutMs: 300 })
    const socket = await open(url)
    const answer = received(socket, 3_000)
    socket.write('POST /v1/tasks HTTP/1.1\r\nHost: bridge\r\n')
    const startedAt = Date.now()
    const { closed } = await answer
    expect(closed).toBe(true)
    expect(Date.now() - startedAt).toBeLessThan(2_500)
  })

  it('сверх предела соединений с одного адреса — новое закрыто сразу, старые работают', async () => {
    const url = await bridgeWith({ maxConnectionsPerClient: 2 })
    const held = [await open(url), await open(url)]
    const extra = await open(url)
    const { closed } = await received(extra, 2_000)
    expect(closed).toBe(true)
    held.forEach((socket) => socket.destroy())
    const health = async () =>
      (await fetch(`${url.origin}/health?app=shop`, { headers: signRequest({ method: 'GET', target: '/health?app=shop', body: '', secret: SHOP_SECRET }) })).status
    await expect.poll(health).toBe(200)
  })
})
