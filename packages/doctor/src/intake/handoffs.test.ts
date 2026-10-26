import { signRequest } from '@ykurilov/remontnik-core/signed-http'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { HANDOFF_COLLECTION, handoffKey, type Handoff } from '../handoff/index.js'
import { createMemoryRecordStore, type RecordStore } from '../records/index.js'
import { createHandoffsHandler } from './handoffs.js'
import { startIntakeServer, type IntakeServer } from './index.js'

// Команды агента через мост (`POST /v1/handoffs/:caseId/accepted|result`): только с подписью моста, одна подпись —
// один раз, подпись не старше запуска врача, только свой случай, своя задача и своё приложение.

const SECRET = 'bridge-secret-for-tests'
const APP = 'patient'
const TASK = '01JB0000000000000000000000'
const OTHER_TASK = '01JB0000000000000000000001'
const start = Date.parse('2026-10-26T10:00:00Z')

let store: RecordStore
let server: IntakeServer
let now: number

beforeEach(async () => {
  now = start
  store = createMemoryRecordStore()
  await store.transaction(async (tx) => {
    Object.assign(await tx.doc<Handoff>(HANDOFF_COLLECTION, handoffKey(1), {} as Handoff), { caseId: 1, taskId: TASK, owner: 'paseo', sentAt: new Date(start).toISOString() })
  })
  server = await startIntakeServer({ handler: createHandoffsHandler({ records: store, secret: SECRET, appName: APP, now: () => now }), host: '127.0.0.1', port: 0 })
})

afterEach(async () => {
  await server.close()
})

type Signature = ReturnType<typeof signRequest>

async function post(path: string, payload: unknown, options: { signature?: Signature; signedAt?: number } = {}) {
  const body = JSON.stringify(payload)
  const signature = options.signature ?? signRequest({ method: 'POST', target: path, body, secret: SECRET, now: options.signedAt ?? now })
  const response = await fetch(`${server.url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...signature }, body })
  return { status: response.status, body: (await response.json()) as unknown, signature }
}

const handoff = () => store.read<Handoff>(HANDOFF_COLLECTION, handoffKey(1))

describe('команды агента через мост', () => {
  it('та же подпись второй раз — отказ replayed, второй раз не записывается', async () => {
    const first = await post('/v1/handoffs/1/accepted', { taskId: TASK, agent: 'agent-1' })
    expect(first.status).toBe(200)
    const acceptedAt = (await handoff())!.acceptedAt
    now += 60_000
    const replay = await post('/v1/handoffs/1/accepted', { taskId: TASK, agent: 'agent-1' }, { signature: first.signature })
    expect(replay).toMatchObject({ status: 401, body: { error: 'replayed' } })
    expect((await handoff())!.acceptedAt).toBe(acceptedAt)
  })

  it('чужой случай — unknown_case, чужая задача — unknown_task: документ передачи не меняется', async () => {
    expect(await post('/v1/handoffs/2/accepted', { taskId: TASK, agent: 'agent-1' })).toMatchObject({ status: 404, body: { error: 'unknown_case' } })
    expect(await post('/v1/handoffs/2/result', { taskId: TASK, kind: 'done', deployed: false })).toMatchObject({ status: 404, body: { error: 'unknown_case' } })
    expect(await post('/v1/handoffs/1/accepted', { taskId: OTHER_TASK, agent: 'agent-1' })).toMatchObject({ status: 404, body: { error: 'unknown_task' } })
    expect(await post('/v1/handoffs/1/result', { taskId: OTHER_TASK, kind: 'done', deployed: false })).toMatchObject({ status: 404, body: { error: 'unknown_task' } })
    const kept = (await handoff())!
    expect(kept.acceptedAt).toBeUndefined()
    expect(kept.result).toBeUndefined()
    expect(await store.read(HANDOFF_COLLECTION, handoffKey(2))).toBeUndefined()
  })

  it('чужое приложение в теле — отказ как при неверной подписи', async () => {
    expect(await post('/v1/handoffs/1/result', { app: 'other-app', taskId: TASK, kind: 'done', deployed: false })).toMatchObject({ status: 401, body: { error: 'bad_signature' } })
    expect((await handoff())!.result).toBeUndefined()
    expect(await post('/v1/handoffs/1/result', { app: APP, taskId: TASK, kind: 'done', deployed: false })).toMatchObject({ status: 200 })
  })

  it('подпись сделана до запуска врача — отказ: память повторов после перезапуска пуста', async () => {
    const before = await post('/v1/handoffs/1/accepted', { taskId: TASK, agent: 'agent-1' }, { signedAt: start - 60_000 })
    expect(before).toMatchObject({ status: 401, body: { error: 'stale' } })
    expect((await handoff())!.acceptedAt).toBeUndefined()
  })
})
