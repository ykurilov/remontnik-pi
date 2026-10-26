import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { startBridgeServer } from '../server/index.js'
import {
  BLOG_AGENT,
  BLOG_SECRET,
  FakeDoctor,
  FakePaseo,
  SHOP_AGENT,
  SHOP_SECRET,
  freshStateFile,
  makeConfig,
  shopTask,
  signedGet,
  signedPost,
  startBridge,
  until,
} from './bridge-world.js'

let shopDoctor: FakeDoctor
let blogDoctor: FakeDoctor
let paseo: FakePaseo
let running: Awaited<ReturnType<typeof startBridge>>[] = []

async function bridgeFor(stateFile?: string) {
  const started = await startBridge({
    config: makeConfig({ shop: shopDoctor.url, blog: blogDoctor.url }),
    paseo,
    ...(stateFile ? { stateFile } : {}),
  })
  running.push(started)
  return started
}

beforeEach(async () => {
  shopDoctor = new FakeDoctor(SHOP_SECRET)
  blogDoctor = new FakeDoctor(BLOG_SECRET)
  await Promise.all([shopDoctor.start(), blogDoctor.start()])
  paseo = new FakePaseo()
  paseo.states.set(SHOP_AGENT, 'idle')
  paseo.states.set(BLOG_AGENT, 'idle')
})

afterEach(async () => {
  for (const started of running) await started.close()
  running = []
  await Promise.all([shopDoctor.stop(), blogDoctor.stop()])
})

describe('подпись и приложение', () => {
  it('без подписи, с неверной подписью или с секретом другого приложения — отказ, агенту ничего', async () => {
    const { server } = await bridgeFor()
    const body = JSON.stringify(shopTask())

    const unsigned = await fetch(`${server.url}/v1/tasks`, { method: 'POST', body })
    expect(unsigned.status).toBe(401)
    expect(await unsigned.json()).toEqual({ error: 'missing' })

    const forged = await signedPost(`${server.url}/v1/tasks`, shopTask(), 'not-the-secret')
    expect(forged).toEqual({ status: 401, body: { error: 'bad_signature' } })

    const otherApp = await signedPost(`${server.url}/v1/tasks`, shopTask(), BLOG_SECRET)
    expect(otherApp).toEqual({ status: 401, body: { error: 'bad_signature' } })

    expect(paseo.letters).toEqual([])
  })

  it('приложение не из настройки моста — отказ', async () => {
    const { server } = await bridgeFor()
    const result = await signedPost(`${server.url}/v1/tasks`, shopTask({ app: 'stranger' }), SHOP_SECRET)
    expect(result).toEqual({ status: 403, body: { error: 'unknown_app' } })
    expect(paseo.letters).toEqual([])
  })

  it('подпись устарела — отказ', async () => {
    const { server } = await bridgeFor()
    const body = JSON.stringify(shopTask())
    const { signBody } = await import('@ykurilov/remontnik-core/signed-http')
    const response = await fetch(`${server.url}/v1/tasks`, {
      method: 'POST',
      headers: signBody(body, SHOP_SECRET, Date.now() - 60 * 60 * 1000),
      body,
    })
    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({ error: 'stale' })
  })

  it('неполная задача — отказ 400', async () => {
    const { server } = await bridgeFor()
    for (const broken of [
      shopTask({ taskId: 'not a ulid' }),
      shopTask({ caseId: -1 }),
      shopTask({ kind: 'rm -rf' }),
      shopTask({ untrusted: 'text' }),
      shopTask({ links: { branch: 'a b', reportIds: [] } }),
    ]) {
      const result = await signedPost(`${server.url}/v1/tasks`, broken, SHOP_SECRET)
      expect(result).toEqual({ status: 400, body: { error: 'bad_request' } })
    }
    expect(paseo.letters).toEqual([])
  })
})

