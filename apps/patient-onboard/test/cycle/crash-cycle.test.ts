import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Wake } from '@earendil-works/pi-durable'
import { createGitGuard, createLocalRunner, createServerDeployer, startDoctorService } from '@ykurilov/remontnik-doctor'
import { callTool, createScriptedModel, testRemontnikConfig } from '@ykurilov/remontnik-doctor/testing'
import { startFakeTelegram } from '@ykurilov/remontnik-core/testing'
import { describe, expect, it } from 'vitest'

// Полный цикл без настоящей модели: сбой `crash` → случай у врача → правка → выкатка командами приложения → приложение здорово.
// Врач — в процессе теста, модель подставная; сторож, git, команды выкатки и само приложение настоящие.

const appRoot = fileURLToPath(new URL('../..', import.meta.url))
const deployScript = 'deploy/remontnik-deploy.mjs'
const WEBHOOK_SECRET = 'cycle-webhook-secret'
const SHARED_SECRET = 'cycle-shared-secret-cycle-shared-secret'

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' } }).trim()
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer()
    probe.listen(0, '127.0.0.1', () => {
      const port = (probe.address() as { port: number }).port
      probe.close(() => resolve(port))
    })
    probe.on('error', reject)
  })
}

/** Часы врача: спящие задачи (окно наблюдения) просыпаются сразу, время прыгает вперёд. */
function clock() {
  let offset = 0
  const now = () => Date.now() + offset
  return {
    now,
    onWake(wake: Wake, resume: () => void) {
      if (wake.active || wake.at === undefined) return
      const at = wake.at
      setImmediate(() => {
        offset += Math.max(0, at - now())
        resume()
      })
    },
  }
}

