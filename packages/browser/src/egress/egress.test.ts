import { createServer, request, type Server } from 'node:http'
import { connect, createServer as createNetServer, type AddressInfo, type Socket } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { isAllowedTarget, isInternalAddress, startEgressProxy, type EgressOptions } from './index.js'

// Прокси выхода: пускает только со своим паролем и только то, что разрешает замок; внутренние адреса закрыты
// всегда, кроме разрешённых сайтов; рвёт уже открытое при запирании и ведёт дальше через прокси профиля.

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

type ProxySettings = Partial<Omit<EgressOptions, 'onRefused'>>

async function proxy(settings: ProxySettings = {}) {
  const refused: string[] = []
  const egress = await startEgressProxy({
    allows: () => true,
    exempt: () => false,
    ...settings,
    onRefused: (target, reason) => refused.push(`${reason} ${target.host}:${target.port}`),
  })
  cleanups.push(() => egress.close())
  return { egress, refused, port: Number(new URL(egress.url).port), auth: `Basic ${Buffer.from(`${egress.username}:${egress.password}`).toString('base64')}` }
}
type Proxy = Awaited<ReturnType<typeof proxy>>

function viaProxy(via: Proxy, url: string, auth: string | null = via.auth): Promise<{ status: number; body: string; challenge?: string }> {
  return new Promise((resolve, reject) => {
    const outgoing = request({ host: '127.0.0.1', port: via.port, path: url, method: 'GET', headers: auth ? { 'proxy-authorization': auth } : {} }, (answer) => {
      let body = ''
      answer.on('data', (chunk) => (body += chunk))
      answer.on('end', () => {
        const challenge = answer.headers['proxy-authenticate']
        resolve({ status: answer.statusCode ?? 0, body, ...(challenge ? { challenge } : {}) })
      })
    })
    outgoing.on('error', reject)
    outgoing.end()
  })
}