describe('задачи', () => {
  it('задача уходит только агенту, назначенному приложению в настройке моста', async () => {
    const { server } = await bridgeFor()
    const result = await signedPost(`${server.url}/v1/tasks`, shopTask({ agentId: BLOG_AGENT }), SHOP_SECRET)
    expect(result).toEqual({ status: 200, body: { queued: true } })

    await until(() => paseo.letters.length === 1)
    expect(paseo.letters[0]!.agentId).toBe(SHOP_AGENT)
    expect(paseo.lettersTo(BLOG_AGENT)).toEqual([])
    expect(paseo.letters[0]!.text).toContain('случай №7')
  })

  it('повтор той же задачи не даёт второго письма', async () => {
    const { server } = await bridgeFor()
    await signedPost(`${server.url}/v1/tasks`, shopTask(), SHOP_SECRET)
    await until(() => paseo.letters.length === 1)
    const again = await signedPost(`${server.url}/v1/tasks`, shopTask(), SHOP_SECRET)
    expect(again).toEqual({ status: 200, body: { queued: true } })
    expect(paseo.letters).toHaveLength(1)
  })

  it('агента нет — 503, задача не записана', async () => {
    paseo.states.set(SHOP_AGENT, 'missing')
    const { server } = await bridgeFor()
    const result = await signedPost(`${server.url}/v1/tasks`, shopTask(), SHOP_SECRET)
    expect(result).toEqual({ status: 503, body: { error: 'agent_missing' } })
    expect(paseo.letters).toEqual([])
  })

  it('агент занят — письмо ждёт, пока он освободится, и не прерывает его', async () => {
    paseo.states.set(SHOP_AGENT, 'running')
    const { server } = await bridgeFor()
    expect(await signedPost(`${server.url}/v1/tasks`, shopTask(), SHOP_SECRET)).toEqual({
      status: 200,
      body: { queued: true },
    })
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(paseo.letters).toEqual([])

    paseo.states.set(SHOP_AGENT, 'idle')
    await until(() => paseo.letters.length === 1)
  })

  it('отмена: агенту письмо «остановись», повторная отмена письма не дублирует', async () => {
    const { server } = await bridgeFor()
    await signedPost(`${server.url}/v1/tasks`, shopTask(), SHOP_SECRET)
    await until(() => paseo.letters.length === 1)

    const taskId = shopTask().taskId
    const cancel = { app: 'shop', taskId, reason: 'accept_timeout' }
    expect(await signedPost(`${server.url}/v1/tasks/${taskId}/cancel`, cancel, SHOP_SECRET)).toEqual({
      status: 200,
      body: { ok: true },
    })
    await until(() => paseo.letters.length === 2)
    expect(paseo.letters[1]!.agentId).toBe(SHOP_AGENT)
    expect(paseo.letters[1]!.text).toContain('Остановись')
    expect(paseo.letters[1]!.text).toContain('случай №7')

    expect(await signedPost(`${server.url}/v1/tasks/${taskId}/cancel`, cancel, SHOP_SECRET)).toEqual({
      status: 200,
      body: { ok: true },
    })
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(paseo.letters).toHaveLength(2)
  })

  it('отмена до отправки письма: задача агенту так и не уходит', async () => {
    paseo.states.set(SHOP_AGENT, 'running')
    const { server } = await bridgeFor()
    await signedPost(`${server.url}/v1/tasks`, shopTask(), SHOP_SECRET)
    const taskId = shopTask().taskId
    await signedPost(`${server.url}/v1/tasks/${taskId}/cancel`, { app: 'shop', taskId, reason: 'work_timeout' }, SHOP_SECRET)
    paseo.states.set(SHOP_AGENT, 'idle')
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(paseo.letters).toEqual([])
  })

  it('отмена чужой или неизвестной задачи — отказ', async () => {
    const { server } = await bridgeFor()
    await signedPost(`${server.url}/v1/tasks`, shopTask(), SHOP_SECRET)
    await until(() => paseo.letters.length === 1)
    const taskId = shopTask().taskId

    const fromBlog = await signedPost(
      `${server.url}/v1/tasks/${taskId}/cancel`,
      { app: 'blog', taskId, reason: 'x' },
      BLOG_SECRET,
    )
    expect(fromBlog).toEqual({ status: 404, body: { error: 'unknown_task' } })

    const mismatch = await signedPost(
      `${server.url}/v1/tasks/${taskId}/cancel`,
      { app: 'shop', taskId: '01JBBBBBBBBBBBBBBBBBBBBBBB', reason: 'x' },
      SHOP_SECRET,
    )
    expect(mismatch).toEqual({ status: 400, body: { error: 'bad_request' } })
    expect(paseo.letters).toHaveLength(1)
  })
})

