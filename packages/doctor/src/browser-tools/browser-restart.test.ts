import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { Wake } from '@earendil-works/pi-durable'
import type { RemontnikConfig } from '@ykurilov/remontnik-core/config'
import { createIncidentEvent } from '@ykurilov/remontnik-core/incident'
import { startFakeTelegram, type FakeTelegramServer } from '@ykurilov/remontnik-core/testing'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { CaseState } from '../case-book/index.js'
import { createDeployer, createDeployLock, type Deployer } from '../deployer/index.js'
import { createGitGuard, GitGuardError, type GitGuard } from '../git-guard/index.js'
import { startDoctorService, type DoctorService } from '../service/index.js'
import { testRemontnikConfig } from '../testing/config.js'
import { createFakeDeployApp, type FakeDeployApp } from '../testing/fake-deploy-app.js'
import { callTool, createScriptedModel, hang, type ScriptedModel } from '../testing/scripted-model.js'
import { createLocalRunner } from '../workbench/index.js'
import type { BrowserAnswer, BrowserClient } from './index.js'

// Перезапуск врача посреди работы браузера: ожидание человека продолжается с записанного срока, проверка страниц
// после выкатки не задваивает отчёт и снимки. Служба браузера подставная, модель по сценарию, git настоящий.

const BUGGY = `const PLANS = { start: 990, pro: 2990 }
export const DEFAULT_PLAN = 'starter'
export function price(plan = DEFAULT_PLAN) {
  const value = PLANS[plan]
  if (value === undefined) throw new Error('нет тарифа ' + plan)
  return value
}
`
const FIXED = BUGGY.replace("'starter'", "'start'")
const NEW_TEST = `import { test } from 'node:test'
import assert from 'node:assert/strict'
import { price } from '../src/price.mjs'
test('цена тарифа по умолчанию', () => assert.equal(price(), 990))
`
const SITE = 'http://127.0.0.1:4100'
const LIVE_ENV = { REMONTNIK_LIVE_LINK: 'http://10.8.0.5:7701' }
// Кадр живого экрана и пароль: служба не должна их присылать, а если пришлёт — дальше врача они не идут.
const LEAKS = { frame: 'data:image/jpeg;base64,/9j/4AAQSkZJRg', password: 'owner-pass-value-77' }
const FINAL_STATES: CaseState[] = ['healed', 'rolled_back', 'not_helped', 'report_only', 'needs_human', 'no_cause_found', 'stand_broken']

const dirs: string[] = []
const cleanups: (() => Promise<void>)[] = []
let telegram: FakeTelegramServer

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' } }).trim()
}

function repo() {
  const root = mkdtempSync(join(tmpdir(), 'remontnik-browser-restart-'))
  dirs.push(root)
  const origin = join(root, 'origin.git')
  const repoDir = join(root, 'main')
  git(root, 'init', '--bare', '--initial-branch=main', origin)
  git(root, 'clone', origin, repoDir)
  git(repoDir, 'config', 'user.email', 'owner@example.com')
  git(repoDir, 'config', 'user.name', 'Owner')
  const files: Record<string, string> = {
    '.gitignore': 'node_modules\n.remontnik/\n',
    'src/price.mjs': BUGGY,
    'test/price.test.mjs': `import { test } from 'node:test'\nimport assert from 'node:assert/strict'\nimport { price } from '../src/price.mjs'\ntest('тариф pro', () => assert.equal(price('pro'), 2990))\n`,
  }
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(repoDir, path)), { recursive: true })
    writeFileSync(join(repoDir, path), content)
  }
  git(repoDir, 'add', '-A')
  git(repoDir, 'commit', '-m', 'начало')
  git(repoDir, 'push', 'origin', 'main')
  const base = git(repoDir, 'rev-parse', 'HEAD')
  return { root, origin, repoDir, base, stateDir: join(root, 'state'), worktreesDir: join(root, 'worktrees'), lockPath: join(repoDir, '.remontnik', 'deploy.lock') }
}

type Repo = ReturnType<typeof repo>

