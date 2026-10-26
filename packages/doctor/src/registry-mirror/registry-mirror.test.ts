import { createServer, request as httpRequest, type Server } from 'node:http'
import { connect, type AddressInfo } from 'node:net'
import { Readable } from 'node:stream'
import { gzipSync } from 'node:zlib'
import { afterEach, describe, expect, it } from 'vitest'
import { createRegistryMirror, type RegistryMirror, type RegistryMirrorOptions } from './index.js'

// Зеркало реестра пакетов: единственный путь наружу у контейнеров верстака. Только чтение пакетов
// с одного реестра; соединение с реестром ставит врач, контейнер ни имени, ни адреса не выбирает.

const closers: (() => Promise<void>)[] = []
afterEach(async () => {
  while (closers.length > 0) await closers.pop()!()
})

const PUBLIC_URL = 'http://remontnik-gateway:7801'

interface Seen {
  path: string
  host: string | undefined
  accept: string | undefined
  cookie: string | undefined
}

/** Подставной реестр: метаданные пакетов, архив и ответы на особые пути. */
async function fakeRegistry(): Promise<{ url: string; seen: Seen[]; streamed: { bytes: number; closed: boolean } }> {
  const seen: Seen[] = []
  const streamed = { bytes: 0, closed: false }
  let url = ''
  const server: Server = createServer((request, response) => {
    seen.push({ path: request.url ?? '', host: request.headers.host, accept: request.headers.accept, cookie: request.headers.cookie })
    const path = request.url ?? ''
    if (path === '/is-number' || path === '/@scope%2fpkg' || path === '/@scope/pkg') {
      const name = path === '/is-number' ? 'is-number' : '@scope/pkg'
      const file = path === '/is-number' ? 'is-number-7.0.0.tgz' : 'pkg-1.0.0.tgz'
      response.writeHead(200, { 'content-type': 'application/vnd.npm.install-v1+json', etag: '"v1"' })
      response.end(
        JSON.stringify({
          name,
          versions: {
            '1.0.0': { dist: { tarball: `${url}/${name}/-/${file}`, integrity: 'sha512-test' } },
            '0.1.0': { dist: { tarball: 'https://elsewhere.example.com/x.tgz' } },
          },
        }),
      )
      return
    }
    if (path === '/is-number/-/is-number-7.0.0.tgz') {
      response.writeHead(200, { 'content-type': 'application/octet-stream' })
      response.end(Buffer.alloc(1000, 7))
      return
    }
    if (path === '/huge') {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ name: 'huge', pad: 'x'.repeat(5000) }))
      return
    }
    if (path === '/huge/-/huge-1.0.0.tgz') {
      response.writeHead(200, { 'content-type': 'application/octet-stream' })
      response.end(Buffer.alloc(5000, 1))
      return
    }
    if (path === '/moved') {
      response.writeHead(302, { location: 'http://elsewhere.example.com/' })
      response.end()
      return
    }
    if (path === '/slow') return
    if (path === '/big/-/big-1.0.0.tgz') {
      // 200 МБ кусками, с учётом drain: реестр шлёт ровно столько, сколько у него забирают.
      response.writeHead(200, { 'content-type': 'application/octet-stream' })
      const chunk = Buffer.alloc(64 * 1024, 3)
      let left = 3200
      response.once('close', () => (streamed.closed = true))
      Readable.from(
        (function* () {
          while (left-- > 0) {
            streamed.bytes += chunk.length
            yield chunk
          }
        })(),
      ).pipe(response)
      return
    }
    if (path === '/bomb/-/bomb-1.0.0.tgz' || path === '/bomb') {
      // Сжатая бомба: 64 КБ на проводе, 64 МБ после распаковки.
      response.writeHead(200, { 'content-type': path === '/bomb' ? 'application/json' : 'application/octet-stream', 'content-encoding': 'gzip' })
      response.end(gzipSync(Buffer.alloc(64 * 1024 * 1024, path === '/bomb' ? 32 : 0)))
      return
    }
    if (path === '/split') {
      // Метаданные мелкими кусками: адрес реестра разрезан между кусками.
      response.writeHead(200, { 'content-type': 'application/json' })
      const body = JSON.stringify({ name: 'split', versions: Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`1.0.${i}`, { dist: { tarball: `${url}/split/-/split-1.0.${i}.tgz` } }])) })
      Readable.from(body.match(/[\s\S]{1,7}/g)!.map((part) => Buffer.from(part))).pipe(response)
      return
    }
    response.writeHead(404, { 'content-type': 'application/json' })
    response.end('{"error":"not found"}')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  closers.push(
    () =>
      new Promise((resolve) => {
        server.close(() => resolve())
        server.closeAllConnections()
      }),
  )
  return { url, seen, streamed }
}

