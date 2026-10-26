import { createServer, request, type Server } from 'node:http'
import { connect, createServer as createNetServer, type AddressInfo, type Socket } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { isAllowedTarget, startEgressProxy, type EgressTarget } from './index.js'

// Прокси выхода: пускает только то, что разрешает замок, рвёт уже открытое при запирании и ведёт дальше
// через прокси профиля.

const cleanups: (() => unknown)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function listening<T extends Server | ReturnType<typeof createNetServer>>(server: T): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  cleanups.push(() => server.close())
  return (server.address() as AddressInfo).port
}

/** Сайт: отвечает путём запроса; TCP-эхо — для туннелей. */
async function site(): Promise<number> {
  return listening(createServer((incoming, response) => response.end(`site ${incoming.url}`)))
}
async function echo(): Promise<number> {
  return listening(createNetServer((socket) => socket.pipe(socket)))
}

async function proxy(allows: (target: EgressTarget) => boolean, upstream?: { server: string; username?: string; password?: string }) {
  const refused: string[] = []
  const egress = await startEgressProxy({ allows, onRefused: (target) => refused.push(`${target.host}:${target.port}`), ...(upstream ? { upstream } : {}) })
  cleanups.push(() => egress.close())
  return { egress, refused, port: Number(new URL(egress.url).port) }
}

function viaProxy(proxyPort: number, url: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const outgoing = request({ host: '127.0.0.1', port: proxyPort, path: url, method: 'GET' }, (answer) => {
      let body = ''
      answer.on('data', (chunk) => (body += chunk))
      answer.on('end', () => resolve({ status: answer.statusCode ?? 0, body }))
    })
    outgoing.on('error', reject)
    outgoing.end()
  })
}

