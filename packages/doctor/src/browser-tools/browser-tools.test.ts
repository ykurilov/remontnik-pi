import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { RemontnikConfig } from '@ykurilov/remontnik-core/config'
import { afterEach, describe, expect, it } from 'vitest'
import type { Case } from '../case-book/index.js'
import { createMemoryRecordStore, type RecordStore } from '../records/index.js'
import { createReports } from '../reports/index.js'
import { testRemontnikConfig } from '../testing/index.js'
import {
  BROWSER_HUMAN_WAIT_MS,
  BROWSER_TOOL_NAMES,
  browserClientFromEnv,
  checkPages,
  createBrowserClient,
  createBrowserTools,
  liveLinkOf,
  runBrowserCommand,
  runHumanWait,
  takeCaseScreenshotsIn,
  withPageCheck,
  type BrowserAnswer,
  type BrowserClient,
  type BrowserToolsDeps,
  type CaseBrowser,
} from './index.js'

const PROFILE = 'remontnik'
const SITE = 'http://127.0.0.1:4100'
const LIVE_BASE = 'http://10.8.0.5:7701'
const REPORT_CASE = { caseId: 1, appName: 'patient', kind: 'manual' as const, where: '/chat', message: 'форма не отвечает' }

type BrowserSection = NonNullable<RemontnikConfig['browser']>

function configWith(browser: Partial<BrowserSection> | null): RemontnikConfig {
  const base: BrowserSection = { enabled: true, profile: PROFILE, allowedOrigins: [SITE], allowedMutations: [], pagesToCheck: [] }
  return testRemontnikConfig(browser === null ? {} : { browser: { ...base, ...browser } })
}

/** Служба браузера в памяти: отвечает по таблице, помнит вызовы. */
function fakeClient(answer: (command: string, input: Record<string, unknown>) => BrowserAnswer | Promise<BrowserAnswer>) {
  const calls: { command: string; input: Record<string, unknown> }[] = []
  const client: BrowserClient = {
    async call(command, input) {
      calls.push({ command, input })
      return answer(command, input)
    },
  }
  return { client, calls }
}

const snapshotOf = (text: string): BrowserAnswer => ({ ok: true, url: `${SITE}/chat`, title: 'Чат — Пациент', snapshot: text })

async function seededStore(): Promise<RecordStore> {
  const store = createMemoryRecordStore()
  await store.transaction(async (tx) => {
    await tx.doc<Case>('case', '1', { caseId: 1, reportIds: [] } as unknown as Case)
  })
  return store
}

function clock() {
  let now = 1_000_000
  return { now: () => now, sleep: async (ms: number) => void (now += ms), advance: (ms: number) => void (now += ms) }
}

function depsWith(client: BrowserClient | undefined, config: RemontnikConfig, extra: Partial<BrowserToolsDeps> = {}): BrowserToolsDeps {
  const time = clock()
  return {
    ...(client ? { client } : {}),
    loadConfig: async () => config,
    reports: createReports({ store: createMemoryRecordStore() }),
    sleep: time.sleep,
    pollMs: 1000,
    ...extra,
  }
}

async function run(deps: BrowserToolsDeps, store: RecordStore, command: string, input: Record<string, unknown> = {}, now = () => 1_000_000) {
  return runBrowserCommand(deps, { command, input }, { caseId: 1, reportCase: REPORT_CASE, records: store, now })
}

async function wait(deps: BrowserToolsDeps, store: RecordStore, now = () => 1_000_000, signal?: AbortSignal) {
  return runHumanWait(deps, { caseId: 1, reportCase: REPORT_CASE, records: store, now, ...(signal ? { signal } : {}) })
}

async function until(check: () => boolean): Promise<void> {
  while (!check()) await new Promise((resolve) => setTimeout(resolve, 1))
}

function takeCaseScreenshots(store: RecordStore): Promise<string[]> {
  return store.transaction((records) => takeCaseScreenshotsIn(records, 1))
}

