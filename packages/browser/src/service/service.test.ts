import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { createOutputFilter } from '../vault/index.js'
import { createBrowserHttpServer } from './index.js'

const TOKEN = 'doctor-test-0123'
const SAVED_PASSWORD = 'saved-password-for-filter'

const servers: Array<{ close(callback: () => void): void }> = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))))
})

async function startService(run: (command: string, input: Record<string, unknown>) => Promise<unknown>) {
  const logs: string[] = []
  const server = createBrowserHttpServer({
    token: TOKEN,
    runner: { run: run as never },
    filter: createOutputFilter(() => [SAVED_PASSWORD]),
    log: (line) => logs.push(line),
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  servers.push(server)
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const call = (command: string, body: unknown, token = TOKEN) =>
    fetch(`${base}/v1/${command}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  return { call, logs }
}

describe('HTTP-служба браузера', () => {
  it('без ключа врача или с чужим — 401, команда не выполняется', async () => {
    const calls: string[] = []
    const { call } = await startService(async (command) => {
      calls.push(command)
      return { ok: true }
    })
    expect((await call('read', { profile: 'remontnik' }, 'wrong-token')).status).toBe(401)
    expect((await call('read', { profile: 'remontnik' }, '')).status).toBe(401)
    expect(calls).toEqual([])
  })

  it('передаёт команду и вход исполнителю', async () => {
    const { call } = await startService(async (command, input) => ({ ok: true, command, input }))
    const response = await call('url', { profile: 'remontnik', url: 'https://app.example.com/' })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true, command: 'url', input: { profile: 'remontnik', url: 'https://app.example.com/' } })
  })

  it('неизвестная команда — 404; не JSON — 400', async () => {
    const { call } = await startService(async () => ({ ok: true }))
    expect((await call('evaluate', { profile: 'remontnik' })).status).toBe(404)
    expect((await call('run-js', { profile: 'remontnik' })).status).toBe(404)
    const response = await call('read', 'не объект')
    expect(response.status).toBe(400)
  })

  it('ответы и журнал проходят через фильтр сохранённых паролей', async () => {
    const { call, logs } = await startService(async () => {
      throw new Error(`упало на поле со значением ${SAVED_PASSWORD}`)
    })
    const response = await call('read', { profile: 'remontnik' })
    const text = await response.text()
    expect(text).not.toContain(SAVED_PASSWORD)
    expect(JSON.parse(text)).toMatchObject({ ok: false, code: 'internal' })
    expect(logs.join('\n')).not.toContain(SAVED_PASSWORD)
    expect(logs.join('\n')).toContain('[пароль скрыт]')
  })

  it('отказы исполнителя отдаются как есть, код HTTP 200', async () => {
    const { call } = await startService(async () => ({ ok: false, code: 'refused_danger', message: 'оплата запрещена' }))
    const response = await call('click', { profile: 'remontnik', ref: 'e1', danger: 'pay' })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: false, code: 'refused_danger', message: 'оплата запрещена' })
  })
})