describe('здоровье', () => {
  it('отвечает состояние назначенного агента; без подписи — отказ', async () => {
    const { server } = await bridgeFor()
    expect(await signedGet(server.url, '/health?app=shop', SHOP_SECRET)).toEqual({
      status: 200,
      body: { paseo: 'up', agent: 'idle' },
    })
    paseo.states.set(SHOP_AGENT, 'running')
    expect((await signedGet(server.url, '/health?app=shop', SHOP_SECRET)).body).toEqual({ paseo: 'up', agent: 'running' })
    paseo.states.set(SHOP_AGENT, 'not_ready')
    expect((await signedGet(server.url, '/health?app=shop', SHOP_SECRET)).body).toEqual({
      paseo: 'up',
      agent: 'missing',
      reason: 'paseo_not_ready',
    })

    expect((await fetch(`${server.url}/health?app=shop`)).status).toBe(401)
    // Подпись от запроса про другое приложение к этому не подходит.
    const { signBody } = await import('@ykurilov/remontnik-core/signed-http')
    const replay = await fetch(`${server.url}/health?app=blog`, { headers: signBody('GET /health?app=shop', BLOG_SECRET) })
    expect(replay.status).toBe(401)
    expect((await signedGet(server.url, '/health?app=stranger', SHOP_SECRET)).status).toBe(403)
  })
})

describe('отчёты', () => {
  function addReports(...ids: number[]) {
    for (const reportId of ids) {
      shopDoctor.reports.push({
        reportId,
        caseId: 7,
        type: 'deployed',
        short: `Отчёт ${reportId}`,
        full: `Полный текст ${reportId}`,
        createdAt: '2026-10-26T10:00:00.000Z',
      })
    }
  }

  const reportNumbers = () =>
    paseo.lettersTo(SHOP_AGENT).map((text) => Number(/Отчёт Ремонтника №(\d+)/.exec(text)?.[1]))

  it('по курсору, по порядку, без повторов номера, с подтверждением', async () => {
    addReports(1, 2, 3)
    const { server } = await bridgeFor()
    await signedPost(`${server.url}/v1/reports/notify`, { app: 'shop', last: 3 }, SHOP_SECRET)
    await until(() => shopDoctor.acked.includes(3))
    expect(reportNumbers()).toEqual([1, 2, 3])

    await signedPost(`${server.url}/v1/reports/notify`, { app: 'shop', last: 3 }, SHOP_SECRET)
    addReports(4)
    await signedPost(`${server.url}/v1/reports/notify`, { app: 'shop', last: 4 }, SHOP_SECRET)
    await until(() => shopDoctor.acked.includes(4))
    expect(reportNumbers()).toEqual([1, 2, 3, 4])
    expect(shopDoctor.requests.every((request) => request.signatureOk)).toBe(true)
    expect(paseo.lettersTo(BLOG_AGENT)).toEqual([])
  })

  it('агента нет — отчёты ждут у врача и уходят, когда он появится; рестарт моста не повторяет номера', async () => {
    addReports(1, 2)
    paseo.states.set(SHOP_AGENT, 'missing')
    const stateFile = freshStateFile()
    const first = await bridgeFor(stateFile)
    await signedPost(`${first.server.url}/v1/reports/notify`, { app: 'shop', last: 2 }, SHOP_SECRET)
    await first.bridge.pullReports('shop')
    expect(paseo.letters).toEqual([])
    expect(shopDoctor.acked).toEqual([])

    paseo.states.set(SHOP_AGENT, 'idle')
    await first.bridge.pullReports('shop')
    expect(reportNumbers()).toEqual([1, 2])
    await first.close()
    running = running.filter((started) => started !== first)

    const second = await bridgeFor(stateFile)
    addReports(3)
    await second.bridge.pullReports('shop')
    expect(reportNumbers()).toEqual([1, 2, 3])
  })

  it('письмо не ушло — курсор возвращается, отчёт уходит позже ровно один раз', async () => {
    addReports(1, 2)
    const { bridge } = await bridgeFor()
    paseo.failNextSend = true
    await bridge.pullReports('shop')
    expect(reportNumbers()).toEqual([])
    await bridge.pullReports('shop')
    expect(reportNumbers()).toEqual([1, 2])
  })
})