describe('набор инструментов браузера', () => {
  it('постоянный: одни и те же имена при любой службе, включённой и нет', () => {
    const names = (deps?: BrowserToolsDeps) => createBrowserTools(deps).map((tool) => tool.name)
    expect(names()).toEqual([...BROWSER_TOOL_NAMES])
    expect(names(depsWith(fakeClient(() => snapshotOf('')).client, configWith({})))).toEqual([...BROWSER_TOOL_NAMES])
    expect(createBrowserTools().map((tool) => tool.description)).toEqual(createBrowserTools(depsWith(undefined, configWith(null))).map((tool) => tool.description))
    expect(BROWSER_TOOL_NAMES.every((name) => name.startsWith('browser_'))).toBe(true)
  })
})

describe('браузер недоступен — инструмент отвечает unavailable', () => {
  it.each([
    ['в настройке браузера нет', configWith(null), true],
    ['браузер выключен в настройке', configWith({ enabled: false }), true],
    ['у врача нет адреса и ключа службы', configWith({}), false],
  ])('%s', async (_name, config, withClient) => {
    const fake = fakeClient(() => snapshotOf('страница'))
    const answer = await run(depsWith(withClient ? fake.client : undefined, config), await seededStore(), 'read')
    expect(answer.isError).toBe(true)
    expect(answer.text).toContain('unavailable')
    expect(fake.calls).toEqual([])
  })

  it('служба не отвечает — unavailable от клиента уходит модели', async () => {
    const fake = fakeClient(() => ({ ok: false, code: 'unavailable', message: 'служба браузера не отвечает' }))
    const answer = await run(depsWith(fake.client, configWith({})), await seededStore(), 'read')
    expect(answer).toMatchObject({ isError: true })
    expect(answer.text).toContain('unavailable')
  })
})

describe('команды браузера', () => {
  it('профиль — только из настройки: модель его не выбирает', async () => {
    const fake = fakeClient(() => snapshotOf('e1 кнопка «Отправить»'))
    const answer = await run(depsWith(fake.client, configWith({})), await seededStore(), 'click', { ref: 'e1', danger: 'submit', profile: 'чужой' })
    expect(fake.calls).toEqual([{ command: 'click', input: { ref: 'e1', danger: 'submit', profile: PROFILE } }])
    expect(answer.isError).toBe(false)
    expect(answer.text).toContain('e1 кнопка «Отправить»')
    expect(answer.text).toContain(`${SITE}/chat`)
  })

  it('отказ службы — ошибка с кодом и причиной', async () => {
    const fake = fakeClient(() => ({ ok: false, code: 'refused_danger', message: 'оплата запрещена' }))
    const answer = await run(depsWith(fake.client, configWith({})), await seededStore(), 'click', { ref: 'e3', danger: 'pay' })
    expect(answer).toEqual({ isError: true, text: expect.stringContaining('refused_danger') })
    expect(answer.text).toContain('оплата запрещена')
  })

  it('снимки экрана копятся у случая и уходят в отчёт один раз, не больше 10', async () => {
    let n = 0
    const fake = fakeClient(() => ({ ok: true, path: `/data/shots/${PROFILE}-${++n}.jpg` }))
    const store = await seededStore()
    const deps = depsWith(fake.client, configWith({}))
    const first = await run(deps, store, 'shot')
    expect(first.text).toContain(`/data/shots/${PROFILE}-1.jpg`)
    for (let i = 0; i < 11; i += 1) await run(deps, store, 'shot')

    const taken = await store.transaction((tx) => takeCaseScreenshotsIn(tx, 1))
    expect(taken).toHaveLength(10)
    expect(taken.at(-1)).toBe(`/data/shots/${PROFILE}-12.jpg`)
    expect(await store.transaction((tx) => takeCaseScreenshotsIn(tx, 1))).toEqual([])
  })
})

