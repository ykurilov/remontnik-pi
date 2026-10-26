import { execFileSync, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createCaseBook } from '../../src/case-book/index.js'
import { openDoctorHarness } from '../../src/service/harness.js'

// Живой цикл целиком (quickstart, раздел 6): образы врача, браузера и верстака собираются на настоящем Docker,
// «Пациент» со сторожем работает в контейнере, врач лечит его настоящей моделью (DeepSeek, запасной путь — OpenRouter).
// Случай crash: вопрос о цене без названия тарифа валит ответ → сторож шлёт тревогу и случай врачу → правка
// с тестом в верстаке → выкатка командами «Пациента» → проверка страницы в браузере → окно наблюдения → `healed`.
// Отчёты видны в подставном Telegram и в очереди Paseo (`remontnik-doctor reports pull`).
// Платный: потолок модели врача в настройке — $1 в сутки. Без Docker или ключей пропускается.
// Запуск: DEEPSEEK_API_KEY=… OPENROUTER_API_KEY=… pnpm exec vitest run -c vitest.live.config.ts packages/doctor/test/live/crash-cycle.live.test.ts
// REMONTNIK_KEEP_STACK=1 — оставить стенд для разбора руками.

const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url))
const patientRoot = join(repoRoot, 'apps/patient')
const composeFile = join(repoRoot, 'deploy/compose.remontnik.yml')
const PROJECT = 'remontnik-crash'
const TAG = 'live-test'
const APP_NETWORK = 'remontnik-crash-app'
const PATIENT = 'remontnik-crash-patient'
const TELEGRAM = 'remontnik-crash-telegram'
const PATIENT_URL = `http://${PATIENT}:3000`
const PRICE_QUESTION = 'Сколько стоит подписка?'
const PLANS = 'src/bot/plans.ts'
const WATCH_BOT_TOKEN = '111111:watch-bot'
const DOCTOR_BOT_TOKEN = '222222:doctor-bot'
const FAILED_REPORTS = ['rolled_back', 'not_helped', 'needs_human', 'no_cause_found', 'budget_reached', 'stand_broken', 'doctor_problem']
const CASE_TIMEOUT_MS = 20 * 60_000

const deepseekKey = process.env.DEEPSEEK_API_KEY?.trim()
const openRouterKey = process.env.OPENROUTER_API_KEY?.trim()
const dockerReady = spawnSync('docker', ['info'], { stdio: 'ignore' }).status === 0

const BOT_TEST = `import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createBot } from '../src/bot/bot.ts'
test('приветствие', async () => assert.match(await createBot({ bug: null }).reply('Привет!'), /Здравствуйте/))
`

/** Подставной Telegram в сети приложения: принимает сообщения сторожа и врача, отдаёт их по `GET /messages`. */
const FAKE_TELEGRAM = String.raw`
const messages = []
require('http').createServer(async (request, response) => {
  let body = ''
  for await (const chunk of request) body += chunk
  response.setHeader('content-type', 'application/json')
  if (request.method === 'GET' && request.url === '/messages') return response.end(JSON.stringify(messages))
  const match = /^\/bot([^/]+)\/(\w+)$/.exec(request.url ?? '')
  if (!match) return response.writeHead(404).end('{"ok":false,"error_code":404}')
  let json = {}
  try { json = JSON.parse(body) } catch {}
  if (match[2] === 'sendMessage') {
    messages.push({ botToken: decodeURIComponent(match[1]), chatId: String(json.chat_id ?? ''), text: String(json.text ?? '') })
    return response.end(JSON.stringify({ ok: true, result: { message_id: messages.length, chat: { id: json.chat_id } } }))
  }
  response.end(JSON.stringify({ ok: true, result: match[2] === 'getUpdates' ? [] : true }))
}).listen(8081, '0.0.0.0')
`

interface FeedReport {
  reportId: number
  caseId?: number
  type: string
  short: string
}

function docker(args: string[], options: { env?: NodeJS.ProcessEnv; cwd?: string } = {}): string {
  return execFileSync('docker', args, { cwd: options.cwd ?? repoRoot, encoding: 'utf8', env: { ...process.env, ...options.env }, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 })
}

