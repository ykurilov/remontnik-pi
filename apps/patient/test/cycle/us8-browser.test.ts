import { execFile, execFileSync, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { startBrowserService } from '@ykurilov/remontnik-browser'
import { createIncidentEvent } from '@ykurilov/remontnik-core/incident'
import { startFakeTelegram, type FakeTelegramServer } from '@ykurilov/remontnik-core/testing'
import {
  createBrowserClient,
  createGitGuard,
  createLocalRunner,
  createServerDeployer,
  startDoctorService,
  type BrowserClient,
  type DoctorService,
  type DoctorServiceOptions,
} from '@ykurilov/remontnik-doctor'
import { callTool, createScriptedModel, testRemontnikConfig, type ScriptStep } from '@ykurilov/remontnik-doctor/testing'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

// История 8 на «Пациенте»: ошибка видна только в браузере — сервер здоров, а скрипт страницы чата ищет форму по
// неверному селектору. Врач открывает страницу своим браузером (настоящая служба с Chromium), видит, что чат не
// загрузился, чинит, выкатывает командами «Пациента» на папках и проверяет страницу из `pagesToCheck`.
// Без службы браузера цикл проходит так же, а отчёт о выкатке помечен «без проверки в браузере».

const patientRoot = fileURLToPath(new URL('../../', import.meta.url))
const PATIENT_FILES = ['src/bugs.ts', 'src/pages.ts', 'deploy/remontnik-deploy.ts']
const PAGES = 'src/pages.ts'
const NEW_TEST = 'test/chat-page.test.ts'
const DEPLOY_SCRIPT = 'deploy/remontnik-deploy.ts'
const PROFILE = 'remontnik'
const BROKEN_SELECTOR = "const formSelector = bug === 'page_error' ? '#chat-form-missing' : '#chat-form'"
const BROKEN_ALWAYS = "const formSelector = '#chat-form-missing'"

const PAGES_TEST = `import { test } from 'node:test'
import assert from 'node:assert/strict'
import { homePage } from '../src/pages.ts'
test('главная', () => assert.match(homePage(), /Пациент/))
`
const CHAT_PAGE_TEST = `import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chatPage } from '../src/pages.ts'
test('скрипт чата ищет настоящую форму', () => assert.doesNotMatch(chatPage(null), /chat-form-missing/))
`

type Wake = Parameters<NonNullable<DoctorServiceOptions['onWake']>>[0]
type TranscriptContext = Parameters<Extract<ScriptStep, (...args: never[]) => unknown>>[0]

const dirs: string[] = []
const cleanups: (() => Promise<void>)[] = []
let telegram: FakeTelegramServer

/** Chromium Playwright стоит там же, где его ищет служба браузера; нет — тест с настоящим браузером пропускается. */
const chromiumInstalled = await (async () => {
  const require = createRequire(join(patientRoot, '../../packages/browser/package.json'))
  const { chromium } = (await import(pathToFileURL(require.resolve('playwright-core')).href)) as { chromium: { executablePath(): string } }
  return existsSync(chromium.executablePath())
})()

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' } }).trim()
}

function write(root: string, path: string, content: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true })
  writeFileSync(join(root, path), content)
}

function deployCommand(deployRoot: string, command: string, cwd: string, env: Record<string, string> = {}): void {
  const result = spawnSync(process.execPath, [join(cwd, DEPLOY_SCRIPT), command], {
    cwd,
    env: { ...process.env, PATIENT_DEPLOY_ROOT: deployRoot, ...env },
    encoding: 'utf8',
  })
  if (result.status !== 0) throw new Error(`${command}: ${result.stdout}${result.stderr}`)
}

/** Копия страниц «Пациента» в своём репозитории; скрипт чата сломан всегда. Версия с ошибкой уже выкачена. */
function sickPatient() {
  const root = mkdtempSync(join(tmpdir(), 'remontnik-us8-'))
  dirs.push(root)
  const origin = join(root, 'origin.git')
  const repoDir = join(root, 'main')
  git(root, 'init', '--bare', '--initial-branch=main', origin)
  git(root, 'clone', origin, repoDir)
  git(repoDir, 'config', 'user.email', 'owner@example.com')
  git(repoDir, 'config', 'user.name', 'Owner')
  for (const file of PATIENT_FILES) {
    mkdirSync(dirname(join(repoDir, file)), { recursive: true })
    copyFileSync(join(patientRoot, file), join(repoDir, file))
  }
  const healthyPages = readFileSync(join(repoDir, PAGES), 'utf8')
  expect(healthyPages).toContain(BROKEN_SELECTOR)
  write(repoDir, PAGES, healthyPages.replace(BROKEN_SELECTOR, BROKEN_ALWAYS))
  write(repoDir, 'package.json', '{ "name": "patient-copy", "private": true, "type": "module" }\n')
  write(repoDir, '.gitignore', 'node_modules\n.remontnik/\n')
  write(repoDir, 'test/pages.test.ts', PAGES_TEST)
  git(repoDir, 'add', '-A')
  git(repoDir, 'commit', '-m', 'Пациент со сломанным чатом')
  git(repoDir, 'push', 'origin', 'main')
  const base = git(repoDir, 'rev-parse', 'HEAD')
  const deployRoot = join(root, 'server')
  deployCommand(deployRoot, 'build', repoDir, { REMONTNIK_VERSION: base })
  deployCommand(deployRoot, 'promote', repoDir)
  deployCommand(deployRoot, 'confirm', repoDir)
  return { root, origin, repoDir, base, healthyPages, deployRoot, stateDir: join(root, 'state'), worktreesDir: join(root, 'worktrees') }
}