describe('нужен человек: капча или код', () => {
  const liveConfig = configWith({ live: { enabled: true, linkEnv: 'REMONTNIK_LIVE_LINK' } })
  const liveEnv = { REMONTNIK_LIVE_LINK: `${LIVE_BASE}/` }

  it('ссылка на живой экран — только при включённом live и заданной переменной', () => {
    const browser = liveConfig.browser!
    expect(liveLinkOf(browser, liveEnv)).toBe(`${LIVE_BASE}/live?profile=${PROFILE}`)
    expect(liveLinkOf(browser, {})).toBeUndefined()
    expect(liveLinkOf({ ...browser, live: { enabled: false, linkEnv: 'REMONTNIK_LIVE_LINK' } }, liveEnv)).toBeUndefined()
    expect(liveLinkOf(configWith({}).browser!, liveEnv)).toBeUndefined()
  })

  it('отчёт needs_human со ссылкой; команда не ждёт, а зовёт browser_wait_human; владелец вернул управление → страница', async () => {
    let polls = 0
    const fake = fakeClient((command) => {
      if (command === 'url') return { ok: false, code: 'needs_human', message: 'капча на странице: нужен человек, браузер остановился' }
      if (command === 'status') return { ok: true, state: ++polls >= 3 ? 'ready' : 'needs_human' }
      if (command === 'read') return snapshotOf('Кабинет: вход выполнен')
      throw new Error(`неожиданная команда ${command}`)
    })
    const store = await seededStore()
    const reports = createReports({ store })
    let reported = 0
    const deps = depsWith(fake.client, liveConfig, { env: liveEnv, reports, onReport: () => void (reported += 1) })

    const stopped = await run(deps, store, 'url', { url: `${SITE}/captcha` })

    expect(stopped.isError).toBe(true)
    expect(stopped.text).toContain('browser_wait_human')
    expect(fake.calls.map((call) => call.command)).toEqual(['url'])
    const [report] = await reports.list({ after: 0, limit: 10 })
    expect(report).toMatchObject({ type: 'needs_human', caseId: 1, telegram: { state: 'pending' } })
    expect(report!.short).toContain(`${LIVE_BASE}/live?profile=${PROFILE}`)
    expect(report!.short).toContain('Вернуть')
    expect(reported).toBe(1)
    expect((await store.read<Case>('case', '1'))!.reportIds).toEqual([report!.reportId])

    const answer = await wait(deps, store)

    expect(answer.isError).toBe(false)
    expect(answer.text).toContain('вернул управление')
    expect(answer.text).toContain('Кабинет: вход выполнен')
    expect(fake.calls.map((call) => call.command)).toEqual(['url', 'status', 'status', 'status', 'read'])
    expect(await reports.list({ after: 0, limit: 10 })).toHaveLength(1)
    expect((await store.read<CaseBrowser>('case-browser', '1'))?.humanWait).toBeUndefined()
  })

  it('без живого экрана: отчёт без ссылки, врач не ждёт; повтор той же проверки — без второго отчёта', async () => {
    const fake = fakeClient(() => ({ ok: false, code: 'needs_human', message: 'поле одноразового кода: нужен человек' }))
    const store = await seededStore()
    const reports = createReports({ store })
    const deps = depsWith(fake.client, configWith({}), { env: liveEnv, reports })

    const first = await run(deps, store, 'url', { url: `${SITE}/confirm-code` })
    const second = await run(deps, store, 'read')

    expect(first).toMatchObject({ isError: true })
    expect(first.text).toContain('needs_human')
    expect(first.text).toContain('без браузера')
    expect(second.isError).toBe(true)
    expect(fake.calls.map((call) => call.command)).toEqual(['url', 'read'])
    const list = await reports.list({ after: 0, limit: 10 })
    expect(list).toHaveLength(1)
    expect(list[0]!.short).not.toContain('/live')
  })

  it('срок — от записанного момента проверки, а не от начала ожидания; после срока метка снята и новая капча — новый отчёт', async () => {
    const time = clock()
    const fake = fakeClient((command) => (command === 'status' ? { ok: true, state: 'needs_human' } : { ok: false, code: 'needs_human', message: 'капча' }))
    const store = await seededStore()
    const reports = createReports({ store })
    const deps = depsWith(fake.client, liveConfig, { env: liveEnv, reports, sleep: time.sleep, pollMs: 60_000 })
    await run(deps, store, 'url', { url: `${SITE}/captcha` }, time.now)
    time.advance(20 * 60_000)

    const answer = await wait(deps, store, time.now)

    expect(answer.isError).toBe(true)
    expect(answer.text).toContain('без браузера')
    // Опросы в минуты 20…30 от проверки: осталось 10 минут из 30, а не новые 30.
    expect(fake.calls.filter((call) => call.command === 'status')).toHaveLength(11)
    expect((await store.read<CaseBrowser>('case-browser', '1'))?.humanWait).toBeUndefined()

    await run(deps, store, 'url', { url: `${SITE}/captcha` }, time.now)
    expect((await reports.list({ after: 0, limit: 10 })).map((report) => report.type)).toEqual(['needs_human', 'needs_human'])
  })

  it('перезапуск посреди ожидания: повтор инструмента продолжает тот же срок, отчёт один', async () => {
    const time = clock()
    const restart = new AbortController()
    let polls = 0
    const fake = fakeClient((command) => {
      if (command !== 'status') return { ok: false, code: 'needs_human', message: 'капча' }
      if (++polls === 2) restart.abort()
      return { ok: true, state: 'needs_human' }
    })
    const store = await seededStore()
    const reports = createReports({ store })
    const deps = depsWith(fake.client, liveConfig, { env: liveEnv, reports, sleep: time.sleep, pollMs: 60_000 })
    await run(deps, store, 'url', { url: `${SITE}/captcha` }, time.now)

    await expect(wait(deps, store, time.now, restart.signal)).rejects.toThrow()
    time.advance(28 * 60_000)
    const answer = await wait(deps, store, time.now)

    expect(answer.text).toContain('без браузера')
    // До перезапуска — 2 опроса (минуты 0 и 1), после — минуты 29 и 30 до срока, а не ещё 30 минут.
    expect(polls).toBe(4)
    expect(await reports.list({ after: 0, limit: 10 })).toHaveLength(1)
  })

  it('пока ждём человека, другие команды в службу не идут: сначала browser_wait_human', async () => {
    const fake = fakeClient(() => ({ ok: false, code: 'needs_human', message: 'капча' }))
    const store = await seededStore()
    const deps = depsWith(fake.client, liveConfig, { env: liveEnv, reports: createReports({ store }) })
    await run(deps, store, 'url', { url: `${SITE}/captcha` })

    const answer = await run(deps, store, 'read')

    expect(answer.isError).toBe(true)
    expect(answer.text).toContain('browser_wait_human')
    expect(fake.calls.map((call) => call.command)).toEqual(['url'])
  })

  it('управление взял владелец сам — без отчёта; browser_wait_human ждёт и показывает страницу, когда вернули', async () => {
    let polls = 0
    const fake = fakeClient((command) => {
      if (command === 'click') return { ok: false, code: 'refused_human_control', message: 'управление у владельца' }
      if (command === 'status') return { ok: true, state: ++polls < 2 ? 'busy' : 'ready' }
      return snapshotOf('страница после владельца')
    })
    const store = await seededStore()
    const reports = createReports({ store })
    const deps = depsWith(fake.client, liveConfig, { env: liveEnv, reports })

    const stopped = await run(deps, store, 'click', { ref: 'e2', danger: 'none' })
    const answer = await wait(deps, store)

    expect(stopped.text).toContain('browser_wait_human')
    expect(answer.isError).toBe(false)
    expect(answer.text).toContain('страница после владельца')
    expect(await reports.list({ after: 0, limit: 10 })).toEqual([])
  })

  it('успех команды, начатой до капчи, метку не снимает; успех команды после капчи — снимает', async () => {
    const time = clock()
    let releaseRead = () => {}
    const fake = fakeClient((command) => {
      if (command === 'url') return { ok: false, code: 'needs_human', message: 'капча' }
      return new Promise<BrowserAnswer>((resolve) => (releaseRead = () => resolve(snapshotOf('страница'))))
    })
    const store = await seededStore()
    const deps = depsWith(fake.client, configWith({}), { reports: createReports({ store }) })
    const humanWait = async () => (await store.read<CaseBrowser>('case-browser', '1'))?.humanWait

    const slowRead = run(deps, store, 'read', {}, time.now)
    await until(() => fake.calls.length === 1)
    time.advance(1_000)
    await run(deps, store, 'url', { url: `${SITE}/captcha` }, time.now)
    releaseRead()
    await slowRead

    expect(await humanWait()).toBeDefined()
    time.advance(1_000)
    const laterRead = run(deps, store, 'read', {}, time.now)
    await until(() => fake.calls.length === 3)
    releaseRead()
    await laterRead
    expect(await humanWait()).toBeUndefined()
  })

  it('ждать нечего — browser_wait_human просто показывает страницу', async () => {
    const fake = fakeClient(() => snapshotOf('обычная страница'))
    const store = await seededStore()
    const answer = await wait(depsWith(fake.client, liveConfig, { env: liveEnv }), store)
    expect(answer.text).toContain('обычная страница')
    expect(fake.calls.map((call) => call.command)).toEqual(['read'])
  })
})