/** CONNECT через прокси: ответ прокси и сокет туннеля. */
function tunnel(proxyPort: number, authority: string): Promise<{ status: string; socket: Socket }> {
  return new Promise((resolve) => {
    const socket = connect(proxyPort, '127.0.0.1', () => socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`))
    socket.once('data', (chunk) => resolve({ status: chunk.toString('latin1').split('\r\n')[0]!, socket }))
    socket.on('error', () => {})
    cleanups.push(() => socket.destroy())
  })
}

const roundTrip = (socket: Socket, text: string) =>
  new Promise<string>((resolve) => {
    socket.once('data', (chunk) => resolve(chunk.toString()))
    socket.write(text)
  })

describe('прокси выхода', () => {
  it('http:// и туннель на разрешённый адрес проходят, на запрещённый — 403 и onRefused', async () => {
    const allowed = await site()
    const other = await site()
    const { port, refused } = await proxy((target) => target.port === allowed)

    expect(await viaProxy(port, `http://127.0.0.1:${allowed}/ok`)).toEqual({ status: 200, body: 'site /ok' })
    expect((await viaProxy(port, `http://127.0.0.1:${other}/leak`)).status).toBe(403)
    expect((await tunnel(port, `127.0.0.1:${other}`)).status).toBe('HTTP/1.1 403 Forbidden')
    expect(refused).toEqual([`127.0.0.1:${other}`, `127.0.0.1:${other}`])
  })

  it('dropRefused рвёт туннели, которые замок больше не разрешает, и оставляет разрешённые', async () => {
    const kept = await echo()
    const dropped = await echo()
    let locked = false
    const { egress, port } = await proxy((target) => !locked || target.port === kept)
    const keptTunnel = await tunnel(port, `127.0.0.1:${kept}`)
    const droppedTunnel = await tunnel(port, `127.0.0.1:${dropped}`)
    expect([keptTunnel.status, droppedTunnel.status]).toEqual(['HTTP/1.1 200 Connection Established', 'HTTP/1.1 200 Connection Established'])

    locked = true
    egress.dropRefused()
    await new Promise((resolve) => droppedTunnel.socket.once('close', resolve))
    expect(await roundTrip(keptTunnel.socket, 'жив')).toBe('жив')
  })

  it('идёт дальше через http-прокси профиля: CONNECT с Proxy-Authorization, http:// — полным адресом', async () => {
    const target = await site()
    const seen: string[] = []
    const upstream = createServer((incoming, response) => {
      seen.push(`${incoming.method} ${incoming.url} ${incoming.headers['proxy-authorization']}`)
      const url = new URL(incoming.url!)
      const forward = request({ host: url.hostname, port: url.port, path: url.pathname }, (answer) => answer.pipe(response))
      forward.end()
    })
    upstream.on('connect', (incoming, client: Socket) => {
      seen.push(`CONNECT ${incoming.url} ${incoming.headers['proxy-authorization']}`)
      const [host, port] = incoming.url!.split(':')
      const remote = connect(Number(port), host, () => {
        client.write('HTTP/1.1 200 OK\r\n\r\n')
        remote.pipe(client)
        client.pipe(remote)
      })
    })
    const upstreamPort = await listening(upstream)
    const tunnelTarget = await echo()
    const { port } = await proxy(() => true, { server: `http://127.0.0.1:${upstreamPort}`, username: 'u', password: 'p' })

    expect(await viaProxy(port, `http://127.0.0.1:${target}/via`)).toEqual({ status: 200, body: 'site /via' })
    const opened = await tunnel(port, `127.0.0.1:${tunnelTarget}`)
    expect(opened.status).toBe('HTTP/1.1 200 Connection Established')
    expect(await roundTrip(opened.socket, 'эхо')).toBe('эхо')
    const auth = `Basic ${Buffer.from('u:p').toString('base64')}`
    expect(seen).toEqual([`GET http://127.0.0.1:${target}/via ${auth}`, `CONNECT 127.0.0.1:${tunnelTarget} ${auth}`])
  })

  it('идёт дальше через socks5 прокси профиля: вход по имени и паролю, адрес — именем хоста', async () => {
    const target = await site()
    const seen: string[] = []
    const socks = createNetServer((client) => {
      client.once('data', () => {
        client.write(Buffer.from([5, 2]))
        client.once('data', (auth) => {
          const user = auth.subarray(2, 2 + auth[1]!).toString()
          const password = auth.subarray(3 + auth[1]!, 3 + auth[1]! + auth[2 + auth[1]!]!).toString()
          client.write(Buffer.from([1, 0]))
          client.once('data', (ask) => {
            const host = ask.subarray(5, 5 + ask[4]!).toString()
            const port = ask.readUInt16BE(5 + ask[4]!)
            seen.push(`${user}:${password} ${host}:${port}`)
            const remote = connect(port, host, () => {
              client.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0]))
              remote.pipe(client)
              client.pipe(remote)
            })
          })
        })
      })
    })
    const socksPort = await listening(socks)
    const { port } = await proxy(() => true, { server: `socks5://127.0.0.1:${socksPort}`, username: 'u', password: 'p' })
    expect(await viaProxy(port, `http://127.0.0.1:${target}/socks`)).toEqual({ status: 200, body: 'site /socks' })
    expect(seen).toEqual([`u:p 127.0.0.1:${target}`])
  })

  it('isAllowedTarget: http:// — точный origin, туннель — хост и порт, порт по умолчанию по схеме', () => {
    const allowed = ['https://shop.example.test', 'http://127.0.0.1:8080']
    expect(isAllowedTarget({ host: 'shop.example.test', port: 443 }, allowed)).toBe(true)
    expect(isAllowedTarget({ host: 'shop.example.test', port: 80 }, allowed)).toBe(false)
    expect(isAllowedTarget({ host: '127.0.0.1', port: 8080, origin: 'http://127.0.0.1:8080' }, allowed)).toBe(true)
    expect(isAllowedTarget({ host: 'shop.example.test', port: 443, origin: 'http://shop.example.test:443' }, allowed)).toBe(false)
  })
})