type SickPatient = ReturnType<typeof sickPatient>

const renderChat = promisify(execFile)

/** «Сервер» «Пациента»: страница чата из работающей версии (`current`) — после выкатки она уже новая. */
async function servePatient(r: SickPatient): Promise<string> {
  const server = createServer((request, response) => {
    if (request.url !== '/chat') {
      response.writeHead(404).end()
      return
    }
    const pages = pathToFileURL(join(r.deployRoot, 'current', PAGES)).href
    renderChat(process.execPath, ['--input-type=module', '-e', 'import(process.argv[1]).then((m) => process.stdout.write(m.chatPage(null)))', pages])
      .then(({ stdout }) => response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(stdout))
      .catch(() => response.writeHead(500).end())
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  cleanups.push(() => new Promise((resolve) => server.close(() => resolve())))
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

/** Своя служба браузера на тест: свои данные и профиль, ходить можно только к «Пациенту». */
async function startBrowser(patientUrl: string): Promise<BrowserClient> {
  const dataDir = mkdtempSync(join(tmpdir(), 'remontnik-us8-browser-'))
  dirs.push(dataDir)
  const token = randomBytes(24).toString('hex')
  const service = await startBrowserService({
    token,
    vaultKey: randomBytes(32),
    dataDir,
    policy: { allowedOrigins: [patientUrl], allowedMutations: [], profiles: [{ name: PROFILE, viewport: { width: 1280, height: 800 } }] },
    listen: { host: '127.0.0.1', port: 0 },
    live: null,
    log: () => {},
  })
  cleanups.push(() => service.close())
  return createBrowserClient({ url: service.url, token })
}

/** Адрес, где никто не слушает: служба браузера выключена. */
async function deadUrl(): Promise<string> {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  await new Promise((resolve) => server.close(resolve))
  return `http://127.0.0.1:${port}`
}

function fakeClock() {
  let offset = 0
  return {
    now: () => Date.now() + offset,
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

async function startDoctor(r: SickPatient, patientUrl: string, steps: ScriptStep[], browser: BrowserClient): Promise<DoctorService> {
  const base = testRemontnikConfig()
  const config = testRemontnikConfig({
    app: { name: 'patient', timeZone: 'UTC' },
    repo: { mainBranch: 'main', mainline: 'merge' },
    workbench: { image: 'node:22', install: 'true', bashTimeoutMs: 60_000 },
    checks: { test: 'node --test test/*.test.ts' },
    evalScope: [],
    limits: { ...base.limits, diagnoseUsdPerCase: 1 },
    observe: { ...base.observe, windowMinutes: 2, healthWindowTicks: 3 },
    deploy: {
      commands: {
        build: `node ${DEPLOY_SCRIPT} build`,
        promote: `node ${DEPLOY_SCRIPT} promote`,
        confirm: `node ${DEPLOY_SCRIPT} confirm`,
        rollback: `node ${DEPLOY_SCRIPT} rollback`,
        current: `node ${DEPLOY_SCRIPT} current`,
        health: `node ${DEPLOY_SCRIPT} health`,
      },
      buildEnv: ['PATIENT_DEPLOY_ROOT'],
      lockFile: '.remontnik/deploy.lock',
    },
    browser: {
      enabled: true,
      profile: PROFILE,
      allowedOrigins: [patientUrl],
      allowedMutations: [],
      pagesToCheck: [{ url: `${patientUrl}/chat`, expectText: 'Чат готов' }],
    },
  })
  const model = createScriptedModel()
  model.script(...steps)
  const guard = createGitGuard({ repoDir: r.repoDir, worktreesDir: r.worktreesDir, mainBranch: 'main', mainline: 'merge', author: { name: 'Ремонтник', email: 'doctor@example.invalid' } })
  const loadConfig = async () => config
  const clock = fakeClock()
  const doctor = await startDoctorService({
    stateDir: r.stateDir,
    sharedSecret: 'shared-test-secret',
    listen: { host: '127.0.0.1', port: 0 },
    telegram: { botToken: '123456:test-bot-token', chatId: 'owner-chat', apiBaseUrl: telegram.baseUrl },
    exit: () => {},
    log: () => {},
    now: clock.now,
    onWake: (wake, resume) => clock.onWake(wake, resume),
    treatment: {
      guard,
      loadConfig,
      worktreesDir: r.worktreesDir,
      models: model.models,
      model: model.model,
      evalEnv: {},
      runner: createLocalRunner(),
      allowUnisolatedRunner: true,
      deployer: createServerDeployer({ guard, loadConfig, env: { ...process.env, PATIENT_DEPLOY_ROOT: r.deployRoot } }),
      browser: { client: browser },
    },
  })
  cleanups.push(() => doctor.close())
  return doctor
}

function brokenChat() {
  return createIncidentEvent({
    appName: 'patient',
    kind: 'manual',
    where: '/chat',
    message: 'В чате не отправляются сообщения',
    occurredAt: new Date(),
  })
}

async function settledCase(doctor: DoctorService, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const found = await doctor.caseBook.getCase(1)
    if (found && ['healed', 'rolled_back', 'not_helped', 'report_only', 'needs_human', 'no_cause_found', 'stand_broken'].includes(found.state)) return found
    if (Date.now() > deadline) throw new Error(`случай не закончился: ${found?.state}`)
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

/** Что модель получила последним ответом инструмента. */
function lastToolText(context: TranscriptContext): string {
  const result = context.messages.findLast((message) => message.role === 'toolResult')
  if (!result || result.role !== 'toolResult') return ''
  return result.content.map((part) => (part.type === 'text' ? part.text : '')).join('')
}

/** Сценарий модели: посмотреть страницу браузером, найти селектор в коде, починить и добавить тест. */
function cure(r: SickPatient, patientUrl: string, seen: string[]): ScriptStep[] {
  return [
    callTool('browser_url', { url: `${patientUrl}/chat` }),
    (context) => {
      seen.push(lastToolText(context))
      return callTool('browser_shot', {})
    },
    (context) => {
      seen.push(lastToolText(context))
      return callTool('read', { path: PAGES })
    },
    callTool('finish_diagnosis', {
      found: true,
      cause: 'Скрипт чата ищет форму #chat-form-missing, её нет: обработчик не вешается, чат не загружается',
      evidence: ['Браузер: на /chat висит «Чат загружается…»', `${PAGES}: formSelector = '#chat-form-missing'`],
      confidence: 'high',
    }),
    callTool('write', { path: PAGES, content: r.healthyPages }),
    callTool('write', { path: NEW_TEST, content: CHAT_PAGE_TEST }),
    callTool('finish_fix', { summary: 'Скрипт чата ищет настоящую форму #chat-form', testsAdded: [NEW_TEST] }),
  ]
}

beforeEach(async () => {
  telegram = await startFakeTelegram()
})

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  await telegram.close()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('история 8 на «Пациенте»: браузер врача', () => {
  it.skipIf(!chromiumInstalled)('ошибка только на странице: браузер её видит, после выкатки страница работает, снимки в отчётах', async () => {
    const r = sickPatient()
    const patientUrl = await servePatient(r)
    const seen: string[] = []
    const doctor = await startDoctor(r, patientUrl, cure(r, patientUrl, seen), await startBrowser(patientUrl))

    await doctor.receiveEvents([brokenChat()])
    const healed = await settledCase(doctor)

    expect(healed.state).toBe('healed')
    // До правки: сервер отдаёт страницу, но скрипт падает — чат не загрузился.
    expect(seen[0]).toContain('Чат загружается…')
    expect(seen[0]).not.toContain('Чат готов')
    expect(seen[1]).toContain('Снимок экрана')
    expect(readFileSync(join(r.deployRoot, 'current', PAGES), 'utf8')).toBe(r.healthyPages)
    const reports = await doctor.reports.list({ after: 0, limit: 20 })
    const deployed = reports.find((report) => report.short.includes('Страницы проверил в браузере'))
    expect(deployed?.type).toBe('deployed')
    expect(deployed?.full).toContain(`${patientUrl}/chat: работает`)
    const shots = reports.flatMap((report) => report.screenshots ?? [])
    // Снимок диагноза и снимок проверки страницы после выкатки — каждый в отчёте один раз.
    expect(shots).toHaveLength(2)
    expect(new Set(shots).size).toBe(2)
    for (const shot of shots) expect(existsSync(shot)).toBe(true)
    expect(reports.some((report) => report.short.includes('без проверки в браузере'))).toBe(false)
  }, 180_000)

  it('служба браузера выключена: инструменты отвечают «недоступен», цикл проходит с пометкой «без проверки в браузере»', async () => {
    const r = sickPatient()
    const patientUrl = await servePatient(r)
    const seen: string[] = []
    const offline = createBrowserClient({ url: await deadUrl(), token: 'doctor-test-token-0123' })
    const steps = cure(r, patientUrl, seen)
    const doctor = await startDoctor(r, patientUrl, steps, offline)

    await doctor.receiveEvents([brokenChat()])
    const healed = await settledCase(doctor)

    expect(healed.state).toBe('healed')
    expect(seen[0]).toContain('unavailable')
    expect(readFileSync(join(r.deployRoot, 'current', PAGES), 'utf8')).toBe(r.healthyPages)
    const reports = await doctor.reports.list({ after: 0, limit: 20 })
    const deployed = reports.find((report) => report.type === 'deployed' && report.short.includes('без проверки в браузере'))
    expect(deployed).toBeDefined()
    expect(reports.flatMap((report) => report.screenshots ?? [])).toEqual([])
  }, 120_000)
})