/** Часы врача: идут как настоящие, перескакивают на пробуждение спящей задачи; `advance` — прошло время, пока врач лежал. */
function fakeClock() {
  let offset = 0
  return {
    now: () => Date.now() + offset,
    advance: (ms: number) => void (offset += ms),
    onWake(wake: Wake, resume: () => void) {
      if (wake.active || wake.at === undefined) return
      const at = wake.at
      setImmediate(() => {
        offset += Math.max(0, at - (Date.now() + offset))
        resume()
      })
    },
  }
}

type Clock = ReturnType<typeof fakeClock>

/** Служба браузера в памяти: отвечает по таблице, помнит команды. */
function fakeBrowser(answer: (command: string, input: Record<string, unknown>) => BrowserAnswer | Promise<BrowserAnswer>) {
  const calls: string[] = []
  const client: BrowserClient = {
    async call(command, input) {
      calls.push(command)
      return answer(command, input)
    },
  }
  return { client, calls }
}

function browserConfig(pagesToCheck: { url: string; expectText?: string }[] = []): NonNullable<RemontnikConfig['browser']> {
  return {
    enabled: true,
    profile: 'remontnik',
    allowedOrigins: [SITE],
    allowedMutations: [],
    pagesToCheck,
    live: { enabled: true, linkEnv: 'REMONTNIK_LIVE_LINK' },
  }
}

interface DoctorRun {
  model: ScriptedModel
  browser: BrowserClient
  clock: Clock
  deployApp?: FakeDeployApp
  pagesToCheck?: { url: string; expectText?: string }[]
  log?: string[]
}

async function startDoctor(r: Repo, setup: DoctorRun): Promise<DoctorService> {
  const base = testRemontnikConfig()
  const config = testRemontnikConfig({
    repo: { mainBranch: 'main', mainline: 'merge' },
    workbench: { image: 'node:22', install: 'true', bashTimeoutMs: 30_000 },
    checks: { test: 'node --test test/*.test.mjs' },
    evalScope: [],
    limits: { ...base.limits, diagnoseUsdPerCase: 1 },
    observe: { ...base.observe, windowMinutes: 2, healthWindowTicks: 3 },
    browser: browserConfig(setup.pagesToCheck),
  })
  const guard: GitGuard = createGitGuard({
    repoDir: r.repoDir,
    worktreesDir: r.worktreesDir,
    mainBranch: 'main',
    mainline: 'merge',
    author: { name: 'Ремонтник', email: 'doctor@example.invalid' },
  })
  const loadConfig = async () => config
  const app = setup.deployApp
  const deployer: Deployer | undefined = app
    ? createDeployer({
        loadConfig,
        commandsFor: () => app.commands,
        mainCopyFor: () => app.mainCopy,
        lockFor: () => createDeployLock(r.lockPath),
        async tagPreDeploy(name, version) {
          try {
            await guard.tagPreDeploy(name, version)
            return { ok: true }
          } catch (error) {
            if (error instanceof GitGuardError) return { ok: false, reason: error.message }
            throw error
          }
        },
      })
    : undefined
  const service = await startDoctorService({
    stateDir: r.stateDir,
    sharedSecret: 'shared-test-secret',
    listen: { host: '127.0.0.1', port: 0 },
    telegram: { botToken: '123456:test-bot-token', chatId: 'owner-chat', apiBaseUrl: telegram.baseUrl },
    exit: () => {},
    log: (line) => void setup.log?.push(line),
    now: setup.clock.now,
    onWake: (wake, resume) => setup.clock.onWake(wake, resume),
    treatment: {
      guard,
      loadConfig,
      ...(app ? { currentVersion: async () => app.running ?? undefined, deployer } : {}),
      worktreesDir: r.worktreesDir,
      models: setup.model.models,
      model: setup.model.model,
      runner: createLocalRunner(),
      allowUnisolatedRunner: true,
      browser: { client: setup.browser, env: LIVE_ENV, pollMs: 20 },
    },
  })
  cleanups.push(() => service.close())
  return service
}

