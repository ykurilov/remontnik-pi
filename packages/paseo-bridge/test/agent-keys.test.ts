import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FakeDoctor, FakePaseo, SHOP_AGENT, SHOP_SECRET, freshStateFile, makeConfig, shopTask, signedGet, signedPost, startBridge, taskKeyFrom, until } from './bridge-world.js'

// Ключ задачи: своя память повторов у путей агента с квотой на ключ; ключ гаснет после итога, после отмены — через
// срок, при новой задаче того же случая; подробности случая — только пока задача жива и недолго.

let doctor: FakeDoctor
let paseo: FakePaseo
let running: Awaited<ReturnType<typeof startBridge>>[] = []
let clock = Date.now()

beforeEach(async () => {
  doctor = new FakeDoctor(SHOP_SECRET)
  await doctor.start()
  paseo = new FakePaseo()
  paseo.states.set(SHOP_AGENT, 'idle')
  clock = Date.now()
})

afterEach(async () => {
  for (const started of running) await started.close()
  running = []
  await doctor.stop()
})

async function bridgeWithTask(keys: Parameters<typeof startBridge>[0]['keys'] = {}, stateFile = freshStateFile()) {
  const started = await startBridge({
    config: makeConfig({ shop: doctor.url, blog: doctor.url }),
    paseo,
    stateFile,
    keys: { now: () => clock, ...keys },
  })
  running.push(started)
  await signedPost(`${started.server.url}/v1/tasks`, shopTask(), SHOP_SECRET)
  await until(() => paseo.letters.length === 1)
  return { url: started.server.url, key: taskKeyFrom(paseo.letters[0]!.text), stateFile }
}

const ask = (url: string, path: string, body: Record<string, unknown>, key: string) => signedPost(`${url}${path}`, { app: 'shop', caseId: 7, ...body }, key)

describe('память повторов путей агента', () => {
  it('агент исчерпал квоту меток своего ключа — 503 ему; пути врача живы', async () => {
    const { url, key } = await bridgeWithTask({ agentNoncesPerKey: 3 })
    for (let index = 0; index < 3; index += 1) expect((await ask(url, '/v1/agent/case', {}, key)).status).toBe(200)
    expect(await ask(url, '/v1/agent/case', {}, key)).toEqual({ status: 503, body: { error: 'replay_memory_full' } })

    expect((await signedGet(url, '/health?app=shop', SHOP_SECRET)).status).toBe(200)
    expect((await signedPost(`${url}/v1/tasks`, shopTask({ taskId: '01JBBBBBBBBBBBBBBBBBBBBBBB', caseId: 8 }), SHOP_SECRET)).status).toBe(200)
    await until(() => paseo.letters.length === 2)
    // Квота — на ключ: у агента другой задачи она своя.
    const second = taskKeyFrom(paseo.letters[1]!.text)
    expect((await ask(url, '/v1/agent/case', { caseId: 8 }, second)).status).toBe(200)
    const taskId = shopTask().taskId
    expect((await signedPost(`${url}/v1/tasks/${taskId}/cancel`, { app: 'shop', taskId, reason: 'work_timeout' }, SHOP_SECRET)).status).toBe(200)
  })
})