describe('что видит модель', () => {
  it('причина из ответа status доходит до модели', async () => {
    const fake = fakeClient(() => ({ ok: true, state: 'busy', reason: 'управление у владельца' }))
    const answer = await run(depsWith(fake.client, configWith({})), await seededStore(), 'read')
    expect(answer.text).toContain('Состояние: busy')
    expect(answer.text).toContain('управление у владельца')
  })

  it('пароль и кадры живого экрана из ответа службы не доходят до модели и отчёта', async () => {
    const leaks = { frame: 'data:image/jpeg;base64,/9j/4AAQSkZJRg', password: 'owner-pass-value-77', live: { frame: 'AAAAframe' } }
    const fake = fakeClient((command) =>
      command === 'read'
        ? { ...snapshotOf('Вход: поле пароля ••••••'), ...leaks }
        : { ok: false, code: 'needs_human', message: 'капча', ...leaks },
    )
    const store = await seededStore()
    const reports = createReports({ store })
    const deps = depsWith(fake.client, configWith({}), { reports })

    const page = await run(deps, store, 'read')
    const stopped = await run(deps, store, 'url', { url: `${SITE}/captcha` })

    const seen = [page.text, stopped.text, ...(await reports.list({ after: 0, limit: 10 })).flatMap((report) => [report.short, report.full ?? ''])]
    for (const text of seen) {
      expect(text).not.toContain('base64')
      expect(text).not.toContain('AAAAframe')
      expect(text).not.toContain('owner-pass-value-77')
    }
    expect(page.text).toContain('Вход: поле пароля ••••••')
  })

  it('опасное действие: отказ службы refused_danger доходит до модели как ошибка с причиной', async () => {
    const fake = fakeClient(() => ({ ok: false, code: 'refused_danger', message: 'оплата запрещена: кнопка «Оплатить тариф Про»' }))
    const store = await seededStore()
    const answer = await run(depsWith(fake.client, configWith({})), store, 'click', { ref: 'e7', danger: 'none' })
    expect(answer.isError).toBe(true)
    expect(answer.text).toContain('refused_danger')
    expect(answer.text).toContain('оплата запрещена')
    expect(await takeCaseScreenshots(store)).toEqual([])
  })
})