function priceCrash() {
  return createIncidentEvent({
    appName: 'test-app',
    kind: 'crash',
    where: 'src/price.mjs:5:35',
    message: 'нет тарифа starter',
    stack: 'Error: нет тарифа starter\n    at price (src/price.mjs:5:35)',
    context: { processName: 'web' },
    occurredAt: new Date(),
  })
}

async function until(check: () => boolean | Promise<boolean>, what: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`не дождался: ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

async function settledCase(service: DoctorService) {
  let state: CaseState | undefined
  await until(async () => {
    state = (await service.caseBook.getCase(1))?.state
    return state !== undefined && FINAL_STATES.includes(state)
  }, 'итог случая', 60_000)
  return state
}

const giveUp = () => callTool('finish_diagnosis', { found: false, cause: 'страница не проверена', evidence: ['браузер'], confidence: 'low' })

const typesOf = async (doctor: DoctorService) => (await doctor.reports.list({ after: 0, limit: 50 })).map((report) => report.type)

/** Всё, что врач кому-то показал: отчёты, запросы к модели, журнал. */
async function everythingSeen(doctor: DoctorService, models: ScriptedModel[], log: string[]): Promise<string> {
  const reports = await doctor.reports.list({ after: 0, limit: 50 })
  return JSON.stringify([reports, models.map((model) => model.requests), log])
}

beforeEach(async () => {
  telegram = await startFakeTelegram()
})

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  await telegram.close()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('перезапуск врача посреди ожидания человека', () => {
  it('ожидание продолжается после перезапуска; владелец вернул управление — модель видит страницу; отчёт один; пароль и кадры никуда не попали; danger — отказ', async () => {
    const r = repo()
    const clock = fakeClock()
    const log: string[] = []
    let ownerReturned = false
    let statusPolls = 0
    const browser = fakeBrowser((command) => {
      if (command === 'url') return { ok: false, code: 'needs_human', message: 'капча на странице: нужен человек', ...LEAKS }
      if (command === 'status') {
        statusPolls += 1
        return { ok: true, state: ownerReturned ? 'ready' : 'needs_human', ...LEAKS }
      }
      if (command === 'read') return { ok: true, url: `${SITE}/cabinet`, snapshot: 'Кабинет: вход выполнен', ...LEAKS }
      if (command === 'click') return { ok: false, code: 'refused_danger', message: 'оплата запрещена: кнопка «Оплатить тариф»' }
      throw new Error(`неожиданная команда ${command}`)
    })
    const first = createScriptedModel()
    first.script(callTool('browser_url', { url: `${SITE}/captcha` }), callTool('browser_wait_human', {}), hang)
    const firstDoctor = await startDoctor(r, { model: first, browser: browser.client, clock, log })
    await firstDoctor.receiveEvents([priceCrash()])
    await until(() => statusPolls >= 2, 'врач ждёт человека')
    await cleanups.pop()!()

    ownerReturned = true
    const second = createScriptedModel()
    second.script(callTool('browser_click', { ref: 'e7', danger: 'none' }), giveUp())
    const doctor = await startDoctor(r, { model: second, browser: browser.client, clock, log })
    expect(await settledCase(doctor)).toBe('no_cause_found')

    expect((await typesOf(doctor)).filter((type) => type === 'needs_human')).toHaveLength(1)
    const afterWait = JSON.stringify(second.requests[0]!.messages.at(-1))
    expect(afterWait).toContain('вернул управление')
    expect(afterWait).toContain('Кабинет: вход выполнен')
    const afterClick = JSON.stringify(second.requests[1]!.messages.at(-1))
    expect(afterClick).toContain('refused_danger')
    expect(afterClick).toContain('оплата запрещена')
    const seen = await everythingSeen(doctor, [first, second], log)
    expect(seen).not.toContain('base64')
    expect(seen).not.toContain(LEAKS.password)
  }, 90_000)

  it('срок не обнуляется: врач лежал дольше 30 минут — после перезапуска сразу «без браузера», метка снята, новая капча — новый отчёт', async () => {
    const r = repo()
    const clock = fakeClock()
    let statusPolls = 0
    const browser = fakeBrowser((command) => {
      if (command === 'status') {
        statusPolls += 1
        return { ok: true, state: 'needs_human' }
      }
      return { ok: false, code: 'needs_human', message: 'капча на странице: нужен человек' }
    })
    const first = createScriptedModel()
    first.script(callTool('browser_url', { url: `${SITE}/captcha` }), callTool('browser_wait_human', {}), hang)
    const firstDoctor = await startDoctor(r, { model: first, browser: browser.client, clock })
    await firstDoctor.receiveEvents([priceCrash()])
    await until(() => statusPolls >= 2, 'врач ждёт человека')
    await cleanups.pop()!()

    clock.advance(31 * 60_000)
    const pollsBeforeRestart = statusPolls
    const second = createScriptedModel()
    second.script(callTool('browser_url', { url: `${SITE}/captcha` }), giveUp())
    const doctor = await startDoctor(r, { model: second, browser: browser.client, clock })
    expect(await settledCase(doctor)).toBe('no_cause_found')

    expect(JSON.stringify(second.requests[0]!.messages.at(-1))).toContain('не вернул управление')
    expect(statusPolls - pollsBeforeRestart).toBeLessThanOrEqual(1)
    expect((await typesOf(doctor)).filter((type) => type === 'needs_human')).toHaveLength(2)
  }, 90_000)
})

describe('перезапуск врача посреди проверки страниц после выкатки', () => {
  it('отчёт о выкатке один, снимки страниц без потерь и дублей', async () => {
    const r = repo()
    const clock = fakeClock()
    const app = createFakeDeployApp({ running: r.base })
    const pages = [{ url: `${SITE}/chat`, expectText: 'Чат готов' }, { url: `${SITE}/` }]
    let run = 1
    let opened = 0
    let closing: Promise<void> | undefined
    const browser = fakeBrowser(async (command) => {
      if (command === 'shot') return { ok: true, path: `/data/shots/run${run}-${opened}.jpg` }
      opened += 1
      if (run === 1 && opened === 2) {
        // Врач закрывается, пока служба открывает вторую страницу.
        closing = cleanups.pop()!()
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
      return { ok: true, url: SITE, snapshot: 'Чат готов' }
    })
    const model = createScriptedModel()
    model.script(
      callTool('read', { path: 'src/price.mjs' }),
      callTool('finish_diagnosis', { found: true, cause: 'Тариф starter не существует', evidence: ['src/price.mjs'], confidence: 'high' }),
      callTool('write', { path: 'src/price.mjs', content: FIXED }),
      callTool('write', { path: 'test/default-plan.test.mjs', content: NEW_TEST }),
      callTool('finish_fix', { summary: 'Тариф по умолчанию — start', testsAdded: ['test/default-plan.test.mjs'] }),
    )
    const firstDoctor = await startDoctor(r, { model, browser: browser.client, clock, deployApp: app, pagesToCheck: pages })
    await firstDoctor.receiveEvents([priceCrash()])
    await until(() => closing !== undefined, 'проверка страниц началась')
    await closing

    run = 2
    opened = 0
    const doctor = await startDoctor(r, { model: createScriptedModel(), browser: browser.client, clock, deployApp: app, pagesToCheck: pages })
    expect(await settledCase(doctor)).toBe('healed')

    // Отчётов `deployed` два: «выкатил, наблюдаю» с проверкой страниц и итог «правка держится».
    const reports = await doctor.reports.list({ after: 0, limit: 50 })
    const deployed = reports.filter((report) => report.type === 'deployed' && report.short.includes('наблюдаю'))
    expect(deployed).toHaveLength(1)
    expect(deployed[0]!.short).toContain('Страницы проверил')
    expect(reports.filter((report) => report.short.includes('Страницы проверил'))).toHaveLength(1)
    const shots = deployed[0]!.screenshots ?? []
    expect(shots).toHaveLength(2)
    expect(new Set(shots).size).toBe(2)
    // Закрытие оборвало первую проверку: снимки — из одной, повторной, проверки, а не смесь двух.
    expect(shots.every((shot) => shot.includes('/run2-'))).toBe(true)
  }, 120_000)
})
