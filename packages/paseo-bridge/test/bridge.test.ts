import { chmodSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
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
  send,
  shopTask,
  signedGet,
  signedPost,
  signedPostRequest,
  startBridge,
  taskKeyFrom,
  until,
} from './bridge-world.js'

let shopDoctor: FakeDoctor
let blogDoctor: FakeDoctor
let paseo: FakePaseo
let running: Awaited<ReturnType<typeof startBridge>>[] = []
/** Ключ первой задачи: им агент подписывает свои команды (он в письме с задачей). */
const taskKey = () => taskKeyFrom(paseo.letters[0]!.text)

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

  it('приложение не из настройки моста — тот же отказ, что и при неверной подписи (имена не перебрать)', async () => {
    const { server } = await bridgeFor()
    const result = await signedPost(`${server.url}/v1/tasks`, shopTask({ app: 'stranger' }), SHOP_SECRET)
    expect(result).toEqual({ status: 401, body: { error: 'bad_signature' } })
    expect((await signedGet(server.url, '/health?app=stranger', SHOP_SECRET)).status).toBe(401)
    expect(paseo.letters).toEqual([])
  })

  it('подпись устарела — отказ', async () => {
    const { server } = await bridgeFor()
    const body = JSON.stringify(shopTask())
    const { signRequest } = await import('@ykurilov/remontnik-core/signed-http')
    const response = await fetch(`${server.url}/v1/tasks`, {
      method: 'POST',
      headers: signRequest({ method: 'POST', target: '/v1/tasks', body, secret: SHOP_SECRET, now: Date.now() - 60 * 60 * 1000 }),
      body,
    })
    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({ error: 'stale' })
  })

  it('запрос, подписанный до запуска моста, отвергается: после перезапуска память повторов пуста', async () => {
    const { server } = await bridgeFor()
    const body = JSON.stringify(shopTask())
    const { signRequest } = await import('@ykurilov/remontnik-core/signed-http')
    const response = await fetch(`${server.url}/v1/tasks`, {
      method: 'POST',
      headers: signRequest({ method: 'POST', target: '/v1/tasks', body, secret: SHOP_SECRET, now: Date.now() - 10_000 }),
      body,
    })
    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({ error: 'stale' })
    expect(paseo.letters).toEqual([])
  })

  it('подпись в верхнем регистре не принимается, повтор запроса по-прежнему отсекается', async () => {
    const { server } = await bridgeFor()
    const url = `${server.url}/v1/tasks`
    const request = signedPostRequest(url, shopTask(), SHOP_SECRET)
    const shouted = { ...request, headers: { ...request.headers, 'X-Remontnik-Signature': request.headers['X-Remontnik-Signature'].toUpperCase().replace('SHA256=', 'sha256=') } }
    expect(await send(url, shouted)).toEqual({ status: 401, body: { error: 'bad_signature' } })
    expect(await send(url, request)).toMatchObject({ status: 200 })
    expect(await send(url, request)).toEqual({ status: 401, body: { error: 'replayed' } })
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
    const { signRequest } = await import('@ykurilov/remontnik-core/signed-http')
    const replay = await fetch(`${server.url}/health?app=blog`, {
      headers: signRequest({ method: 'GET', target: '/health?app=shop', body: '', secret: BLOG_SECRET }),
    })
    expect(replay.status).toBe(401)
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
    paseo
      .lettersTo(SHOP_AGENT)
      .flatMap((text) => /Отчёт Ремонтника №(\d+)/.exec(text)?.[1] ?? [])
      .map(Number)

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

  it('отчёт с огромным номером или caseId: null не пересылается и курсор не портит', async () => {
    addReports(1)
    shopDoctor.reports.push(
      { reportId: Number.MAX_SAFE_INTEGER, caseId: 7, type: 'deployed', short: 'x', full: 'x', createdAt: '2026-10-26T10:00:00.000Z' },
      { reportId: 2, caseId: null as unknown as number, type: 'deployed', short: 'x', full: 'x', createdAt: '2026-10-26T10:00:00.000Z' },
    )
    const { bridge } = await bridgeFor()
    await bridge.pullReports('shop')
    expect(reportNumbers()).toEqual([1])
    shopDoctor.reports = shopDoctor.reports.filter((report) => report.reportId === 1)
    addReports(3)
    await bridge.pullReports('shop')
    expect(reportNumbers()).toEqual([1, 3])
  })

  it('ответ врача без верной подписи — отчёты не пересылаются', async () => {
    addReports(1, 2)
    const { bridge } = await bridgeFor()
    shopDoctor.answerSigning = 'foreign'
    await bridge.pullReports('shop')
    shopDoctor.answerSigning = 'none'
    await bridge.pullReports('shop')
    expect(reportNumbers()).toEqual([])
    shopDoctor.answerSigning = 'own'
    await bridge.pullReports('shop')
    expect(reportNumbers()).toEqual([1, 2])
  })

  it('не удалось записать курсор — отчёт не теряется', async () => {
    addReports(1)
    const stateFile = freshStateFile()
    const { bridge } = await bridgeFor(stateFile)
    chmodSync(dirname(stateFile), 0o500)
    try {
      await bridge.pullReports('shop')
    } finally {
      chmodSync(dirname(stateFile), 0o700)
    }
    expect(reportNumbers()).toEqual([])
    await bridge.pullReports('shop')
    expect(reportNumbers()).toEqual([1])
  })

  it('испорченный файл состояния — откладывается в .corrupt, курсор берётся из подтверждения врача, старые отчёты лавиной не уходят', async () => {
    addReports(1, 2, 3)
    shopDoctor.ackedBefore = 3
    const stateFile = freshStateFile()
    writeFileSync(stateFile, '{"tasks": [ обрыв')
    const started = await bridgeFor(stateFile)
    await started.bridge.pullReports('shop')
    expect(reportNumbers()).toEqual([])
    expect(readdirSync(dirname(stateFile)).some((name) => name.includes('.corrupt'))).toBe(true)
    expect(started.journal).toContainEqual(expect.objectContaining({ event: 'state_corrupt' }))
    expect(started.journal).toContainEqual(expect.objectContaining({ event: 'report_cursor_restored', app: 'shop', cursor: 3 }))
    addReports(4)
    await started.bridge.pullReports('shop')
    expect(reportNumbers()).toEqual([4])
  })

  it('испорченный файл состояния — отчёты, которые врач ещё не считает подтверждёнными, не теряются', async () => {
    addReports(1, 2, 3)
    shopDoctor.ackedBefore = 1
    const stateFile = freshStateFile()
    writeFileSync(stateFile, '{"tasks": [ обрыв')
    const started = await bridgeFor(stateFile)
    await started.bridge.pullReports('shop')
    expect(reportNumbers()).toEqual([2, 3])
  })

  it('испорченный файл состояния и старый врач без поля acked — пропуск до конца ленты, без лавины', async () => {
    addReports(1, 2, 3)
    shopDoctor.omitAckedField = true
    const stateFile = freshStateFile()
    writeFileSync(stateFile, '{"tasks": [ обрыв')
    const started = await bridgeFor(stateFile)
    await started.bridge.pullReports('shop')
    expect(reportNumbers()).toEqual([])
    addReports(4)
    await started.bridge.pullReports('shop')
    expect(reportNumbers()).toEqual([4])
  })

  it('врач отдаёт страницу, обрезанную по размеру, — мост продолжает, пока есть отчёты', async () => {
    addReports(1, 2, 3, 4, 5)
    shopDoctor.pageLimit = 2
    const { bridge } = await bridgeFor()
    await bridge.pullReports('shop')
    expect(reportNumbers()).toEqual([1, 2, 3, 4, 5])
    expect(shopDoctor.acked.at(-1)).toBe(5)
  })

  it('отчёт, который мост не принимает (слишком большой текст), пропускается: журнал, короткое письмо агенту, курсор идёт дальше', async () => {
    addReports(1, 2, 3)
    shopDoctor.reports[1]!.full = 'ы'.repeat(70 * 1024)
    const { bridge, journal } = await bridgeFor()
    await bridge.pullReports('shop')
    expect(reportNumbers()).toEqual([1, 3])
    const notices = paseo.lettersTo(SHOP_AGENT).filter((text) => text.includes('пропущен'))
    expect(notices).toHaveLength(1)
    expect(notices[0]).toContain('№2')
    expect(notices[0]).toContain('remontnik-doctor reports pull')
    expect(notices[0]).not.toContain('ы'.repeat(100))
    expect(journal).toContainEqual(expect.objectContaining({ event: 'report_skipped', app: 'shop', reportId: 2 }))
    expect(shopDoctor.acked.at(-1)).toBe(3)

    const lettersBefore = paseo.letters.length
    await bridge.pullReports('shop')
    expect(paseo.letters).toHaveLength(lettersBefore)
  })

  it('ответ врача больше предела моста — мост просит по одному отчёту, а непосильный пропускает', async () => {
    addReports(1, 2, 3)
    shopDoctor.reports[1]!.full = 'x'.repeat(300_000)
    const { bridge, journal } = await bridgeFor()
    await bridge.pullReports('shop')
    expect(reportNumbers()).toEqual([1, 3])
    expect(paseo.lettersTo(SHOP_AGENT).filter((text) => text.includes('пропущен') && text.includes('№2'))).toHaveLength(1)
    expect(journal).toContainEqual(expect.objectContaining({ event: 'report_skipped', reportId: 2 }))
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
    expect(await signedPost(`${server.url}/v1/agent/accepted`, { app: 'shop', caseId: 7 }, taskKey())).toEqual({
      status: 200,
      body: { ok: true },
    })
    expect(
      await signedPost(
        `${server.url}/v1/agent/result`,
        { app: 'shop', caseId: 7, kind: 'done', commit: 'abc1234', version: 'v12' },
        taskKey(),
      ),
    ).toEqual({ status: 200, body: { ok: true } })

    const forwarded = shopDoctor.requests.filter((request) => request.path.startsWith('/v1/handoffs/'))
    expect(forwarded.map((request) => [request.path, JSON.parse(request.body)])).toEqual([
      ['/v1/handoffs/7/accepted', { taskId: shopTask().taskId, agent: SHOP_AGENT }],
      ['/v1/handoffs/7/result', { taskId: shopTask().taskId, kind: 'done', commit: 'abc1234', deployed: true, version: 'v12' }],
    ])
    expect(blogDoctor.requests).toEqual([])
  })

  it('по отменённой задаче: accept и cannot — отказ, done — один раз (поздняя выкатка), повтор итога — отказ', async () => {
    const { server } = await bridgeWithTask()
    const taskId = shopTask().taskId
    await signedPost(`${server.url}/v1/tasks/${taskId}/cancel`, { app: 'shop', taskId, reason: 'work_timeout' }, SHOP_SECRET)

    expect(await signedPost(`${server.url}/v1/agent/accepted`, { app: 'shop', caseId: 7 }, taskKey())).toEqual({
      status: 409,
      body: { error: 'task_cancelled' },
    })
    expect(
      await signedPost(`${server.url}/v1/agent/result`, { app: 'shop', caseId: 7, kind: 'cannot', reason: 'x' }, taskKey()),
    ).toEqual({ status: 409, body: { error: 'task_cancelled' } })
    const done = { app: 'shop', caseId: 7, kind: 'done', version: 'v13' }
    expect(await signedPost(`${server.url}/v1/agent/result`, done, taskKey())).toEqual({ status: 200, body: { ok: true } })
    // Итог принят — ключ погашен: повтор уже не подписать.
    expect(await signedPost(`${server.url}/v1/agent/result`, done, taskKey())).toEqual({
      status: 401,
      body: { error: 'bad_signature' },
    })
    expect(shopDoctor.requests.filter((request) => request.path.startsWith('/v1/handoffs/')).map((r) => r.path)).toEqual([
      '/v1/handoffs/7/result',
    ])
  })

  it('по случаю без задачи у моста — отказ; неверная подпись — отказ; врачу ничего', async () => {
    const { server } = await bridgeWithTask()
    expect(await signedPost(`${server.url}/v1/agent/accepted`, { app: 'shop', caseId: 99 }, taskKey())).toEqual({
      status: 401,
      body: { error: 'bad_signature' },
    })
    expect(await signedPost(`${server.url}/v1/agent/accepted`, { app: 'blog', caseId: 7 }, taskKey())).toEqual({
      status: 401,
      body: { error: 'bad_signature' },
    })
    expect((await signedPost(`${server.url}/v1/agent/accepted`, { app: 'shop', caseId: 7 }, 'wrong')).status).toBe(401)
    expect(shopDoctor.requests.filter((request) => request.path.startsWith('/v1/handoffs/'))).toEqual([])
  })

  it('команды агента подписаны ключом задачи из письма, а не секретом моста: секрет агенту не нужен', async () => {
    const { server } = await bridgeWithTask()
    const letter = paseo.letters[0]!.text
    expect(letter).not.toContain(SHOP_SECRET)
    for (const command of ['accept 7', 'case 7', 'done 7', 'cannot 7']) expect(letter).toContain(`REMONTNIK_PASEO_KEY=${taskKey()} remontnik-paseo ${command}`)

    // Секрет моста на путях агента не годится: им подписывает только врач.
    expect(await signedPost(`${server.url}/v1/agent/accepted`, { app: 'shop', caseId: 7 }, SHOP_SECRET)).toEqual({
      status: 401,
      body: { error: 'bad_signature' },
    })
    // Ключ задачи не годится на путях врача и для другого случая.
    expect((await signedPost(`${server.url}/v1/tasks`, shopTask({ taskId: '01JBBBBBBBBBBBBBBBBBBBBBBB', caseId: 8 }), taskKey())).status).toBe(401)
    expect(await signedPost(`${server.url}/v1/tasks`, shopTask({ taskId: '01JBBBBBBBBBBBBBBBBBBBBBBB', caseId: 8 }), SHOP_SECRET)).toMatchObject({ status: 200 })
    await until(() => paseo.letters.length === 2)
    expect((await signedPost(`${server.url}/v1/agent/accepted`, { app: 'shop', caseId: 8 }, taskKey())).status).toBe(401)
    const secondKey = taskKeyFrom(paseo.letters[1]!.text)
    expect(secondKey).not.toBe(taskKey())
    expect(await signedPost(`${server.url}/v1/agent/accepted`, { app: 'shop', caseId: 8 }, secondKey)).toEqual({ status: 200, body: { ok: true } })
    expect(await signedPost(`${server.url}/v1/agent/accepted`, { app: 'shop', caseId: 7 }, taskKey())).toEqual({ status: 200, body: { ok: true } })
  })

  it('«не смог» с длинной причиной — отказ; case отдаёт подробности врача', async () => {
    const { server } = await bridgeWithTask()
    const tooLong = await signedPost(
      `${server.url}/v1/agent/result`,
      { app: 'shop', caseId: 7, kind: 'cannot', reason: 'x'.repeat(1001) },
      taskKey(),
    )
    expect(tooLong).toEqual({ status: 400, body: { error: 'bad_request' } })

    const details = await signedPost(`${server.url}/v1/agent/case`, { app: 'shop', caseId: 7 }, taskKey())
    expect(details).toEqual({ status: 200, body: { case: { id: 7 } } })
  })

  it('слишком большой ответ врача о случае — отказ, агенту не уходит', async () => {
    const { server } = await bridgeWithTask()
    shopDoctor.override = (method, path) =>
      method === 'GET' && path === '/v1/cases/7' ? { status: 200, body: { case: { id: 7, log: 'x'.repeat(300 * 1024) } } } : undefined
    expect(await signedPost(`${server.url}/v1/agent/case`, { app: 'shop', caseId: 7 }, taskKey())).toEqual({
      status: 502,
      body: { error: 'doctor_unreachable' },
    })
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

describe('подпись запроса и повторы', () => {
  it('подпись привязана к пути: подпись для одного адреса на другом не проходит', async () => {
    const { server } = await bridgeFor()
    await signedPost(`${server.url}/v1/tasks`, shopTask(), SHOP_SECRET)
    await until(() => paseo.letters.length === 1)
    const moved = await signedPost(`${server.url}/v1/agent/accepted`, { app: 'shop', caseId: 7 }, taskKey(), '/v1/agent/case')
    expect(moved).toEqual({ status: 401, body: { error: 'bad_signature' } })
    expect(shopDoctor.requests.filter((request) => request.path.startsWith('/v1/handoffs/'))).toEqual([])
  })

  it('тот же подписанный запрос второй раз — отказ replayed', async () => {
    const { server } = await bridgeFor()
    const url = `${server.url}/v1/agent/accepted`
    await signedPost(`${server.url}/v1/tasks`, shopTask(), SHOP_SECRET)
    await until(() => paseo.letters.length === 1)
    const request = signedPostRequest(url, { app: 'shop', caseId: 7 }, taskKey())
    expect(await send(url, request)).toEqual({ status: 200, body: { ok: true } })
    expect(await send(url, request)).toEqual({ status: 401, body: { error: 'replayed' } })
    expect(shopDoctor.requests.filter((r) => r.path === '/v1/handoffs/7/accepted')).toHaveLength(1)
  })

  it('мост подписывает запросы к врачу методом и путём и не верит неподписанным ответам', async () => {
    const { server } = await bridgeFor()
    await signedPost(`${server.url}/v1/tasks`, shopTask(), SHOP_SECRET)
    await until(() => paseo.letters.length === 1)
    shopDoctor.answerSigning = 'none'
    expect((await signedPost(`${server.url}/v1/agent/case`, { app: 'shop', caseId: 7 }, taskKey())).status).toBe(502)
    shopDoctor.answerSigning = 'foreign'
    expect((await signedPost(`${server.url}/v1/agent/case`, { app: 'shop', caseId: 7 }, taskKey())).status).toBe(502)
    expect(shopDoctor.requests.every((request) => request.signatureOk)).toBe(true)
  })

  it('врач отвечает перенаправлением — мост не идёт по нему с подписью', async () => {
    const elsewhere = new FakeDoctor(SHOP_SECRET)
    await elsewhere.start()
    try {
      const { server } = await bridgeFor()
      await signedPost(`${server.url}/v1/tasks`, shopTask(), SHOP_SECRET)
      await until(() => paseo.letters.length === 1)
      shopDoctor.override = () => ({ status: 307, body: {}, headers: { location: `${elsewhere.url}/v1/cases/7` } })
      expect(await signedPost(`${server.url}/v1/agent/case`, { app: 'shop', caseId: 7 }, taskKey())).toEqual({
        status: 502,
        body: { error: 'doctor_unreachable' },
      })
      expect(elsewhere.requests).toEqual([])
    } finally {
      await elsewhere.stop()
    }
  })
})

describe('гонки', () => {
  it('отмена, пока Paseo отправляет задачу: после отправки агенту уходит письмо «остановись»', async () => {
    let release!: () => void
    paseo.sendGate = new Promise((resolve) => (release = resolve))
    const { server } = await bridgeFor()
    await signedPost(`${server.url}/v1/tasks`, shopTask(), SHOP_SECRET)
    await until(() => paseo.sendsStarted === 1)

    const taskId = shopTask().taskId
    await signedPost(`${server.url}/v1/tasks/${taskId}/cancel`, { app: 'shop', taskId, reason: 'accept_timeout' }, SHOP_SECRET)
    paseo.sendGate = null
    release()

    await until(() => paseo.letters.length === 2)
    expect(paseo.letters[0]!.text).toContain('передаёт тебе случай')
    expect(paseo.letters[1]!.text).toContain('Остановись')
    expect((await signedPost(`${server.url}/v1/agent/accepted`, { app: 'shop', caseId: 7 }, taskKey())).status).toBe(409)
  })

  it('одна задача двумя запросами сразу — одно письмо', async () => {
    paseo.stateDelayMs = 30
    const { server } = await bridgeFor()
    const results = await Promise.all([
      signedPost(`${server.url}/v1/tasks`, shopTask(), SHOP_SECRET),
      signedPost(`${server.url}/v1/tasks`, shopTask(), SHOP_SECRET),
    ])
    expect(results).toEqual([
      { status: 200, body: { queued: true } },
      { status: 200, body: { queued: true } },
    ])
    await until(() => paseo.letters.length >= 1)
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(paseo.letters).toHaveLength(1)
  })
})

describe('устойчивость', () => {
  it('ошибка сервера после запуска пишется в журнал и не роняет процесс', async () => {
    const started = await bridgeFor()
    expect(() => started.server.node.emit('error', Object.assign(new Error('too many open files'), { code: 'EMFILE' }))).not.toThrow()
    expect(started.journal).toContainEqual(expect.objectContaining({ event: 'server_error', reason: 'too many open files' }))
  })
})
