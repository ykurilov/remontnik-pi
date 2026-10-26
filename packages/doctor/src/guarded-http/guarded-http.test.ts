import { request as httpRequest } from 'node:http'
import { connect, type Socket } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { createGuardedHttp, type GuardedHttp, type GuardedHttpLimits } from './index.js'

// Сервер для контейнеров случая (зеркало реестра, прокси eval): слушает на нескольких адресах сразу, а соединения
// ограничены — всего, на одного клиента и по времени до первого запроса.

const closers: (() => Promise<void>)[] = []
afterEach(async () => {
  while (closers.length > 0) await closers.pop()!()
})

function guarded(limits: Partial<GuardedHttpLimits> = {}): GuardedHttp {
  const http = createGuardedHttp((_request, response) => response.end('ok'), limits)
  closers.push(() => http.close())
  return http
}

function get(url: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    httpRequest(url, { agent: false }, (response) => {
      let body = ''
      response.setEncoding('utf8').on('data', (chunk: string) => (body += chunk))
      response.on('end', () => resolve({ status: response.statusCode ?? 0, body }))
    })
      .on('error', reject)
      .end()
  })
}

/** Открывает пустое соединение и ждёт, закроет ли его сервер. */
async function idleSocket(url: string): Promise<{ socket: Socket; closed: Promise<number> }> {
  const { hostname, port } = new URL(url)
  const socket = connect({ host: hostname, port: Number(port) })
  closers.push(async () => void socket.destroy())
  const openedAt = Date.now()
  const closed = new Promise<number>((resolve) => socket.once('close', () => resolve(Date.now() - openedAt)))
  socket.on('error', () => {})
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve)
    socket.once('error', reject)
  })
  return { socket, closed }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 100))

describe('слушатели на нескольких адресах', () => {
  it('один обработчик на каждом адресе; закрытый адрес больше не отвечает', async () => {
    const http = guarded()
    const first = await http.listen('127.0.0.1', 0)
    const second = await http.listen('127.0.0.1', 0)
    expect(await get(first.url)).toEqual({ status: 200, body: 'ok' })
    expect(await get(second.url)).toEqual({ status: 200, body: 'ok' })
    await first.close()
    await expect(get(first.url)).rejects.toThrow(/ECONNREFUSED/)
    expect((await get(second.url)).body).toBe('ok')
  })

  it('адрес вне частной сети не слушается', async () => {
    await expect(guarded().listen('0.0.0.0', 0)).rejects.toThrow(/частной сети/)
  })
})

describe('пределы соединений', () => {
  it('один клиент не занимает больше своей доли: лишние сокеты закрываются сразу', async () => {
    const http = guarded({ maxConnectionsPerClient: 2, firstRequestTimeoutMs: 5_000 })
    const { url } = await http.listen('127.0.0.1', 0)
    await idleSocket(url)
    await idleSocket(url)
    const third = await idleSocket(url)
    expect(await third.closed).toBeLessThan(1_000)
  })

  it('общий предел на все адреса', async () => {
    const http = guarded({ maxConnections: 1, maxConnectionsPerClient: 10, firstRequestTimeoutMs: 5_000 })
    const first = await http.listen('127.0.0.1', 0)
    const second = await http.listen('127.0.0.1', 0)
    await idleSocket(first.url)
    const extra = await idleSocket(second.url)
    expect(await extra.closed).toBeLessThan(1_000)
  })

  it('соединение без запроса закрывается по короткому сроку и освобождает место', async () => {
    const http = guarded({ maxConnectionsPerClient: 1, firstRequestTimeoutMs: 300 })
    const { url } = await http.listen('127.0.0.1', 0)
    const idle = await idleSocket(url)
    const waited = await idle.closed
    expect(waited).toBeGreaterThanOrEqual(250)
    expect(waited).toBeLessThan(2_500)
    await settle()
    expect((await get(url)).body).toBe('ok')
  })

  it('закрытое соединение возвращает место клиенту', async () => {
    const http = guarded({ maxConnectionsPerClient: 1, firstRequestTimeoutMs: 5_000 })
    const { url } = await http.listen('127.0.0.1', 0)
    for (let i = 0; i < 3; i += 1) {
      expect((await get(url)).body).toBe('ok')
      await settle()
    }
  })
})
