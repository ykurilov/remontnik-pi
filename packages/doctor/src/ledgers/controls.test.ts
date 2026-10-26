import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { signRequest } from '@ykurilov/remontnik-core/signed-http'
import { runDoctorCommand } from '../cli/run-doctor-command.js'
import { createDeployControlsHandler } from '../intake/deploy-controls.js'
import { createIntakeHandler, startIntakeServer, type IntakeServer } from '../intake/index.js'
import { createMemoryRecordStore, type RecordStore } from '../records/index.js'
import { createControls, type Controls } from './controls.js'

// Стоп-кран выкаток: документ `remontnik.controls`, подписанный `POST /v1/control/deploys` и `deploys stop|resume`.
// Что стоп-кран останавливает выкатку, проверяет deployer/deploy-sequence.test.ts.

const SECRET = 'shared-secret-for-tests'
const at = new Date('2026-10-26T12:00:00Z')
let store: RecordStore
let controls: Controls
let server: IntakeServer
let startedAt: number

beforeEach(async () => {
  store = createMemoryRecordStore()
  controls = createControls(store, () => at)
  startedAt = Date.now()
  server = await startIntakeServer({
    handler: createIntakeHandler({
      secret: SECRET,
      receiveEvents: async () => ({ accepted: [] }),
      health: async () => ({ ok: true, autoDeploy: (await controls.read()).autoDeploy }),
      deployControls: createDeployControlsHandler({ controls, secret: SECRET }),
    }),
    host: '127.0.0.1',
    port: 0,
  })
})

afterEach(async () => {
  await server.close()
})

function signedPost(body: string, secret = SECRET, now = Date.now()) {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...signRequest({ method: 'POST', target: '/v1/control/deploys', body, secret, now }) },
    body,
  }
}

describe('документ стоп-крана', () => {
  it('по умолчанию выкатки включены; стоп помнит кто и когда; пуск снимает', async () => {
    expect(await controls.read()).toEqual({ autoDeploy: 'on' })
    expect(await controls.set('stop', 'telegram:admin')).toEqual({ autoDeploy: 'stopped', stoppedBy: 'telegram:admin', stoppedAt: at.toISOString() })
    expect(await createControls(store, () => at).read()).toMatchObject({ autoDeploy: 'stopped' })
    expect(await controls.set('resume', 'console')).toEqual({ autoDeploy: 'on' })
  })
})

describe('POST /v1/control/deploys', () => {
  it('подписанный стоп останавливает выкатки, /health это видит', async () => {
    const response = await fetch(`${server.url}/v1/control/deploys`, signedPost(JSON.stringify({ action: 'stop', by: 'telegram:admin' })))
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ autoDeploy: 'stopped' })
    expect(await (await fetch(`${server.url}/health`)).json()).toMatchObject({ autoDeploy: 'stopped' })

    const resumed = await fetch(`${server.url}/v1/control/deploys`, signedPost(JSON.stringify({ action: 'resume', by: 'telegram:admin' })))
    expect(await resumed.json()).toEqual({ autoDeploy: 'on' })
  })

  it('без подписи, чужим секретом, повтором или подписью до запуска врача — 401, стоп-кран не тронут', async () => {
    const body = JSON.stringify({ action: 'stop', by: 'x' })
    const unsigned = await fetch(`${server.url}/v1/control/deploys`, { method: 'POST', body })
    expect(unsigned.status).toBe(401)
    expect((await fetch(`${server.url}/v1/control/deploys`, signedPost(body, 'other-secret'))).status).toBe(401)

    const once = signedPost(JSON.stringify({ action: 'resume', by: 'x' }))
    expect((await fetch(`${server.url}/v1/control/deploys`, once)).status).toBe(200)
    const replay = await fetch(`${server.url}/v1/control/deploys`, once)
    expect(replay.status).toBe(401)
    expect(await replay.json()).toEqual({ error: 'replayed' })

    const old = await fetch(`${server.url}/v1/control/deploys`, signedPost(body, SECRET, startedAt - 5_000))
    expect(old.status).toBe(401)
    expect(await old.json()).toEqual({ error: 'stale' })
    expect(await controls.read()).toEqual({ autoDeploy: 'on' })
  })

  it('неверное тело — 400; другой метод — 404', async () => {
    for (const body of ['{', JSON.stringify({ action: 'pause', by: 'x' }), JSON.stringify({ action: 'stop' }), JSON.stringify({ action: 'stop', by: 'x'.repeat(101) })]) {
      expect((await fetch(`${server.url}/v1/control/deploys`, signedPost(body))).status).toBe(400)
    }
    expect((await fetch(`${server.url}/v1/control/deploys`)).status).toBe(404)
    expect(await controls.read()).toEqual({ autoDeploy: 'on' })
  })
})

describe('remontnik-doctor deploys stop|resume', () => {
  async function run(argv: string[], env: Record<string, string | undefined> = { REMONTNIK_DOCTOR_URL: server.url, REMONTNIK_SHARED_SECRET: SECRET }) {
    let out = ''
    let err = ''
    const code = await runDoctorCommand(argv, { env, stdout: (text) => (out += text), stderr: (text) => (err += text) })
    return { code, out, err }
  }

  it('стоп и пуск подписанным запросом; кто нажал — из --by, иначе console', async () => {
    const stopped = await run(['deploys', 'stop', '--by', 'admin'])
    expect(stopped.code).toBe(0)
    expect(JSON.parse(stopped.out)).toEqual({ autoDeploy: 'stopped' })
    expect(await controls.read()).toMatchObject({ autoDeploy: 'stopped', stoppedBy: 'admin' })

    expect(JSON.parse((await run(['deploys', 'resume'])).out)).toEqual({ autoDeploy: 'on' })
  })

  it('без секрета — ошибка, секрет в вывод не попадает; неизвестное действие — код 2', async () => {
    const noSecret = await run(['deploys', 'stop'], { REMONTNIK_DOCTOR_URL: server.url })
    expect(noSecret.code).toBe(1)
    expect(noSecret.err).toContain('REMONTNIK_SHARED_SECRET')

    const wrong = await run(['deploys', 'stop'], { REMONTNIK_DOCTOR_URL: server.url, REMONTNIK_SHARED_SECRET: 'other-secret' })
    expect(wrong.code).toBe(1)
    expect(wrong.err + wrong.out).not.toContain('other-secret')

    expect((await run(['deploys', 'pause'])).code).toBe(2)
  })
})