/** CONNECT через прокси: ответ прокси и сокет туннеля. */
function tunnel(via: Proxy, authority: string, auth: string | null = via.auth): Promise<{ status: string; reply: string; socket: Socket }> {
  return new Promise((resolve) => {
    const socket = connect(via.port, '127.0.0.1', () =>
      socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n${auth ? `Proxy-Authorization: ${auth}\r\n` : ''}\r\n`),
    )
    socket.once('data', (chunk) => resolve({ status: chunk.toString('latin1').split('\r\n')[0]!, reply: chunk.toString('latin1'), socket }))
    socket.on('error', () => {})
    cleanups.push(() => socket.destroy())
  })
}

const roundTrip = (socket: Socket, text: string) =>
  new Promise<string>((resolve) => {
    socket.once('data', (chunk) => resolve(chunk.toString()))
    socket.write(text)
  })

/** socks5 с входом по имени и паролю: записывает, какой адрес просили (тип адреса и сам адрес). */
async function socksServer(seen: string[]) {
  return listening(
    createNetServer((client) => {
      client.on('error', () => {})
      client.once('data', () => {
        client.write(Buffer.from([5, 2]))
        client.once('data', (auth) => {
          const user = auth.subarray(2, 2 + auth[1]!).toString()
          const password = auth.subarray(3 + auth[1]!, 3 + auth[1]! + auth[2 + auth[1]!]!).toString()
          client.write(Buffer.from([1, 0]))
          client.once('data', (ask) => {
            const type = ask[3]!
            const [host, end] =
              type === 1 ? [[...ask.subarray(4, 8)].join('.'), 8] : type === 4 ? [ask.subarray(4, 20).toString('hex'), 20] : [ask.subarray(5, 5 + ask[4]!).toString(), 5 + ask[4]!]
            const port = ask.readUInt16BE(end)
            seen.push(`${user}:${password} atyp=${type} ${host}:${port}`)
            const remote = connect(port, type === 1 ? host : '127.0.0.1', () => {
              client.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0]))
              remote.pipe(client)
              client.pipe(remote)
            })
          })
        })
      })
    }),
  )
}

describe('прокси выхода', () => {
  it('http:// и туннель на разрешённый адрес проходят, на запрещённый — 403 и onRefused', async () => {
    const allowed = await site()
    const other = await site()
    const via = await proxy({ allows: (target) => target.port === allowed, reachableInternal: [`127.0.0.1:${allowed}`, `127.0.0.1:${other}`] })

    expect(await viaProxy(via, `http://127.0.0.1:${allowed}/ok`)).toEqual({ status: 200, body: 'site /ok' })
    expect((await viaProxy(via, `http://127.0.0.1:${other}/leak`)).status).toBe(403)
    expect((await tunnel(via, `127.0.0.1:${other}`)).status).toBe('HTTP/1.1 403 Forbidden')
    expect(via.refused).toEqual([`locked 127.0.0.1:${other}`, `locked 127.0.0.1:${other}`])
  })

  it('без пароля прокси или с чужим — 407 с запросом входа, и для http://, и для CONNECT', async () => {
    const target = await site()
    const via = await proxy({ exempt: () => true })
    const wrong = `Basic ${Buffer.from('user:guess').toString('base64')}`
    for (const auth of [null, wrong]) {
      expect(await viaProxy(via, `http://127.0.0.1:${target}/`, auth)).toEqual({ status: 407, body: '', challenge: 'Basic realm="remontnik"' })
      const refused = await tunnel(via, `127.0.0.1:${target}`, auth)
      expect(refused.status).toBe('HTTP/1.1 407 Proxy Authentication Required')
      expect(refused.reply).toContain('Proxy-Authenticate: Basic realm="remontnik"')
    }
    expect((await viaProxy(via, `http://127.0.0.1:${target}/ok`)).status).toBe(200)
  })

  it('внутренние адреса закрыты и без пароля на странице: петля, частные сети, link-local, CGNAT, IPv4 внутри IPv6', async () => {
    const allowed = await site()
    const other = await site()
    const via = await proxy({ exempt: (target) => target.host === '127.0.0.1' && target.port === allowed })

    expect((await viaProxy(via, `http://127.0.0.1:${allowed}/ok`)).status).toBe(200)
    expect((await viaProxy(via, `http://127.0.0.1:${other}/doctor`)).status).toBe(403)
    const internal = ['10.0.0.1:443', '169.254.169.254:80', '[::1]:' + other, '[::ffff:127.0.0.1]:' + other, '[::ffff:a9fe:a9fe]:80', '[fd00::1]:443', '100.64.0.1:443', '[64:ff9b::a00:1]:443', '0.0.0.0:' + other]
    for (const authority of internal) expect([authority, (await tunnel(via, authority)).status]).toEqual([authority, 'HTTP/1.1 403 Forbidden'])
    expect(via.refused.every((line) => line.startsWith('internal '))).toBe(true)
    expect(via.refused).toHaveLength(internal.length + 1)
  })

  it('имя проверяется после разрешения, соединение — на проверенный адрес: переразрешение (DNS rebinding) не помогает', async () => {
    const target = await site()
    const asked: string[] = []
    let rebindCalls = 0
    const via = await proxy({
      reachableInternal: [`127.0.0.1:${target}`],
      lookup: async (host) => {
        asked.push(host)
        if (host === 'inside.test') return ['10.1.2.3']
        if (host === 'mixed.test') return ['10.9.9.9', '127.0.0.1']
        // Первый ответ проверен; второй разрешил бы в чужую внутреннюю сеть.
        rebindCalls += 1
        return rebindCalls === 1 ? ['127.0.0.1'] : ['10.255.255.1']
      },
    })
    expect((await viaProxy(via, `http://inside.test:${target}/`)).status).toBe(403)
    expect((await tunnel(via, `inside.test:${target}`)).status).toBe('HTTP/1.1 403 Forbidden')
    expect(await viaProxy(via, `http://rebind.test:${target}/x`)).toEqual({ status: 200, body: 'site /x' })
    expect(await viaProxy(via, `http://mixed.test:${target}/y`)).toEqual({ status: 200, body: 'site /y' })
    expect(rebindCalls).toBe(1)
    expect(asked).toEqual(['inside.test', 'inside.test', 'rebind.test', 'mixed.test'])
  })

  it('порт самого прокси закрыт, даже если адрес разрешён', async () => {
    const via = await proxy({ exempt: () => true })
    expect((await tunnel(via, `127.0.0.1:${via.port}`)).status).toBe('HTTP/1.1 403 Forbidden')
    expect((await tunnel(via, `localhost:${via.port}`)).status).toBe('HTTP/1.1 403 Forbidden')
    expect((await viaProxy(via, `http://127.0.0.1:${via.port}/`)).status).toBe(403)
  })

  it('dropRefused рвёт туннели, которые замок больше не разрешает, и оставляет разрешённые', async () => {
    const kept = await echo()
    const dropped = await echo()
    let locked = false
    const via = await proxy({ allows: (target) => !locked || target.port === kept, reachableInternal: [`127.0.0.1:${kept}`, `127.0.0.1:${dropped}`] })
    const keptTunnel = await tunnel(via, `127.0.0.1:${kept}`)
    const droppedTunnel = await tunnel(via, `127.0.0.1:${dropped}`)
    expect([keptTunnel.status, droppedTunnel.status]).toEqual(['HTTP/1.1 200 Connection Established', 'HTTP/1.1 200 Connection Established'])

    locked = true
    via.egress.dropRefused()
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
    const via = await proxy({
      upstream: { server: `http://127.0.0.1:${upstreamPort}`, username: 'u', password: 'p' },
      reachableInternal: [`127.0.0.1:${target}`, `127.0.0.1:${tunnelTarget}`],
    })

    expect(await viaProxy(via, `http://127.0.0.1:${target}/via`)).toEqual({ status: 200, body: 'site /via' })
    const opened = await tunnel(via, `127.0.0.1:${tunnelTarget}`)
    expect(opened.status).toBe('HTTP/1.1 200 Connection Established')
    expect(await roundTrip(opened.socket, 'эхо')).toBe('эхо')
    const auth = `Basic ${Buffer.from('u:p').toString('base64')}`
    expect(seen).toEqual([`GET http://127.0.0.1:${target}/via ${auth}`, `CONNECT 127.0.0.1:${tunnelTarget} ${auth}`])
  })

  it('идёт дальше через socks5 прокси профиля: вход по имени и паролю, IP-адрес — адресом (ATYP 1), а не именем', async () => {
    const target = await site()
    const seen: string[] = []
    const socksPort = await socksServer(seen)
    const via = await proxy({ upstream: { server: `socks5://127.0.0.1:${socksPort}`, username: 'u', password: 'p' }, reachableInternal: [`127.0.0.1:${target}`] })
    expect(await viaProxy(via, `http://127.0.0.1:${target}/socks`)).toEqual({ status: 200, body: 'site /socks' })
    expect(seen).toEqual([`u:p atyp=1 127.0.0.1:${target}`])
  })

  it('прокси профиля молчит — CONNECT получает 502 по сроку; клиент ушёл — неготовое соединение рвётся сразу', async () => {
    let opened = 0
    let closed = 0
    const silentPort = await listening(
      createNetServer((socket) => {
        opened += 1
        // Читает и молчит: без чтения сокет не заметил бы, что его закрыли.
        socket.resume()
        socket.on('close', () => (closed += 1))
        socket.on('error', () => {})
      }),
    )
    const quick = await proxy({ exempt: () => true, upstream: { server: `socks5://127.0.0.1:${silentPort}` }, connectTimeoutMs: 300 })
    const started = Date.now()
    expect((await tunnel(quick, 'site.example.test:443')).status).toBe('HTTP/1.1 502 Bad Gateway')
    expect(Date.now() - started).toBeLessThan(3_000)
    await expect.poll(() => closed).toBe(1)

    const slow = await proxy({ exempt: () => true, upstream: { server: `socks5://127.0.0.1:${silentPort}` }, connectTimeoutMs: 60_000 })
    const socket = connect(slow.port, '127.0.0.1', () => socket.write(`CONNECT site.example.test:443 HTTP/1.1\r\nProxy-Authorization: ${slow.auth}\r\n\r\n`))
    socket.on('error', () => {})
    await expect.poll(() => opened).toBe(2)
    socket.destroy()
    await expect.poll(() => closed, { timeout: 2_000 }).toBe(2)
  })

  it('isInternalAddress: внутренние диапазоны IPv4 и IPv6, в том числе IPv4 внутри IPv6; внешние — нет', () => {
    for (const ip of ['127.0.0.1', '10.1.1.1', '172.31.0.1', '192.168.1.1', '169.254.169.254', '100.127.0.1', '0.0.0.0', '224.0.0.251', '255.255.255.255', '::1', '::', 'fe80::1', 'fd00::1', 'fd00:ec2::254', '::ffff:10.0.0.1', '::ffff:7f00:1', '::127.0.0.1', '64:ff9b::7f00:1', '2002:7f00:1::', 'ff02::fb']) {
      expect([ip, isInternalAddress(ip)]).toEqual([ip, true])
    }
    // Сразу за границами частных диапазонов — уже внешние адреса; собраны из частей, это не адреса серверов.
    const justOutside = [[172, 32, 0, 1], [100, 128, 0, 1]].map((parts) => parts.join('.'))
    for (const ip of ['192.0.2.1', '198.51.100.7', '203.0.113.9', ...justOutside, '2606:4700::1111', '::ffff:203.0.113.9', '64:ff9b::cb00:7109']) {
      expect([ip, isInternalAddress(ip)]).toEqual([ip, false])
    }
  })

  it('isAllowedTarget: http:// — точный origin, туннель — хост и порт, порт по умолчанию по схеме', () => {
    const allowed = ['https://shop.example.test', 'http://127.0.0.1:8080']
    expect(isAllowedTarget({ host: 'shop.example.test', port: 443 }, allowed)).toBe(true)
    expect(isAllowedTarget({ host: 'shop.example.test', port: 80 }, allowed)).toBe(false)
    expect(isAllowedTarget({ host: '127.0.0.1', port: 8080, origin: 'http://127.0.0.1:8080' }, allowed)).toBe(true)
    expect(isAllowedTarget({ host: 'shop.example.test', port: 443, origin: 'http://shop.example.test:443' }, allowed)).toBe(false)
  })
})