describe('crash: полный цикл', () => {
  it('сбой доходит до врача, правка выкатывается, приложение здорово', async ({ onTestFinished }) => {
    const root = mkdtempSync(join(tmpdir(), 'onboard-cycle-'))
    const telegram = await startFakeTelegram()
    const deployDir = join(root, 'deploy-state')
    const appPort = await freePort()
    const env = { ...process.env, APP_DEPLOY_DIR: deployDir }
    onTestFinished(async () => {
      try {
        const { pid } = JSON.parse(readFileSync(join(deployDir, 'state.json'), 'utf8')) as { pid: number | null }
        if (pid) process.kill(pid, 'SIGKILL')
      } catch {}
      await telegram.close()
      rmSync(root, { recursive: true, force: true })
    })

    // Репозиторий приложения: origin + рабочая копия основной ветки (то, что на сервере).
    const origin = join(root, 'origin.git')
    const repoDir = join(root, 'main')
    git(root, 'init', '--bare', '--initial-branch=main', origin)
    git(root, 'clone', origin, repoDir)
    git(repoDir, 'config', 'user.email', 'owner@example.com')
    git(repoDir, 'config', 'user.name', 'Owner')
    cpSync(appRoot, repoDir, { recursive: true, filter: (path) => !/(^|\/)(node_modules|\.deploy-state|\.remontnik)(\/|$)/.test(path.slice(appRoot.length)) })
    cpSync(join(appRoot, '.gitignore'), join(repoDir, '.gitignore'))
    writeFileSync(join(repoDir, '.gitignore'), `${readFileSync(join(repoDir, '.gitignore'), 'utf8')}node_modules\n`)
    // Этот тест в копию не входит (иначе он запускал бы сам себя), а tsconfig в одиночной копии не наследует корневой.
    rmSync(join(repoDir, 'test/cycle'), { recursive: true, force: true })
    const baseOptions = JSON.parse(readFileSync(join(appRoot, '../../tsconfig.base.json'), 'utf8')) as { compilerOptions: object }
    const appTsconfig = JSON.parse(readFileSync(join(repoDir, 'tsconfig.json'), 'utf8')) as { compilerOptions: object }
    writeFileSync(join(repoDir, 'tsconfig.json'), JSON.stringify({ ...appTsconfig, extends: undefined, compilerOptions: { ...baseOptions.compilerOptions, ...appTsconfig.compilerOptions } }))
    git(repoDir, 'add', '-A')
    git(repoDir, 'commit', '-m', 'начало')
    git(repoDir, 'push', 'origin', 'main')
    const base = git(repoDir, 'rev-parse', 'HEAD')

    // Папка выкаток: зависимости приложения общие для всех сборок.
    mkdirSync(deployDir, { recursive: true })
    symlinkSync(join(appRoot, 'node_modules'), join(deployDir, 'node_modules'))
    writeFileSync(join(deployDir, 'settings.json'), JSON.stringify({ healthUrl: `http://127.0.0.1:${appPort}` }))

    // Модель правит бота: убирает вызов, который роняет процесс, и добавляет тест.
    const botSource = readFileSync(join(repoDir, 'src/bot/bot.ts'), 'utf8')
    const fixedBot = botSource.replace("      if (bug === 'crash') rememberTurn(message, crashProcess)\n", '')
    expect(fixedBot).not.toBe(botSource)
    const newTest = `import { expect, it } from 'vitest'
import { createBot } from '../src/bot/bot.ts'

it('crash: бот отвечает и не роняет процесс', async () => {
  const crashes: Error[] = []
  const bot = createBot({ bug: 'crash', crashProcess: (error) => crashes.push(error) })
  expect(await bot.reply('Привет')).toContain('Здравствуйте')
  await new Promise((resolve) => setImmediate(resolve))
  expect(crashes).toEqual([])
})
`
    const model = createScriptedModel()
    model.script(
      callTool('read', { path: 'src/bot/bot.ts' }),
      callTool('finish_diagnosis', {
        found: true,
        cause: 'rememberTurn бросает ошибку в setImmediate при PATIENT_BUG=crash и роняет процесс',
        evidence: ['src/bot/bot.ts: rememberTurn(message, crashProcess)'],
        confidence: 'high',
      }),
      callTool('write', { path: 'src/bot/bot.ts', content: fixedBot }),
      callTool('write', { path: 'test/bot-no-crash.test.ts', content: newTest }),
      callTool('finish_fix', { summary: 'Убран вызов, который ронял процесс', testsAdded: ['test/bot-no-crash.test.ts'] }),
    )

    const base0 = testRemontnikConfig()
    const config = testRemontnikConfig({
      repo: { mainBranch: 'main', mainline: 'merge' },
      workbench: { image: 'node:22', install: `ln -s "${appRoot}/node_modules" node_modules`, bashTimeoutMs: 120_000 },
      checks: { test: 'node_modules/.bin/vitest run' },
      fixablePaths: ['src/**'],
      deploy: {
        commands: Object.fromEntries(['build', 'promote', 'confirm', 'rollback', 'current', 'health'].map((name) => [name, `node ${deployScript} ${name}`])) as never,
        lockFile: '.remontnik/deploy.lock',
        buildEnv: ['APP_DEPLOY_DIR'],
      },
      limits: { ...base0.limits, diagnoseUsdPerCase: 1 },
      observe: { ...base0.observe, windowMinutes: 1, healthWindowTicks: 3 },
    })
    const loadConfig = async () => config
    const guard = createGitGuard({
      repoDir,
      worktreesDir: join(root, 'worktrees'),
      mainBranch: 'main',
      mainline: 'merge',
      author: { name: 'Ремонтник', email: 'doctor@example.invalid' },
    })
    const deployer = createServerDeployer({ guard, loadConfig, env })
    const time = clock()
    const doctor = await startDoctorService({
      stateDir: join(root, 'state'),
      sharedSecret: SHARED_SECRET,
      listen: { host: '127.0.0.1', port: 0 },
      telegram: { botToken: '123456:test-bot-token', chatId: 'owner-chat', apiBaseUrl: telegram.baseUrl },
      exit: () => {},
      log: () => {},
      now: time.now,
      onWake: time.onWake,
      treatment: {
        guard,
        loadConfig,
        worktreesDir: join(root, 'worktrees'),
        models: model.models,
        model: model.model,
        runner: createLocalRunner(),
        allowUnisolatedRunner: true,
        deployer,
      },
    })
    onTestFinished(() => doctor.close())

    // Ручная выкатка начальной версии, как сделал бы владелец; приложение со сторожем и заложенным сбоем.
    writeFileSync(
      join(deployDir, 'app.env'),
      [
        `PATIENT_BUG=crash`,
        `REMONTNIK_WATCH_DIR=${join(root, 'watch-queue')}`,
        `REMONTNIK_DOCTOR_URL=${doctor.url}`,
        `REMONTNIK_SHARED_SECRET=${SHARED_SECRET}`,
        `APP_ALERT_BOT_TOKEN=123456:test-bot-token`,
        `APP_ALERT_CHAT_ID=owner-chat`,
        `APP_ALERT_API_BASE_URL=${telegram.baseUrl}`,
        `APP_ALERT_WEBHOOK_SECRET=${WEBHOOK_SECRET}`,
      ].join('\n'),
    )
    const run = (command: string, version?: string) =>
      execFileSync('node', [deployScript, command], { cwd: repoDir, env: { ...env, ...(version ? { REMONTNIK_VERSION: version } : {}) }, encoding: 'utf8' })
    run('build', base)
    run('promote', base)
    run('confirm')
    expect(JSON.parse(run('current'))).toEqual({ version: base, previous: null })

    // Сбой: ответ уходит, процесс падает.
    const response = await fetch(`http://127.0.0.1:${appPort}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'Привет' }),
    })
    expect(response.status).toBe(200)

    // Процесс упал. Сторож доставит сбой врачу, когда процесс поднимется снова: это делает перезапускатель сервера.
    const stateBefore = JSON.parse(readFileSync(join(deployDir, 'state.json'), 'utf8')) as { pid: number }
    for (let i = 0; i < 100; i += 1) {
      try {
        process.kill(stateBefore.pid, 0)
      } catch {
        break
      }
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    run('start')

    const FINAL = ['healed', 'rolled_back', 'not_helped', 'report_only', 'needs_human', 'no_cause_found', 'stand_broken']
    const deadline = Date.now() + 120_000
    let final = await doctor.caseBook.getCase(1)
    while (!final || !FINAL.includes(final.state)) {
      if (Date.now() > deadline) throw new Error(`случай не дошёл до итога: ${final?.state}`)
      await new Promise((resolve) => setTimeout(resolve, 50))
      final = await doctor.caseBook.getCase(1)
    }
    expect(final.state).toBe('healed')

    // Правка влита в основную ветку, работает новая версия, приложение здорово.
    const now = JSON.parse(run('current')) as { version: string; previous: string | null }
    expect(now.version).not.toBe(base)
    expect(git(origin, 'rev-parse', 'main')).toBe(now.version)
    expect(existsSync(join(deployDir, 'releases', now.version))).toBe(true)
    run('health')
    const ok = await fetch(`http://127.0.0.1:${appPort}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'Привет' }),
    })
    expect(ok.status).toBe(200)
    await new Promise((resolve) => setTimeout(resolve, 500))
    run('health')

    // Стоп-кран: нажатие кнопки в чате тревог доходит через бота приложения до врача.
    const webhook = (chatId: string, secret = WEBHOOK_SECRET) =>
      fetch(`http://127.0.0.1:${appPort}/telegram/alerts`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': secret },
        body: JSON.stringify({ update_id: 1, callback_query: { id: 'cb-1', data: 'remontnik:stop', from: { id: 7 }, message: { chat: { id: chatId } } } }),
      })
    expect((await webhook('owner-chat', 'wrong')).status).toBe(404)
    const wrongChat = (await (await webhook('someone-else')).json()) as { text: string }
    expect(wrongChat.text).toContain('только в чате тревог')
    const stopped = (await (await webhook('owner-chat')).json()) as { method: string; text: string }
    expect(stopped).toMatchObject({ method: 'answerCallbackQuery' })
    expect(stopped.text).toContain('Автовыкатка остановлена')
  }, 240_000)
})
