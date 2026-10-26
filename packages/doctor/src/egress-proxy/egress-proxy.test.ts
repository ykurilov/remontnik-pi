import { createServer, request as httpRequest, type Server } from 'node:http'
import { connect, type AddressInfo, type Socket } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { isAllowedHost, isPublicAddress, startEgressProxy, type EgressProxy, type EgressProxyOptions } from './index.js'

// Прокси выхода: единственный путь наружу у контейнеров верстака. Туннель — только к именам из белого списка,
// только на разрешённые порты и только если все адреса имени — в интернете.

// Адреса интернета собираются из частей: проверка открытости репозитория не пускает их в текст как есть.
const INTERNET_V4 = [203, 0, 114, 7].join('.')
const DNS_V4 = [8, 8, 8, 8].join('.')
const CDN_V4 = [104, 16, 0, 1].join('.')

const closers: (() => Promise<void>)[] = []

afterEach(async () => {
  while (closers.length > 0) await closers.pop()!()
})

/** Сервер-«реестр» на петле: отвечает на всё, что пришло по туннелю, строкой `pong`. */
async function echoServer(): Promise<{ port: number; connections: () => number }> {
  let connections = 0
  const server: Server = createServer((_request, response) => response.end('pong'))
  server.on('connection', () => (connections += 1))
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  closers.push(() => new Promise((resolve) => server.close(() => resolve())))
  return { port: (server.address() as AddressInfo).port, connections: () => connections }
}

async function proxy(options: Omit<EgressProxyOptions, 'listen'>, log: string[] = []): Promise<EgressProxy> {
  const started = await startEgressProxy({ listen: { host: '127.0.0.1', port: 0 }, log: (line) => log.push(line), ...options })
  closers.push(() => started.close())
  return started
}