describe('проверка страниц после выкатки', () => {
  const pages = [{ url: `${SITE}/chat`, expectText: 'Чат готов' }, { url: `${SITE}/` }]

  it('страницы открылись и текст на месте — checked, снимки в отчёт', async () => {
    let n = 0
    const fake = fakeClient((command) => (command === 'shot' ? { ok: true, path: `/data/shots/p-${++n}.jpg` } : snapshotOf('Чат с ботом. Чат готов')))
    const check = await checkPages(fake.client, configWith({ pagesToCheck: pages }).browser)

    expect(check).toMatchObject({ status: 'checked', screenshots: ['/data/shots/p-1.jpg', '/data/shots/p-2.jpg'] })
    expect(fake.calls.filter((call) => call.command === 'url').map((call) => call.input)).toEqual(pages.map((page) => ({ profile: PROFILE, url: page.url })))
    const text = withPageCheck({ short: 'Выкатил.', full: 'Выкатил.' }, check)
    expect(text.short).toContain('Страницы проверил в браузере')
    expect(text.screenshots).toEqual(['/data/shots/p-1.jpg', '/data/shots/p-2.jpg'])
  })

  it('нужного текста нет — failed с адресом страницы', async () => {
    const fake = fakeClient((command) => (command === 'shot' ? { ok: true, path: '/data/shots/x.jpg' } : snapshotOf('Чат загружается…')))
    const check = await checkPages(fake.client, configWith({ pagesToCheck: [pages[0]!] }).browser)
    expect(check).toMatchObject({ status: 'failed', pages: [{ url: `${SITE}/chat`, ok: false }] })
    expect(withPageCheck({ short: 'Выкатил.', full: 'Выкатил.' }, check).short).toContain(`${SITE}/chat`)
  })

  it.each([
    ['служба не отвечает', fakeClient(() => ({ ok: false, code: 'unavailable', message: 'нет связи' })).client, {}],
    ['у врача нет службы', undefined, {}],
    ['браузер выключен в настройке', fakeClient(() => snapshotOf('')).client, { enabled: false }],
  ] as const)('%s — пометка «без проверки в браузере»', async (_name, client, browser) => {
    const check = await checkPages(client, configWith({ pagesToCheck: pages, ...browser }).browser)
    expect(check?.status).not.toBe('checked')
    const text = withPageCheck({ short: 'Выкатил.', full: 'Выкатил.' }, check)
    expect(text.short).toContain('без проверки в браузере')
    expect(text.full).toContain('без проверки в браузере')
  })

  it('служба упала посреди проверки: проверенные страницы сохранены, остальные — «не проверена»', async () => {
    const all = [...pages, { url: `${SITE}/cabinet` }]
    let opened = 0
    const fake = fakeClient((command) => {
      if (command === 'shot') return { ok: true, path: `/data/shots/p-${opened}.jpg` }
      return ++opened === 1 ? snapshotOf('Чат готов') : { ok: false, code: 'unavailable', message: 'служба браузера не отвечает' }
    })
    const check = await checkPages(fake.client, configWith({ pagesToCheck: all }).browser)

    expect(check).toMatchObject({
      status: 'unavailable',
      screenshots: ['/data/shots/p-1.jpg'],
      pages: [
        { url: `${SITE}/chat`, ok: true },
        { url: `${SITE}/`, ok: false, unchecked: true },
        { url: `${SITE}/cabinet`, ok: false, unchecked: true },
      ],
    })
    const text = withPageCheck({ short: 'Выкатил.', full: 'Выкатил.' }, check)
    expect(text.short).toContain('без проверки в браузере')
    expect(text.full).toContain(`${SITE}/chat: работает`)
    expect(text.full).toContain(`${SITE}/: не проверена`)
    expect(text.screenshots).toEqual(['/data/shots/p-1.jpg'])
  })

  it('браузера в настройке нет или страниц для проверки нет — проверки нет и пометки нет', async () => {
    expect(await checkPages(fakeClient(() => snapshotOf('')).client, undefined)).toBeUndefined()
    expect(await checkPages(fakeClient(() => snapshotOf('')).client, configWith({}).browser)).toBeUndefined()
    expect(withPageCheck({ short: 'Выкатил.', full: 'Выкатил.' }, undefined)).toEqual({ short: 'Выкатил.', full: 'Выкатил.' })
  })
})