async function mirror(upstream: string, options: Partial<RegistryMirrorOptions> = {}): Promise<{ mirror: RegistryMirror; url: string }> {
  const created = createRegistryMirror({ upstream, publicUrl: PUBLIC_URL, ...options })
  closers.push(() => created.close())
  const { url } = await created.listen('127.0.0.1', 0)
  return { mirror: created, url }
}

/** Сырой запрос: путь и заголовки как есть, без нормализации клиента. */
function raw(url: string, path: string, options: { method?: string; headers?: Record<string, string> } = {}): Promise<{ status: number; body: Buffer; headers: Record<string, unknown> }> {
  const { hostname, port } = new URL(url)
  return new Promise((resolve, reject) => {
    const request = httpRequest({ host: hostname, port: Number(port), path, method: options.method ?? 'GET', headers: options.headers ?? {}, agent: false }, (response) => {
      const chunks: Buffer[] = []
      response.on('data', (chunk: Buffer) => chunks.push(chunk))
      response.on('end', () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks), headers: response.headers }))
      response.on('error', reject)
    })
    // Ответ на `CONNECT` приходит событием `connect`, а не обычным ответом.
    request.on('connect', (response, socket) => {
      socket.destroy()
      resolve({ status: response.statusCode ?? 0, body: Buffer.alloc(0), headers: response.headers })
    })
    request.on('error', reject)
    request.end()
  })
}

/** Запрос без ожидания успеха: сколько байт пришло и дошёл ли ответ до конца. */
function rawLoose(url: string, path: string): Promise<{ status: number; bytes: number; complete: boolean }> {
  const { hostname, port } = new URL(url)
  return new Promise((resolve) => {
    let status = 0
    let bytes = 0
    const request = httpRequest({ host: hostname, port: Number(port), path, agent: false }, (response) => {
      status = response.statusCode ?? 0
      response.on('data', (chunk: Buffer) => (bytes += chunk.length))
      response.on('end', () => resolve({ status, bytes, complete: response.complete }))
      response.on('error', () => resolve({ status, bytes, complete: false }))
    })
    request.on('error', () => resolve({ status, bytes, complete: false }))
    request.end()
  })
}

/** Клиент, который отправил запрос и не читает ответ. */
async function stalledClient(url: string, path: string): Promise<{ destroy(): void; resume(): void; readonly closed: boolean }> {
  const { hostname, port } = new URL(url)
  const socket = connect({ host: hostname, port: Number(port) })
  let closed = false
  socket.on('close', () => (closed = true))
  socket.on('error', () => {})
  await new Promise<void>((resolve) => socket.once('connect', () => resolve()))
  socket.write(`GET ${path} HTTP/1.1\r\nHost: x\r\n\r\n`)
  socket.pause()
  return {
    destroy: () => socket.destroy(),
    resume: () => socket.resume(),
    get closed() {
      return closed
    },
  }
}

