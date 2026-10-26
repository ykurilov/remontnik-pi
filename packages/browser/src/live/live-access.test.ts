import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import { createBrowserHttpServer } from '../service/index.js'
import { createOutputFilter } from '../vault/index.js'
import { createControlLock } from './control.js'
import { type LiveScreen, parseLiveListen, startLiveScreen } from './server.js'
import type { LiveFrame, LiveTargets } from './stream.js'

const OWNER_TOKEN = 'owner-token-for-tests-0123456789'
const DOCTOR_TOKEN = 'doctor-test-0123'

const opened: Array<{ close(): Promise<void> }> = []
afterEach(async () => {
  await Promise.all(opened.splice(0).map((server) => server.close()))
})

function fakeTargets(): LiveTargets & { emit(frame: LiveFrame): void } {
  const listeners = new Set<(frame: LiveFrame) => void>()
  return {
    emit: (frame) => listeners.forEach((listener) => listener(frame)),
    open: async () => ({
      subscribe(listener) {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
      dispatch: async () => {},
    }),
  }
}

async function startLive(env: Record<string, string | undefined>, targets: LiveTargets = fakeTargets()) {
  const live = await startLiveScreen(env, { control: createControlLock(), targets, doctorToken: DOCTOR_TOKEN, log: () => {} })
  if (live) opened.push(live)
  return live
}

const liveEnv = { REMONTNIK_BROWSER_LIVE_LISTEN: '127.0.0.1:0', REMONTNIK_BROWSER_OWNER_TOKEN: OWNER_TOKEN }

async function logIn(live: LiveScreen, token: string) {
  return fetch(`${live.url}/live/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token, profile: 'remontnik' }),
    redirect: 'manual',
  })
}

async function ownerCookie(live: LiveScreen): Promise<string> {
  const response = await logIn(live, OWNER_TOKEN)
  return (response.headers.get('set-cookie') ?? '').split(';')[0] ?? ''
}

function connectStream(live: LiveScreen, headers: Record<string, string>) {
  const socket = new WebSocket(`${live.url.replace('http', 'ws')}/live/stream?profile=remontnik`, { headers })
  // Сообщения копятся с самого подключения: первое состояние может прийти раньше, чем тест повесит слушателя.
  const messages: Array<{ type?: string; holder?: string }> = []
  socket.on('message', (data) => messages.push(JSON.parse(String(data))))
  return new Promise<{ opened: boolean; status?: number; socket: WebSocket; messages: typeof messages }>((resolve) => {
    socket.once('open', () => resolve({ opened: true, socket, messages }))
    socket.once('unexpected-response', (_request, response) => resolve({ opened: false, status: response.statusCode, socket, messages }))
    socket.once('error', () => resolve({ opened: false, socket, messages }))
  })
}

describe('живой экран: доступ', () => {
  it('переменная адреса не задана — живого экрана нет', async () => {
    expect(await startLive({ REMONTNIK_BROWSER_OWNER_TOKEN: OWNER_TOKEN })).toBeNull()
  })

  it('без ключа владельца не запускается', async () => {
    await expect(startLive({ REMONTNIK_BROWSER_LIVE_LISTEN: '127.0.0.1:0' })).rejects.toThrow(/REMONTNIK_BROWSER_OWNER_TOKEN/)
  })

  it('ключ владельца не может совпадать с ключом врача', async () => {
    await expect(startLive({ ...liveEnv, REMONTNIK_BROWSER_OWNER_TOKEN: DOCTOR_TOKEN })).rejects.toThrow(/совпадает/)
  })

  it('адрес — только частной сети: не «все адреса» и не публичный', () => {
    expect(parseLiveListen('100.101.102.103:7701')).toEqual({ host: '100.101.102.103', port: 7701 })
    expect(parseLiveListen('10.0.0.5:7701')).toEqual({ host: '10.0.0.5', port: 7701 })
    expect(parseLiveListen('[fd7a:115c:a1e0::1]:7701')).toEqual({ host: 'fd7a:115c:a1e0::1', port: 7701 })
    for (const wrong of ['0.0.0.0:7701', '[::]:7701', '203.0.113.5:7701', 'live.example.com:7701', '127.0.0.1', '127.0.0.1:99999']) {
      expect(() => parseLiveListen(wrong), wrong).toThrow()
    }
  })

  it('слушает ровно адрес из REMONTNIK_BROWSER_LIVE_LISTEN', async () => {
    const live = await startLive(liveEnv)
    expect(live?.address.host).toBe('127.0.0.1')
    expect(live?.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
  })

  it('служба врача живой экран не отдаёт', async () => {
    const filter = createOutputFilter(() => [])
    const server = createBrowserHttpServer({ token: DOCTOR_TOKEN, runner: { run: async () => ({ ok: true }) }, filter, log: () => {} })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    opened.push({ close: () => new Promise<void>((resolve) => server.close(() => resolve())) })
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    for (const path of ['/live?profile=remontnik', '/live/stream?profile=remontnik']) {
      const response = await fetch(`${base}${path}`, { headers: { authorization: `Bearer ${DOCTOR_TOKEN}` } })
      expect(response.status).toBe(404)
    }
  })

  it('без ключа владельца — только форма входа, без экрана и управления', async () => {
    const live = (await startLive(liveEnv))!
    const page = await fetch(`${live.url}/live?profile=remontnik`)
    const html = await page.text()
    expect(page.status).toBe(200)
    expect(html).toContain('name="token"')
    expect(html).not.toContain('/live/stream')

    const control = await fetch(`${live.url}/live/control`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ profile: 'remontnik', action: 'take' }),
    })
    expect(control.status).toBe(401)
    expect((await connectStream(live, {})).status).toBe(401)
  })

  it('ключ врача сюда не подходит', async () => {
    const live = (await startLive(liveEnv))!
    const response = await logIn(live, DOCTOR_TOKEN)
    expect(response.status).toBe(401)
    expect(response.headers.get('set-cookie')).toBeNull()
    const bearer = await fetch(`${live.url}/live/control`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${DOCTOR_TOKEN}` },
      body: JSON.stringify({ profile: 'remontnik', action: 'take' }),
    })
    expect(bearer.status).toBe(401)
  })

  it('ключ владельца — куки HttpOnly и SameSite=Strict, дальше экран, управление и кадры', async () => {
    const targets = fakeTargets()
    const live = (await startLive(liveEnv, targets))!
    const login = await logIn(live, OWNER_TOKEN)
    expect(login.status).toBe(303)
    const setCookie = login.headers.get('set-cookie') ?? ''
    expect(setCookie).toMatch(/HttpOnly/)
    expect(setCookie).toMatch(/SameSite=Strict/)
    expect(setCookie).toMatch(/Path=\/live/)
    expect(setCookie).not.toContain(OWNER_TOKEN)
    const cookie = setCookie.split(';')[0]!

    const page = await fetch(`${live.url}/live?profile=remontnik`, { headers: { cookie } })
    expect(await page.text()).toContain('/live/stream')

    const take = await fetch(`${live.url}/live/control`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ profile: 'remontnik', action: 'take' }),
    })
    expect(await take.json()).toEqual({ ok: true, holder: 'owner' })

    const stream = await connectStream(live, { cookie, origin: live.url })
    expect(stream.opened).toBe(true)
    const message = new Promise<string>((resolve) =>
      stream.socket.on('message', (data) => {
        if (JSON.parse(String(data)).type === 'frame') resolve(String(data))
      }),
    )
    targets.emit({ data: 'ZnJhbWU=', width: 1280, height: 800 })
    expect(JSON.parse(await message)).toMatchObject({ type: 'frame', data: 'ZnJhbWU=' })
    stream.socket.close()
  })

  it('«Взять» и «Вернуть» по потоку идут строго после уже отправленного ввода', async () => {
    const dispatched: unknown[] = []
    const targets: LiveTargets = {
      open: async () => ({
        subscribe: () => () => {},
        dispatch: async (input) => {
          await new Promise((resolve) => setTimeout(resolve, 5))
          dispatched.push(input)
        },
      }),
    }
    const live = (await startLive(liveEnv, targets))!
    const stream = await connectStream(live, { cookie: await ownerCookie(live), origin: live.url })
    const holders = () => stream.messages.filter((message) => message.type === 'control').map((message) => message.holder)
    // Поток готов принимать ввод, когда пришло первое состояние управления.
    await expect.poll(() => holders().length).toBeGreaterThan(0)
    stream.socket.send(JSON.stringify({ type: 'control', action: 'take' }))
    for (const text of ['П', 'р', 'и']) stream.socket.send(JSON.stringify({ type: 'text', text }))
    stream.socket.send(JSON.stringify({ type: 'key', key: 'Enter' }))
    stream.socket.send(JSON.stringify({ type: 'control', action: 'release' }))
    await expect.poll(() => holders().at(-1) === 'doctor' && holders().includes('owner')).toBe(true)
    expect(dispatched).toEqual([
      { type: 'text', text: 'П' },
      { type: 'text', text: 'р' },
      { type: 'text', text: 'и' },
      { type: 'key', key: 'Enter' },
    ])
    stream.socket.close()
  })

  it('поток с чужой страницы (другой Origin) не открывается даже с куки', async () => {
    const live = (await startLive(liveEnv))!
    const cookie = await ownerCookie(live)
    expect((await connectStream(live, { cookie, origin: 'https://evil.example.com' })).status).toBe(403)
  })

  it('подбор ключа ограничен', async () => {
    const live = (await startLive(liveEnv))!
    const statuses: number[] = []
    for (let attempt = 0; attempt < 7; attempt++) statuses.push((await logIn(live, `wrong-${attempt}`)).status)
    expect(statuses.slice(0, 5).every((status) => status === 401)).toBe(true)
    expect(statuses.at(-1)).toBe(429)
    expect((await logIn(live, OWNER_TOKEN)).status).toBe(429)
  })
})