function quietly(args: string[], env?: NodeJS.ProcessEnv): void {
  spawnSync('docker', args, { cwd: repoRoot, stdio: 'ignore', env: { ...process.env, ...env } })
}

function logs(container: string): string {
  const result = spawnSync('docker', ['logs', container], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  return `${result.stdout}${result.stderr}`
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=live', '-c', 'user.email=live@example.com', ...args], { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' } }).trim()
}

/** Запрос из контейнера в сети приложения: хост в эту сеть не ходит. */
function fromAppNetwork(container: string, url: string, init: { method?: string; body?: unknown } = {}): { status: number; body: string } {
  const code = `fetch(${JSON.stringify(url)}, { method: ${JSON.stringify(init.method ?? 'GET')}, headers: { 'content-type': 'application/json' }, ${init.body === undefined ? '' : `body: ${JSON.stringify(JSON.stringify(init.body))},`} signal: AbortSignal.timeout(20000) })
    .then(async (r) => console.log(JSON.stringify({ status: r.status, body: await r.text() })), (e) => console.log(JSON.stringify({ status: 0, body: String(e.cause?.code ?? e) })))`
  return JSON.parse(docker(['exec', container, 'node', '-e', code]).trim()) as { status: number; body: string }
}

function telegramMessages(): { botToken: string; chatId: string; text: string }[] {
  return JSON.parse(fromAppNetwork(TELEGRAM, 'http://127.0.0.1:8081/messages').body) as { botToken: string; chatId: string; text: string }[]
}