async function waitFor(condition: () => boolean, ms: number): Promise<void> {
  const deadline = Date.now() + ms
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('условие не наступило')
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

describe('зеркало реестра: что пропускает', () => {
  it('метаданные: адреса архивов реестра переписаны на зеркало, чужие — нет', async () => {
    const registry = await fakeRegistry()
    const { url } = await mirror(registry.url)
    const answer = await raw(url, '/is-number', { headers: { accept: 'application/vnd.npm.install-v1+json' } })
    expect(answer.status).toBe(200)
    const body = JSON.parse(answer.body.toString('utf8'))
    expect(body.versions['1.0.0'].dist).toEqual({ tarball: `${PUBLIC_URL}/is-number/-/is-number-7.0.0.tgz`, integrity: 'sha512-test' })
    expect(body.versions['0.1.0'].dist.tarball).toBe('https://elsewhere.example.com/x.tgz')
    expect(registry.seen[0]).toMatchObject({ path: '/is-number', accept: 'application/vnd.npm.install-v1+json' })
  })

  it('пакет с областью — в обоих написаниях', async () => {
    const registry = await fakeRegistry()
    const { url } = await mirror(registry.url)
    for (const path of ['/@scope%2fpkg', '/@scope%2Fpkg', '/@scope/pkg']) {
      const answer = await raw(url, path)
      expect(answer.status).toBe(200)
      expect(JSON.parse(answer.body.toString('utf8')).versions['1.0.0'].dist.tarball).toBe(`${PUBLIC_URL}/@scope/pkg/-/pkg-1.0.0.tgz`)
    }
  })

  it('архив пакета отдаётся как есть', async () => {
    const registry = await fakeRegistry()
    const { url } = await mirror(registry.url)
    const answer = await raw(url, '/is-number/-/is-number-7.0.0.tgz')
    expect(answer.status).toBe(200)
    expect(answer.body).toEqual(Buffer.alloc(1000, 7))
  })

  it('нет пакета → 404 реестра', async () => {
    const registry = await fakeRegistry()
    const { url } = await mirror(registry.url)
    expect((await raw(url, '/no-such-package')).status).toBe(404)
  })
})

describe('зеркало реестра: чужой адрес недостижим', () => {
  it('заголовок Host не меняет реестр, куки и прочие заголовки не уходят', async () => {
    const registry = await fakeRegistry()
    const { url } = await mirror(registry.url)
    const answer = await raw(url, '/is-number', { headers: { host: 'evil.example.com', cookie: 'a=b', 'x-forwarded-host': 'evil.example.com' } })
    expect(answer.status).toBe(200)
    expect(registry.seen).toHaveLength(1)
    expect(registry.seen[0]!.host).toBe(new URL(registry.url).host)
    expect(registry.seen[0]!.cookie).toBeUndefined()
  })

  it.each([
    ['//evil.example.com/x'],
    ['/http://evil.example.com/'],
    ['http://evil.example.com/is-number'],
    ['/%2e%2e/x'],
    ['/../x'],
    ['/is-number/../../x'],
    ['/-/v1/search?text=x'],
    ['/-/npm/v1/security/audits'],
    ['/is-number/latest'],
    ['/is-number/-/../../x.tgz'],
    ['/is-number/-/x.tar'],
    ['/@scope'],
    ['/@scope/pkg/extra'],
    ['/is%20number'],
    ['/'],
  ])('путь %s → 400, в реестр не уходит', async (path) => {
    const registry = await fakeRegistry()
    const { url } = await mirror(registry.url)
    expect((await raw(url, path)).status).toBe(400)
    expect(registry.seen).toEqual([])
  })

  it('строка запроса в реестр не уходит', async () => {
    const registry = await fakeRegistry()
    const { url } = await mirror(registry.url)
    expect((await raw(url, '/is-number?write=true')).status).toBe(200)
    expect(registry.seen[0]!.path).toBe('/is-number')
  })

  it.each(['POST', 'PUT', 'DELETE', 'CONNECT', 'OPTIONS'])('%s → 405', async (method) => {
    const registry = await fakeRegistry()
    const { url } = await mirror(registry.url)
    expect((await raw(url, method === 'CONNECT' ? 'evil.example.com:443' : '/is-number', { method })).status).toBe(405)
    expect(registry.seen).toEqual([])
  })

  it('перенаправление реестра не исполняется', async () => {
    const registry = await fakeRegistry()
    const { url } = await mirror(registry.url)
    expect((await raw(url, '/moved')).status).toBe(502)
  })
})

describe('зеркало реестра: пределы', () => {
  it('метаданные больше предела → 502', async () => {
    const registry = await fakeRegistry()
    const { url } = await mirror(registry.url, { maxMetadataBytes: 1000 })
    expect((await raw(url, '/huge')).status).toBe(502)
  })

  it('архив больше предела → 502', async () => {
    const registry = await fakeRegistry()
    const { url } = await mirror(registry.url, { maxTarballBytes: 1000 })
    expect((await raw(url, '/huge/-/huge-1.0.0.tgz')).status).toBe(502)
  })

  it('реестр молчит → 504 по сроку', async () => {
    const registry = await fakeRegistry()
    const { url } = await mirror(registry.url, { upstreamTimeoutMs: 300 })
    expect((await raw(url, '/slow')).status).toBe(504)
  })

  it('метаданные переписываются потоком: адрес, разрезанный между кусками, тоже', async () => {
    const registry = await fakeRegistry()
    const { url } = await mirror(registry.url)
    const answer = await raw(url, '/split')
    expect(answer.status).toBe(200)
    const versions = Object.values(JSON.parse(answer.body.toString('utf8')).versions) as { dist: { tarball: string } }[]
    expect(versions).toHaveLength(50)
    for (const version of versions) expect(version.dist.tarball).toMatch(new RegExp(`^${PUBLIC_URL}/split/-/split-1\\.0\\.\\d+\\.tgz$`))
  })

  it.each([
    ['архив', '/bomb/-/bomb-1.0.0.tgz', { maxTarballBytes: 1024 * 1024 }],
    ['метаданные', '/bomb', { maxMetadataBytes: 1024 * 1024 }],
  ])('сжатая бомба (%s): после распаковки не больше предела, ответ оборван', async (_kind, path, limits) => {
    const registry = await fakeRegistry()
    const { url } = await mirror(registry.url, limits)
    const answer = await rawLoose(url, path)
    expect(answer.bytes).toBeLessThanOrEqual(1024 * 1024)
    expect(answer.complete && answer.status === 200).toBe(false)
  })

  it('медленный клиент: зеркало не забирает у реестра больше, чем клиент прочёл', async () => {
    const registry = await fakeRegistry()
    const { url } = await mirror(registry.url)
    const client = await stalledClient(url, '/big/-/big-1.0.0.tgz')
    await new Promise((resolve) => setTimeout(resolve, 1500))
    // Клиент не читает: в пути остаются только буферы сокетов, а не 200 МБ в памяти врача.
    expect(registry.streamed.bytes).toBeLessThan(32 * 1024 * 1024)
    client.destroy()
  })

  it('клиент не читает дольше срока записи → соединение рвётся, запрос к реестру отменяется', async () => {
    const registry = await fakeRegistry()
    const { url } = await mirror(registry.url, { writeTimeoutMs: 300 })
    const client = await stalledClient(url, '/big/-/big-1.0.0.tgz')
    await waitFor(() => registry.streamed.closed, 5000)
    // Клиент дочитывает то, что успело уйти, и видит обрыв: зеркало закрыло соединение.
    client.resume()
    await waitFor(() => client.closed, 5000)
    expect(registry.streamed.bytes).toBeLessThan(32 * 1024 * 1024)
  })

  it('одновременных ответов не больше предела: лишний ждёт, не дождался места → 503', async () => {
    const registry = await fakeRegistry()
    const { url } = await mirror(registry.url, { maxConcurrentResponses: 1, queueTimeoutMs: 300 })
    const first = await stalledClient(url, '/big/-/big-1.0.0.tgz')
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect((await raw(url, '/is-number')).status).toBe(503)
    first.destroy()
    await waitFor(() => registry.streamed.closed, 5000)
    expect((await raw(url, '/is-number')).status).toBe(200)
  })

  it('клиент ушёл из очереди → место не потеряно', async () => {
    const registry = await fakeRegistry()
    const { url } = await mirror(registry.url, { maxConcurrentResponses: 1, queueTimeoutMs: 3000 })
    const first = await stalledClient(url, '/big/-/big-1.0.0.tgz')
    await new Promise((resolve) => setTimeout(resolve, 200))
    // Второй ждёт места и уходит, не дождавшись.
    const queued = await stalledClient(url, '/is-number')
    await new Promise((resolve) => setTimeout(resolve, 200))
    queued.destroy()
    await new Promise((resolve) => setTimeout(resolve, 100))
    first.destroy()
    await waitFor(() => registry.streamed.closed, 5000)
    // Место первого не ушло ушедшему: следующий получает ответ сразу, а не 503 после очереди.
    const started = Date.now()
    expect((await raw(url, '/is-number')).status).toBe(200)
    expect(Date.now() - started).toBeLessThan(1000)
    expect((await raw(url, '/is-number')).status).toBe(200)
  })

  it('реестр по умолчанию — registry.npmjs.org по HTTPS; иной адрес реестра — только явно', () => {
    expect(createRegistryMirror({ publicUrl: PUBLIC_URL }).upstream).toBe('https://registry.npmjs.org')
    expect(() => createRegistryMirror({ publicUrl: 'http://user:pass@remontnik-gateway:7801' })).toThrow(/publicUrl/)
  })
})