describe('срок ключа задачи', () => {
  it('итог принят врачом — ключ гаснет: и повтор итога, и case — 401; ключа нет и в файле состояния', async () => {
    const { url, key, stateFile } = await bridgeWithTask()
    expect(await ask(url, '/v1/agent/result', { kind: 'done', version: 'v2' }, key)).toEqual({ status: 200, body: { ok: true } })
    expect(await ask(url, '/v1/agent/result', { kind: 'done', version: 'v2' }, key)).toEqual({ status: 401, body: { error: 'bad_signature' } })
    expect(await ask(url, '/v1/agent/case', {}, key)).toEqual({ status: 401, body: { error: 'bad_signature' } })
    expect(readFileSync(stateFile, 'utf8')).not.toContain(key)
  })

  it('итог не принят врачом — ключ жив, агент может повторить', async () => {
    const { url, key } = await bridgeWithTask()
    doctor.override = (method, path) => (path === '/v1/handoffs/7/result' ? { status: 503, body: { error: 'busy' } } : undefined)
    expect((await ask(url, '/v1/agent/result', { kind: 'done' }, key)).status).toBe(503)
    doctor.override = null
    expect(await ask(url, '/v1/agent/result', { kind: 'done' }, key)).toEqual({ status: 200, body: { ok: true } })
  })

  it('после отмены: case — 409 сразу, поздний done — до срока, после срока ключ погашен', async () => {
    const { url, key } = await bridgeWithTask({ cancelledKeyTtlMs: 60 * 60_000 })
    const taskId = shopTask().taskId
    await signedPost(`${url}/v1/tasks/${taskId}/cancel`, { app: 'shop', taskId, reason: 'work_timeout' }, SHOP_SECRET)
    expect(await ask(url, '/v1/agent/case', {}, key)).toEqual({ status: 409, body: { error: 'task_cancelled' } })
    clock += 60 * 60_000 + 1
    expect(await ask(url, '/v1/agent/result', { kind: 'done', version: 'v3' }, key)).toEqual({ status: 401, body: { error: 'bad_signature' } })
    expect(doctor.requests.filter((request) => request.path.startsWith('/v1/handoffs/'))).toEqual([])
  })

  it('поздний done после отмены в пределах срока уходит врачу', async () => {
    const { url, key } = await bridgeWithTask({ cancelledKeyTtlMs: 60 * 60_000 })
    const taskId = shopTask().taskId
    await signedPost(`${url}/v1/tasks/${taskId}/cancel`, { app: 'shop', taskId, reason: 'work_timeout' }, SHOP_SECRET)
    clock += 30 * 60_000
    expect(await ask(url, '/v1/agent/result', { kind: 'done', version: 'v3' }, key)).toEqual({ status: 200, body: { ok: true } })
  })

  it('case отдаёт подробности только недолго после получения задачи; accept и итог — по-прежнему', async () => {
    const { url, key } = await bridgeWithTask({ caseReadTtlMs: 10 * 60_000 })
    expect((await ask(url, '/v1/agent/case', {}, key)).status).toBe(200)
    clock += 10 * 60_000 + 1
    expect(await ask(url, '/v1/agent/case', {}, key)).toEqual({ status: 403, body: { error: 'case_read_expired' } })
    expect((await ask(url, '/v1/agent/accepted', {}, key)).status).toBe(200)
  })

  it('новая задача того же случая гасит ключ старой: старый — 401 и пропадает из файла, новый работает', async () => {
    const { url, key: oldKey, stateFile } = await bridgeWithTask()
    const taskId = shopTask().taskId
    await signedPost(`${url}/v1/tasks/${taskId}/cancel`, { app: 'shop', taskId, reason: 'work_timeout' }, SHOP_SECRET)
    expect((await signedPost(`${url}/v1/tasks`, shopTask({ taskId: '01JCCCCCCCCCCCCCCCCCCCCCCC' }), SHOP_SECRET)).status).toBe(200)
    const taskLetters = () => paseo.letters.filter((letter) => letter.text.includes('передаёт тебе случай'))
    await until(() => taskLetters().length === 2)
    const newKey = taskKeyFrom(taskLetters()[1]!.text)
    expect(newKey).not.toBe(oldKey)
    expect(await ask(url, '/v1/agent/result', { kind: 'done' }, oldKey)).toEqual({ status: 401, body: { error: 'bad_signature' } })
    expect(readFileSync(stateFile, 'utf8')).not.toContain(oldKey)
    expect((await ask(url, '/v1/agent/accepted', {}, newKey)).status).toBe(200)
  })
})