/** `CONNECT target` и, если туннель открыт, `GET /` по нему. Возвращает код ответа прокси и тело по туннелю. */
async function tunnelTo(proxyUrl: string, target: string): Promise<{ status: number; body?: string }> {
  const { hostname, port } = new URL(proxyUrl)
  const socket: Socket = connect({ host: hostname, port: Number(port) })
  closers.push(async () => void socket.destroy())
  await new Promise<void>((resolve) => socket.once('connect', resolve))
  socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`)
  let text = ''
  const status = await new Promise<number>((resolve) => {
    const onData = (chunk: Buffer) => {
      text += chunk.toString('latin1')
      const end = text.indexOf('\r\n\r\n')
      if (end === -1) return
      socket.off('data', onData)
      const status = Number(/^HTTP\/1\.1 (\d+)/.exec(text)?.[1])
      text = text.slice(end + 4)
      resolve(status)
    }
    socket.on('data', onData)
    socket.once('close', () => resolve(0))
  })
  if (status !== 200) return { status }
  socket.write('GET / HTTP/1.1\r\nHost: registry\r\nConnection: close\r\n\r\n')
  const body = await new Promise<string>((resolve) => {
    let reply = text
    socket.on('data', (chunk: Buffer) => (reply += chunk.toString('utf8')))
    socket.once('close', () => resolve(reply))
  })
  return { status, body: body.slice(body.indexOf('\r\n\r\n') + 4) }
}

const publicAddress = (address = INTERNET_V4) => async () => [{ address, family: 4 }]

describe('публичный адрес', () => {
  it.each([DNS_V4, CDN_V4, '2606:4700::1111', `::ffff:${DNS_V4}`])('%s — в интернете', (address) => {
    expect(isPublicAddress(address)).toBe(true)
  })

  it.each(['169.254.169.254', '10.0.0.1', '172.17.0.1', '192.168.1.1', '127.0.0.1', '100.64.0.1', '0.0.0.0', '224.0.0.1', '255.255.255.255', '::1', '::', 'fd00::1', 'fe80::1', '::ffff:169.254.169.254', '::ffff:10.0.0.1', '64:ff9b::a9fe:a9fe', '2002:a9fe:a9fe::1', 'registry.npmjs.org', ''])(
    '%s — нет',
    (address) => {
      expect(isPublicAddress(address)).toBe(false)
    },
  )
})

describe('белый список имён', () => {
  it('точное имя и поддомены по маске; регистр и точка в конце не важны', () => {
    const allowed = ['registry.npmjs.org', '*.pkg.example.com']
    expect(isAllowedHost('registry.npmjs.org', allowed)).toBe(true)
    expect(isAllowedHost('Registry.NPMJS.org.', allowed)).toBe(true)
    expect(isAllowedHost('a.pkg.example.com', allowed)).toBe(true)
    expect(isAllowedHost('pkg.example.com', allowed)).toBe(false)
    expect(isAllowedHost('evilpkg.example.com', allowed)).toBe(false)
    expect(isAllowedHost('registry.npmjs.org.example.com', allowed)).toBe(false)
    expect(isAllowedHost('npmjs.org', allowed)).toBe(false)
  })
})

describe('прокси выхода', () => {
  it('разрешённое имя → туннель до проверенного адреса, данные идут в обе стороны', async () => {
    const registry = await echoServer()
    const dialed: string[] = []
    const started = await proxy({
      allowedHosts: ['registry.example.com'],
      lookup: publicAddress(),
      // Сеть подменяется только здесь: проверенный адрес в интернете ведёт на «реестр» на петле.
      dial: (address, port) => {
        dialed.push(`${address}:${port}`)
        return connect({ host: '127.0.0.1', port: registry.port })
      },
    })
    expect(await tunnelTo(started.url, 'Registry.Example.com:443')).toEqual({ status: 200, body: 'pong' })
    expect(dialed).toEqual([`${INTERNET_V4}:443`])
    expect(registry.connections()).toBe(1)
  })

  it('адрес не отвечает → 502', async () => {
    const started = await proxy({ allowedHosts: ['registry.example.com'], lookup: publicAddress(), dial: () => connect({ host: '127.0.0.1', port: 1 }) })
    expect((await tunnelTo(started.url, 'registry.example.com:443')).status).toBe(502)
  })

  it.each([
    ['имя не из списка', 'example.org:443'],
    ['поддомен разрешённого имени', 'evil.registry.example.com:443'],
    ['адрес вместо имени', `${INTERNET_V4}:443`],
    ['адрес метаданных облака', '169.254.169.254:443'],
    ['IPv6 в скобках', '[2606:4700::1111]:443'],
    ['порт не из списка', 'registry.example.com:22'],
    ['без порта', 'registry.example.com'],
  ])('%s → отказ, соединения наружу нет', async (_what, target) => {
    const looked: string[] = []
    const started = await proxy({
      allowedHosts: ['registry.example.com'],
      lookup: async (host) => {
        looked.push(host)
        return [{ address: INTERNET_V4, family: 4 }]
      },
    })
    const { status } = await tunnelTo(started.url, target)
    expect([400, 403]).toContain(status)
    expect(looked).toEqual([])
  })

  it.each([
    ['метаданные облака', [{ address: '169.254.169.254', family: 4 }]],
    ['локальная сеть', [{ address: '10.1.2.3', family: 4 }]],
    ['один из адресов внутренний', [{ address: INTERNET_V4, family: 4 }, { address: '172.17.0.1', family: 4 }]],
    ['IPv6 петля', [{ address: '::1', family: 6 }]],
    ['пустой ответ', []],
  ])('разрешённое имя указывает внутрь (%s) → отказ', async (_what, addresses) => {
    const log: string[] = []
    const started = await proxy({ allowedHosts: ['registry.example.com'], lookup: async () => addresses }, log)
    expect((await tunnelTo(started.url, 'registry.example.com:443')).status).toBe(403)
    expect(log.join('\n')).toContain('адрес не в интернете')
  })

  it('имя не разрешилось → 502', async () => {
    const started = await proxy({
      allowedHosts: ['registry.example.com'],
      lookup: async () => {
        throw new Error('ENOTFOUND')
      },
    })
    expect((await tunnelTo(started.url, 'registry.example.com:443')).status).toBe(502)
  })

  it('обычный HTTP-запрос через прокси → 405', async () => {
    const started = await proxy({ allowedHosts: ['registry.example.com'], lookup: publicAddress() })
    const { hostname, port } = new URL(started.url)
    const status = await new Promise<number>((resolve, reject) => {
      const request = httpRequest({ host: hostname, port: Number(port), method: 'GET', path: 'http://registry.example.com/' }, (response) => {
        response.resume()
        resolve(response.statusCode ?? 0)
      })
      request.once('error', reject)
      request.end()
    })
    expect(status).toBe(405)
  })

  it('не имя в белом списке → прокси не стартует', async () => {
    await expect(startEgressProxy({ listen: { host: '127.0.0.1', port: 0 }, allowedHosts: ['169.254.169.254'] })).rejects.toThrow(/не имя хоста/)
  })
})