describe('команды агента через мост', () => {
  async function bridgeWithTask() {
    const started = await bridgeFor()
    await signedPost(`${started.server.url}/v1/tasks`, shopTask(), SHOP_SECRET)
    await until(() => paseo.letters.length === 1)
    return started
  }

  it('accept и result уходят врачу этого приложения с номером задачи и агентом', async () => {
    const { server } = await bridgeWithTask()
    expect(await signedPost(`${server.url}/v1/agent/accepted`, { app: 'shop', caseId: 7 }, SHOP_SECRET)).toEqual({
      status: 200,
      body: { ok: true },
    })
    expect(
      await signedPost(
        `${server.url}/v1/agent/result`,
        { app: 'shop', caseId: 7, kind: 'done', commit: 'abc1234', version: 'v12' },
        SHOP_SECRET,
      ),
    ).toEqual({ status: 200, body: { ok: true } })

    const forwarded = shopDoctor.requests.filter((request) => request.path.startsWith('/v1/handoffs/'))
    expect(forwarded.map((request) => [request.path, JSON.parse(request.body)])).toEqual([
      ['/v1/handoffs/7/accepted', { taskId: shopTask().taskId, agent: SHOP_AGENT }],
      ['/v1/handoffs/7/result', { taskId: shopTask().taskId, kind: 'done', commit: 'abc1234', deployed: true, version: 'v12' }],
    ])
    expect(blogDoctor.requests).toEqual([])
  })

  it('по случаю без задачи у моста — отказ; неверная подпись — отказ; врачу ничего', async () => {
    const { server } = await bridgeWithTask()
    expect(await signedPost(`${server.url}/v1/agent/accepted`, { app: 'shop', caseId: 99 }, SHOP_SECRET)).toEqual({
      status: 404,
      body: { error: 'unknown_task' },
    })
    expect(await signedPost(`${server.url}/v1/agent/accepted`, { app: 'blog', caseId: 7 }, BLOG_SECRET)).toEqual({
      status: 404,
      body: { error: 'unknown_task' },
    })
    expect((await signedPost(`${server.url}/v1/agent/accepted`, { app: 'shop', caseId: 7 }, 'wrong')).status).toBe(401)
    expect(shopDoctor.requests.filter((request) => request.path.startsWith('/v1/handoffs/'))).toEqual([])
  })

  it('«не смог» с длинной причиной — отказ; case отдаёт подробности врача', async () => {
    const { server } = await bridgeWithTask()
    const tooLong = await signedPost(
      `${server.url}/v1/agent/result`,
      { app: 'shop', caseId: 7, kind: 'cannot', reason: 'x'.repeat(1001) },
      SHOP_SECRET,
    )
    expect(tooLong).toEqual({ status: 400, body: { error: 'bad_request' } })

    const details = await signedPost(`${server.url}/v1/agent/case`, { app: 'shop', caseId: 7 }, SHOP_SECRET)
    expect(details).toEqual({ status: 200, body: { case: { id: 7 } } })
  })
})

describe('адрес', () => {
  it('слушает только заданный адрес частной сети', async () => {
    const { server } = await bridgeFor()
    expect(new URL(server.url).hostname).toBe('127.0.0.1')
  })

  it('отказывается слушать публичный адрес, все адреса сразу и имя хоста', async () => {
    const handler = async () => {}
    const publicIp = [8, 8, 8, 8].join('.')
    for (const host of ['203.0.113.7', '0.0.0.0', '::', 'bridge.example.com', publicIp]) {
      await expect(startBridgeServer({ listen: { host, port: 0 }, handler })).rejects.toThrow(/частн/)
    }
  })
})

describe('секрет', () => {
  it('не попадает в ответы и журнал', async () => {
    const entries: unknown[] = []
    const { createPaseoBridge } = await import('../server/index.js')
    const bridge = createPaseoBridge({
      config: makeConfig({ shop: shopDoctor.url, blog: blogDoctor.url }),
      paseo,
      stateFile: freshStateFile(),
      idlePollMs: 10,
      deliveryTimeoutMs: 2_000,
      log: (entry) => entries.push(entry),
    })
    const server = await startBridgeServer({ listen: { host: '127.0.0.1', port: 0 }, handler: bridge.handler })
    try {
      const responses = [
        await signedPost(`${server.url}/v1/tasks`, shopTask(), 'wrong'),
        await signedPost(`${server.url}/v1/tasks`, shopTask(), SHOP_SECRET),
        await signedPost(`${server.url}/v1/tasks`, shopTask({ app: 'stranger' }), SHOP_SECRET),
      ]
      await until(() => paseo.letters.length === 1)
      const everything = JSON.stringify([responses, entries, paseo.letters])
      expect(everything).not.toContain(SHOP_SECRET)
      expect(everything).not.toContain(BLOG_SECRET)
    } finally {
      await server.close()
      await bridge.dispose()
    }
  })
})