async function until<T>(what: string, timeoutMs: number, probe: () => T | undefined): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const found = probe()
    if (found !== undefined) return found
    if (Date.now() > deadline) throw new Error(`не дождался: ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 2_000))
  }
}

describe.skipIf(!dockerReady || !deepseekKey || !openRouterKey)('живой цикл: «Пациент» в контейнерах, настоящая модель, случай crash до healed', () => {
  let root: string
  let appDir: string
  let origin: string
  let stateDir: string
  let deployRoot: string
  let base: string
  let composeEnv: NodeJS.ProcessEnv
  let composeArgs: string[]

  const compose = (...args: string[]) => docker([...composeArgs, ...args], { env: composeEnv })
  const reportsPull = (): FeedReport[] => (JSON.parse(compose('exec', '-T', 'doctor', 'remontnik-doctor', 'reports', 'pull', '--limit', '100')) as { reports: FeedReport[] }).reports
  const currentRelease = () => basename(readlinkSync(join(deployRoot, 'current')))

  beforeAll(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'remontnik-crash-')))
    appDir = join(root, 'app')
    origin = join(root, 'origin.git')
    stateDir = join(root, 'state')
    deployRoot = join(root, 'server')
    for (const dir of [appDir, stateDir, deployRoot]) mkdirSync(dir, { recursive: true })

    // «Пациент» с ошибкой: тарифа по умолчанию `starter` нет, вопрос о цене без названия тарифа валит ответ.
    cpSync(join(patientRoot, 'src'), join(appDir, 'src'), { recursive: true })
    mkdirSync(join(appDir, 'deploy'))
    cpSync(join(patientRoot, 'deploy/remontnik-deploy.ts'), join(appDir, 'deploy/remontnik-deploy.ts'))
    const plans = readFileSync(join(appDir, PLANS), 'utf8')
    expect(plans).toContain("DEFAULT_PLAN_ID = 'start'")
    writeFileSync(join(appDir, PLANS), plans.replace("DEFAULT_PLAN_ID = 'start'", "DEFAULT_PLAN_ID = 'starter'"))
    writeFileSync(join(appDir, 'package.json'), '{ "name": "patient-live", "private": true, "type": "module" }\n')
    writeFileSync(join(appDir, '.gitignore'), 'node_modules\n.remontnik/\n')
    mkdirSync(join(appDir, 'test'))
    writeFileSync(join(appDir, 'test/bot.test.ts'), BOT_TEST)
    const config = {
      app: { name: 'patient', timeZone: 'UTC' },
      repo: { mainBranch: 'main', mainline: 'merge' },
      workbench: { image: `remontnik-workbench:${TAG}`, install: 'true', bashTimeoutMs: 120_000 },
      checks: { test: 'node --test test/*.test.ts' },
      evalScope: [],
      closedPaths: [],
      forbidden: { schema: ['<нет>'], money: ['src/payments/**'], access: ['src/auth/**'] },
      deploy: {
        commands: {
          build: 'node deploy/remontnik-deploy.ts build',
          promote: 'node deploy/remontnik-deploy.ts promote',
          confirm: 'node deploy/remontnik-deploy.ts confirm',
          rollback: 'node deploy/remontnik-deploy.ts rollback',
          current: 'node deploy/remontnik-deploy.ts current',
          health: 'node deploy/remontnik-deploy.ts health',
        },
        buildEnv: ['PATIENT_DEPLOY_ROOT'],
        lockFile: '.remontnik/deploy.lock',
      },
      observe: { windowMinutes: 2 },
      limits: { doctorModelUsdPerDay: 1, diagnoseUsdPerCase: 0.5 },
      reports: { telegram: { botTokenEnv: 'LIVE_ALERT_BOT_TOKEN', chatIdEnv: 'LIVE_ALERT_CHAT_ID', apiBaseUrlEnv: 'LIVE_TELEGRAM_URL' } },
      browser: {
        enabled: true,
        profile: 'remontnik',
        allowedOrigins: [PATIENT_URL],
        allowedMutations: [],
        pagesToCheck: [{ url: `${PATIENT_URL}/`, expectText: 'Учебное приложение Ремонтника' }],
      },
    }
    writeFileSync(join(appDir, 'remontnik.config.json'), `${JSON.stringify(config, null, 2)}\n`)
    git(root, 'init', '--quiet', '--bare', '--initial-branch=main', origin)
    git(appDir, 'init', '--quiet', '--initial-branch=main')
    git(appDir, 'remote', 'add', 'origin', origin)
    git(appDir, 'add', '-A')
    git(appDir, 'commit', '--quiet', '-m', 'Пациент с ошибкой')
    git(appDir, 'push', '--quiet', 'origin', 'main')
    base = git(appDir, 'rev-parse', 'HEAD')

    // Версия с ошибкой уже работает на «сервере»: так её выкатил бы владелец.
    for (const command of ['build', 'promote', 'confirm']) {
      execFileSync(process.execPath, ['deploy/remontnik-deploy.ts', command], { cwd: appDir, env: { ...process.env, PATIENT_DEPLOY_ROOT: deployRoot, REMONTNIK_VERSION: base }, stdio: 'ignore' })
    }
    // Дальше выкатывает врач: команды ждут, пока «Пациент» в контейнере ответит новой версией.
    writeFileSync(join(deployRoot, 'settings.json'), JSON.stringify({ healthUrl: `${PATIENT_URL}/health`, versionUrl: `${PATIENT_URL}/version` }))

    const secret = () => randomBytes(24).toString('hex')
    const browserToken = secret()
    const writeSecretFile = (name: string, lines: string[]) => {
      const file = join(root, name)
      writeFileSync(file, `${lines.join('\n')}\n`)
      chmodSync(file, 0o600)
      return file
    }
    const sharedSecret = secret()
    const doctorEnv = writeSecretFile('doctor.env', [
      `REMONTNIK_SHARED_SECRET=${sharedSecret}`,
      `REMONTNIK_CONTROL_SECRET=${secret()}`,
      `REMONTNIK_REPORTS_TOKEN=${secret()}`,
      `REMONTNIK_BROWSER_TOKEN=${browserToken}`,
      `DEEPSEEK_API_KEY=${deepseekKey}`,
      `OPENROUTER_API_KEY=${openRouterKey}`,
      `LIVE_ALERT_BOT_TOKEN=${DOCTOR_BOT_TOKEN}`,
      'LIVE_ALERT_CHAT_ID=owner-chat',
      `LIVE_TELEGRAM_URL=http://${TELEGRAM}:8081`,
      `PATIENT_DEPLOY_ROOT=${deployRoot}`,
    ])
    const browserEnv = writeSecretFile('browser.env', [`REMONTNIK_BROWSER_TOKEN=${browserToken}`, `REMONTNIK_BROWSER_VAULT_KEY=${randomBytes(32).toString('base64')}`])
    const policy = join(root, 'browser-policy.json')
    writeFileSync(policy, JSON.stringify({ allowedOrigins: [PATIENT_URL], allowedMutations: [], profiles: [{ name: 'remontnik' }] }))
    // Поверх шаблона: врачу — удалённый репозиторий и папка выкаток по путям хоста, браузеру — сеть приложения.
    const override = join(root, 'compose.live.yml')
    writeFileSync(
      override,
      JSON.stringify({
        services: {
          doctor: { volumes: [`${origin}:${origin}`, `${deployRoot}:${deployRoot}`] },
          browser: { networks: { outside: {}, app: {} } },
        },
      }),
    )

    const socketGid = docker(['run', '--rm', '-v', '/var/run/docker.sock:/var/run/docker.sock', '--entrypoint', 'stat', 'node:22-bookworm-slim', '-c', '%g', '/var/run/docker.sock']).trim()
    composeEnv = {
      REMONTNIK_APP_DIR: appDir,
      REMONTNIK_STATE_DIR: stateDir,
      REMONTNIK_ENV_FILE: doctorEnv,
      REMONTNIK_BROWSER_ENV_FILE: browserEnv,
      REMONTNIK_BROWSER_POLICY: policy,
      REMONTNIK_APP_NETWORK: APP_NETWORK,
      REMONTNIK_IMAGE_TAG: TAG,
      REMONTNIK_UID: String(process.getuid?.() ?? 10001),
      REMONTNIK_GID: String(process.getgid?.() ?? 10001),
      DOCKER_GID: socketGid,
    }
    composeArgs = ['compose', '-p', PROJECT, '-f', composeFile, '-f', override, '--profile', 'browser']

    docker(['build', '-q', '-f', 'deploy/workbench.Dockerfile', '-t', `remontnik-workbench:${TAG}`, 'deploy'])
    docker(['build', '-q', '-f', 'packages/doctor/test/live/patient.Dockerfile', '-t', `remontnik-live-patient:${TAG}`, '.'])
    compose('build', '-q', 'doctor', 'browser')

    quietly(['network', 'create', APP_NETWORK])
    docker(['run', '-d', '--rm', '--name', TELEGRAM, '--network', APP_NETWORK, '--entrypoint', 'node', `remontnik-doctor:${TAG}`, '-e', FAKE_TELEGRAM])
    docker([
      'run', '-d', '--name', PATIENT, '--network', APP_NETWORK,
      '--user', `${composeEnv.REMONTNIK_UID}:${composeEnv.REMONTNIK_GID}`,
      '-v', `${deployRoot}:${deployRoot}:ro`,
      '-e', `PATIENT_DEPLOY_ROOT=${deployRoot}`,
      '-e', 'DOCTOR_URL=http://remontnik-doctor-app:7800',
      '-e', `REMONTNIK_SHARED_SECRET=${sharedSecret}`,
      '-e', `ALERT_BOT_TOKEN=${WATCH_BOT_TOKEN}`,
      '-e', 'ALERT_CHAT_ID=owner-chat',
      '-e', `TELEGRAM_API_BASE_URL=http://${TELEGRAM}:8081`,
      `remontnik-live-patient:${TAG}`,
    ])
    compose('up', '-d', '--wait')
  }, 1_800_000)

  afterAll(() => {
    if (!composeEnv) return
    if (process.env.REMONTNIK_KEEP_STACK === '1') return
    for (const network of docker(['network', 'ls', '--filter', 'label=remontnik.case-network', '--format', '{{.Name}}']).split('\n').filter(Boolean)) {
      quietly(['network', 'disconnect', '--force', network, 'remontnik-doctor'])
      quietly(['network', 'rm', network])
    }
    quietly([...composeArgs, 'down', '--volumes', '--remove-orphans'], composeEnv)
    quietly(['rm', '-f', PATIENT, TELEGRAM])
    quietly(['network', 'rm', APP_NETWORK])
    // Копии случая писал пользователь врача; убираем через контейнер, если у хоста не хватит прав.
    quietly(['run', '--rm', '-v', `${root}:${root}`, '--entrypoint', 'rm', 'node:22-bookworm-slim', '-rf', stateDir, deployRoot])
    rmSync(root, { recursive: true, force: true })
  }, 300_000)

  it('сбой → тревога сторожа → правка с тестом → выкатка → проверка страницы в браузере → healed; отчёты в Telegram и в очереди Paseo', async () => {
    const logsOnFailure = () => `\n--- врач ---\n${logs('remontnik-doctor').slice(-20_000)}\n--- пациент ---\n${logs(PATIENT).slice(-5_000)}`
    await until('врач слушает', 120_000, () => (logs('remontnik-doctor').includes('слушаю') ? true : undefined))
    await until('«Пациент» отвечает', 120_000, () => (fromAppNetwork(TELEGRAM, `${PATIENT_URL}/health`).status === 200 ? true : undefined))

    const crashed = fromAppNetwork(TELEGRAM, `${PATIENT_URL}/api/chat`, { method: 'POST', body: { message: PRICE_QUESTION } })
    expect(crashed.status).toBe(500)
    await until('тревога сторожа в Telegram', 120_000, () => (telegramMessages().some((message) => message.botToken === WATCH_BOT_TOKEN) ? true : undefined))

    let reports: FeedReport[] = []
    try {
      await until('случай закончился', CASE_TIMEOUT_MS, () => {
        reports = reportsPull()
        const failed = reports.find((report) => FAILED_REPORTS.includes(report.type))
        if (failed) throw new Error(`случай не вылечен: ${failed.type} — ${failed.short}`)
        return reports.some((report) => report.type === 'deployed' && report.short.includes('держится')) ? true : undefined
      })
    } catch (error) {
      throw new Error(`${(error as Error).message}\nотчёты: ${JSON.stringify(reports, null, 2)}${logsOnFailure()}`)
    }

    // Правка в main и на «сервере»; прежняя версия помечена; в правке есть новый тест.
    const main = git(origin, 'rev-parse', 'main')
    expect(main).not.toBe(base)
    expect(currentRelease()).toBe(main)
    const tags = git(origin, 'tag', '--list', 'remontnik/pre-deploy/*').split('\n').filter(Boolean)
    expect(tags).toHaveLength(1)
    expect(git(origin, 'rev-parse', `${tags[0]}^{commit}`)).toBe(base)
    const changed = git(origin, 'diff', '--name-only', base, main).split('\n')
    expect(changed.some((path) => path.startsWith('test/'))).toBe(true)

    // Выкаченная версия отвечает на тот же вопрос.
    const answered = fromAppNetwork(TELEGRAM, `${PATIENT_URL}/api/chat`, { method: 'POST', body: { message: PRICE_QUESTION } })
    expect(answered.status, answered.body).toBe(200)

    // Отчёты: в очереди Paseo — от приёма до «держится», проверка страницы в браузере прошла; в Telegram — сообщения врача.
    const healedReport = reports.find((report) => report.type === 'deployed' && report.short.includes('держится'))!
    expect(healedReport.short).toContain('влил в основную ветку main')
    expect(reports.map((report) => report.short).join('\n')).toContain('Страницы проверил в браузере: работают.')
    const doctorMessages = await until('отчёт врача в Telegram', 120_000, () => {
      const found = telegramMessages().filter((message) => message.botToken === DOCTOR_BOT_TOKEN)
      return found.length > 0 ? found : undefined
    })
    expect(doctorMessages.every((message) => message.chatId === 'owner-chat')).toBe(true)

    // Итог случая по книге врача: врач остановлен, хранилище читается с хоста.
    compose('stop', 'doctor')
    const opened = await openDoctorHarness({ stateDir, onReport: () => {} })
    try {
      expect((await createCaseBook(opened.records).getCase(healedReport.caseId ?? 1))?.state).toBe('healed')
    } finally {
      await opened.close()
    }
  }, CASE_TIMEOUT_MS + 600_000)
})