describe('клиент службы браузера', () => {
  let server: Server | undefined
  afterEach(async () => {
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()))
    server = undefined
  })

  async function serve(handler: (request: IncomingMessage, body: string) => { status: number; body: string }): Promise<string> {
    server = createServer(async (request, response) => {
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(chunk as Buffer)
      const answer = handler(request, Buffer.concat(chunks).toString('utf8'))
      response.writeHead(answer.status, { 'content-type': 'application/json' })
      response.end(answer.body)
    })
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', () => resolve()))
    const address = server.address() as { port: number }
    return `http://127.0.0.1:${address.port}`
  }

  it('POST /v1/<команда> с ключом врача; ответ службы — как есть', async () => {
    const seen: { url?: string; auth?: string; body?: string } = {}
    const url = await serve((request, body) => {
      Object.assign(seen, { url: request.url, auth: request.headers.authorization, body })
      return { status: 200, body: JSON.stringify({ ok: true, snapshot: 'e1 ссылка' }) }
    })
    const answer = await createBrowserClient({ url, token: 'doctor-test-0123' }).call('read', { profile: PROFILE })
    expect(answer).toEqual({ ok: true, snapshot: 'e1 ссылка' })
    expect(seen).toEqual({ url: '/v1/read', auth: 'Bearer doctor-test-0123', body: JSON.stringify({ profile: PROFILE }) })
  })

  it('отказ службы с кодом — как есть', async () => {
    const url = await serve(() => ({ status: 200, body: JSON.stringify({ ok: false, code: 'refused_origin', message: 'чужой сайт' }) }))
    expect(await createBrowserClient({ url, token: 't' }).call('url', { profile: PROFILE, url: 'https://elsewhere.invalid' })).toEqual({
      ok: false,
      code: 'refused_origin',
      message: 'чужой сайт',
    })
  })

  it.each([
    ['неверный ключ', 401, JSON.stringify({ ok: false, code: 'unauthorized', message: 'нужен ключ врача' })],
    ['сбой службы', 500, 'не JSON'],
  ])('%s → unavailable', async (_name, status, body) => {
    const url = await serve(() => ({ status, body }))
    expect(await createBrowserClient({ url, token: 't' }).call('read', { profile: PROFILE })).toMatchObject({ ok: false, code: 'unavailable' })
  })

  it('служба не запущена → unavailable', async () => {
    const url = await serve(() => ({ status: 200, body: '{}' }))
    await new Promise<void>((resolve) => server!.close(() => resolve()))
    server = undefined
    expect(await createBrowserClient({ url, token: 't' }).call('read', { profile: PROFILE })).toMatchObject({ ok: false, code: 'unavailable' })
  })

  it('закрытие врача обрывает запрос сразу, а не по тайм-ауту: вызов бросает отмену', async () => {
    server = createServer(() => {})
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', () => resolve()))
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`
    const closing = new AbortController()
    setTimeout(() => closing.abort(new Error('врач закрывается')), 50)
    const startedAt = Date.now()
    await expect(createBrowserClient({ url, token: 't', timeoutMs: 10_000 }).call('status', { profile: PROFILE }, closing.signal)).rejects.toThrow('врач закрывается')
    expect(Date.now() - startedAt).toBeLessThan(5_000)
    server.closeAllConnections()
  })

  it('из окружения врача: без адреса или ключа клиента нет', () => {
    expect(browserClientFromEnv({})).toBeUndefined()
    expect(browserClientFromEnv({ REMONTNIK_BROWSER_URL: 'http://browser:7700' })).toBeUndefined()
    expect(browserClientFromEnv({ REMONTNIK_BROWSER_URL: 'http://browser:7700', REMONTNIK_BROWSER_TOKEN: 'x'.repeat(24) })).toBeDefined()
  })
})
