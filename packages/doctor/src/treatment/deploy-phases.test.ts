import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { Wake } from '@earendil-works/pi-durable'
import { createIncidentEvent } from '@ykurilov/remontnik-core/incident'
import { signRequest } from '@ykurilov/remontnik-core/signed-http'
import { startFakeTelegram, type FakeTelegramServer } from '@ykurilov/remontnik-core/testing'
import type { RemontnikConfig } from '@ykurilov/remontnik-core/config'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { CaseState } from '../case-book/index.js'
import { createDeployer, createDeployLock } from '../deployer/index.js'
import { createGitGuard, GitGuardError, type GitGuard } from '../git-guard/index.js'
import { startDoctorService, type DoctorService } from '../service/index.js'
import { testRemontnikConfig } from '../testing/config.js'
import { createFakeDeployApp, type FakeDeployApp } from '../testing/fake-deploy-app.js'
import { callTool, createScriptedModel, type ScriptedModel } from '../testing/scripted-model.js'
import { createLocalRunner } from '../workbench/index.js'

// Лечение до выкатки (T070): решение `gated` о выкатке — в чекпойнте, дальше `deploying` → `observing` →
// `healed` | `rolled_back` | `not_helped`. Приложение подставное (сборки в памяти), git настоящий, часы врача
// перескакивают на время пробуждения спящей задачи: окно наблюдения проходит за секунды.

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
const FINAL_STATES: CaseState[] = ['healed', 'rolled_back', 'not_helped', 'report_only', 'needs_human', 'no_cause_found', 'stand_broken']

const dirs: string[] = []
const cleanups: (() => Promise<void>)[] = []
let telegram: FakeTelegramServer

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' } }).trim()
}

function repo() {
  const root = mkdtempSync(join(tmpdir(), 'remontnik-deploy-phases-'))
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

/** Часы врача: идут как настоящие, а когда задача засыпает, перескакивают на время её пробуждения. */
function fakeClock() {
  let offset = 0
  let sleeps = 0
  const clock = {
    now: () => Date.now() + offset,
    sleeps: () => sleeps,
    /** Перед каждым пробуждением: здесь проверка «делает» что-то с приложением между тиками. */
    beforeWake: async () => {},
    onWake(wake: Wake, resume: () => void) {
      if (wake.active || wake.at === undefined) return
      const at = wake.at
      setImmediate(() => {
        void clock
          .beforeWake()
          .then(() => {
            sleeps += 1
            offset += Math.max(0, at - clock.now())
            resume()
          })
          .catch(() => {})
      })
    },
  }
  return clock
}

type Clock = ReturnType<typeof fakeClock>

interface DoctorOptions {
  mainline?: 'merge' | 'pull-request'
  limits?: Partial<RemontnikConfig['limits']>
}

function guardFor(r: Repo, mainline: 'merge' | 'pull-request'): GitGuard {
  return createGitGuard({ repoDir: r.repoDir, worktreesDir: r.worktreesDir, mainBranch: 'main', mainline, author: { name: 'Ремонтник', email: 'doctor@example.invalid' } })
}

async function startDoctor(r: Repo, model: ScriptedModel, app: FakeDeployApp, clock: Clock, options: DoctorOptions = {}): Promise<DoctorService> {
  const mainline = options.mainline ?? 'pull-request'
  const base = testRemontnikConfig()
  const config = testRemontnikConfig({
    repo: { mainBranch: 'main', mainline },
    workbench: { image: 'node:22', install: 'true', bashTimeoutMs: 30_000 },
    checks: { test: 'node --test test/*.test.mjs' },
    evalScope: [],
    limits: { ...base.limits, diagnoseUsdPerCase: 1, ...options.limits },
    observe: { ...base.observe, windowMinutes: 2, healthWindowTicks: 3 },
  })
  const guard = guardFor(r, mainline)
  const loadConfig = async () => config
  const deployer = createDeployer({
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
  const service = await startDoctorService({
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
      currentVersion: async () => app.running ?? undefined,
      worktreesDir: r.worktreesDir,
      models: model.models,
      model: model.model,
      budgetPollMs: 10,
      runner: createLocalRunner(),
      allowUnisolatedRunner: true,
      deployer,
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

async function settledCase(service: DoctorService, states: CaseState[] = FINAL_STATES, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const found = await service.caseBook.getCase(1)
    if (found && states.includes(found.state)) return found
    if (Date.now() > deadline) throw new Error(`случай 1 не дошёл до ${states.join('/')}: ${found?.state}`)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

async function until(check: () => boolean | Promise<boolean>, what: string, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`не дождался: ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

function scriptCure(model: ScriptedModel): void {
  model.script(
    callTool('read', { path: 'src/price.mjs' }),
    callTool('finish_diagnosis', { found: true, cause: 'Тариф по умолчанию starter не существует', evidence: ["src/price.mjs: DEFAULT_PLAN = 'starter'"], confidence: 'high' }),
    callTool('write', { path: 'src/price.mjs', content: FIXED }),
    callTool('write', { path: 'test/default-plan.test.mjs', content: NEW_TEST }),
    callTool('finish_fix', { summary: 'Тариф по умолчанию — start', testsAdded: ['test/default-plan.test.mjs'] }),
  )
}

function fixBranch(r: Repo): string {
  return git(r.origin, 'branch', '--list', 'remontnik/*').replace(/^[*\s]+/, '')
}

/** Человек отправил свою правку в основную ветку origin из своей копии. */
function humanPush(r: Repo): string {
  const clone = join(r.root, 'human')
  git(r.root, 'clone', r.origin, clone)
  git(clone, 'config', 'user.email', 'owner@example.com')
  git(clone, 'config', 'user.name', 'Owner')
  writeFileSync(join(clone, 'README.md'), 'человек\n')
  git(clone, 'add', '-A')
  git(clone, 'commit', '-m', 'человек')
  git(clone, 'push', 'origin', 'main')
  return git(r.origin, 'rev-parse', 'main')
}

async function pressStop(doctor: DoctorService): Promise<void> {
  const body = JSON.stringify({ action: 'stop', by: 'telegram:owner' })
  const stopped = await fetch(`${doctor.url}/v1/control/deploys`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...signRequest({ method: 'POST', target: '/v1/control/deploys', body, secret: 'shared-test-secret' }) },
    body,
  })
  expect(stopped.status).toBe(200)
}

async function reports(doctor: DoctorService) {
  return doctor.reports.list({ after: 0, limit: 50 })
}

beforeEach(async () => {
  telegram = await startFakeTelegram()
})

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  await telegram.close()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('лечение до выкатки: deploying → observing → итог', () => {
  it('правка держится окно → healed: метка прежней версии, прежняя сборка, правка влита в main, случай закрыт', async () => {
    const r = repo()
    const app = createFakeDeployApp({ running: r.base })
    const clock = fakeClock()
    const model = createScriptedModel()
    scriptCure(model)
    const doctor = await startDoctor(r, model, app, clock, { mainline: 'merge' })

    await doctor.receiveEvents([priceCrash()])
    const healed = await settledCase(doctor)

    expect(healed.state).toBe('healed')
    const branch = fixBranch(r)
    const fixCommit = git(r.origin, 'rev-parse', branch)
    expect(app.running).toBe(fixCommit)
    expect(app.previous).toBe(r.base)
    expect(app.promotes).toBe(1)
    expect(app.calls).toContain('confirm')
    // Метка прежней рабочей версии — в origin.
    const tags = git(r.origin, 'tag', '--list', 'remontnik/pre-deploy/*').split('\n')
    expect(tags).toHaveLength(1)
    expect(git(r.origin, 'rev-parse', `${tags[0]}^{commit}`)).toBe(r.base)
    // Правка продержалась окно — она в основной ветке origin; рабочая копия основной ветки не тронута.
    expect(git(r.origin, 'rev-parse', 'main')).toBe(fixCommit)
    expect(git(r.repoDir, 'rev-parse', 'HEAD')).toBe(r.base)
    expect(clock.sleeps()).toBeGreaterThan(2)

    const list = await reports(doctor)
    expect(list.map((report) => report.type)).toEqual(['case_received', 'deployed', 'deployed'])
    expect(list[1]!.short).toContain('наблюдаю')
    expect(list[2]!.short).toContain('держится')
    expect(list[2]!.short).toContain('влил в основную ветку main')
    await until(() => telegram.messages.some((message) => message.text.includes('держится')), 'отчёт в Telegram')
    // Случай закрыт: тот же сбой снова — уже новый случай.
    expect(await doctor.caseBook.openCaseFor(healed.fingerprint, healed.appName)).toBeUndefined()
    // Копия для сборки убрана.
    expect(existsSync(join(r.worktreesDir, 'case-1-deploy'))).toBe(false)
  }, 90_000)

  it('решение о выкатке зафиксировано: после перезапуска оно не пересчитывается; отчёт выкатки о долгом замке отправлен', async () => {
    const r = repo()
    const app = createFakeDeployApp({ running: r.base })
    const clock = fakeClock()
    // Замок держит ручная выкатка: врач ждёт его.
    mkdirSync(dirname(r.lockPath), { recursive: true })
    writeFileSync(r.lockPath, 'ручная выкатка\n')
    const model = createScriptedModel({ costPerResponseUsd: 0.01 })
    scriptCure(model)
    const first = await startDoctor(r, model, app, clock)

    await first.receiveEvents([priceCrash()])
    await settledCase(first, ['deploying'])
    // Ожидание замка дольше deploy.lockWaitReportMinutes: отчёт выкатки ушёл в Telegram, а не застрял в записях.
    await until(() => telegram.messages.some((message) => message.text.includes('замок выкатки занят')), 'отчёт о долгом замке в Telegram')
    await first.close()
    expect(app.promotes).toBe(0)

    // Новые потолки сделали бы выкатку невозможной, если бы решение считалось заново.
    rmSync(r.lockPath)
    const second = await startDoctor(r, createScriptedModel(), app, clock, { limits: { autoDeploysPerDay: 0 } })
    const healed = await settledCase(second)

    expect(healed.state).toBe('healed')
    expect(app.promotes).toBe(1)
    // mainline: pull-request — main не тронута, ветка ждёт запроса на слияние.
    expect(git(r.origin, 'rev-parse', 'main')).toBe(r.base)
    const last = (await reports(second)).at(-1)!
    expect(last.type).toBe('deployed')
    expect(last.short).toContain(fixBranch(r))
    expect(last.short).toContain('запрос на слияние')
  }, 120_000)

  it('стало хуже → откат меньше чем за минуту по часам врача, случай rolled_back, main не тронута', async () => {
    const r = repo()
    const app = createFakeDeployApp({ running: r.base })
    const clock = fakeClock()
    const model = createScriptedModel()
    scriptCure(model)
    const doctor = await startDoctor(r, model, app, clock, { mainline: 'merge' })
    let promotedAt: number | undefined
    let rolledBackAt: number | undefined
    const { promote, rollback } = app.commands
    app.commands.promote = async () => {
      promotedAt = clock.now()
      return promote()
    }
    app.commands.rollback = async () => {
      rolledBackAt = clock.now()
      return rollback()
    }
    // Правка учащает тот же сбой: шесть повторов сразу после выкатки.
    let sent = false
    clock.beforeWake = async () => {
      if (sent || promotedAt === undefined) return
      sent = true
      await doctor.receiveEvents(Array.from({ length: 6 }, () => priceCrash()))
    }

    await doctor.receiveEvents([priceCrash()])
    const sick = await settledCase(doctor)

    expect(sick.state).toBe('rolled_back')
    expect(app.rollbacks).toBe(1)
    expect(app.running).toBe(r.base)
    expect(rolledBackAt! - promotedAt!).toBeLessThan(60_000)
    expect(git(r.origin, 'rev-parse', 'main')).toBe(r.base)
    const last = (await reports(doctor)).at(-1)!
    expect(last.type).toBe('rolled_back')
    expect(last.short).toContain('откатил')
  }, 90_000)

  it('стоп-кран нажат → правку не выкатывает: отчёт «правка готова», случай report_only', async () => {
    const r = repo()
    const app = createFakeDeployApp({ running: r.base })
    const clock = fakeClock()
    const model = createScriptedModel()
    scriptCure(model)
    const doctor = await startDoctor(r, model, app, clock)
    await pressStop(doctor)

    await doctor.receiveEvents([priceCrash()])
    const sick = await settledCase(doctor)

    expect(sick.state).toBe('report_only')
    expect(app.promotes).toBe(0)
    expect(app.running).toBe(r.base)
    expect(git(r.origin, 'tag', '--list', 'remontnik/*')).toBe('')
    const last = (await reports(doctor)).at(-1)!
    expect(last.type).toBe('fix_ready')
    expect(last.short).toContain('стоп-кран')
    expect(last.short).toContain(fixBranch(r))
  }, 90_000)

  it('основная ветка ушла вперёд за окно → правка держится, но не влита: отчёт без адреса origin зовёт открыть запрос на слияние', async () => {
    const r = repo()
    const app = createFakeDeployApp({ running: r.base })
    const clock = fakeClock()
    const model = createScriptedModel()
    scriptCure(model)
    const doctor = await startDoctor(r, model, app, clock, { mainline: 'merge' })
    let human: string | undefined
    clock.beforeWake = async () => {
      if (app.promotes === 1 && !human) human = humanPush(r)
    }

    await doctor.receiveEvents([priceCrash()])
    const healed = await settledCase(doctor)

    expect(healed.state).toBe('healed')
    expect(git(r.origin, 'rev-parse', 'main')).toBe(human)
    const last = (await reports(doctor)).at(-1)!
    expect(last.short).toContain('основная ветка ушла вперёд')
    expect(last.short).toContain('запрос на слияние')
    for (const text of [last.short, last.full]) {
      expect(text).not.toContain(r.root)
      expect(text).not.toContain('origin.git')
      expect(text).not.toContain('git push')
    }
  }, 90_000)

  it('стоп-кран нажат во время наблюдения → выкатка доходит до конца, но в main не вливает: правка ждёт запроса на слияние', async () => {
    const r = repo()
    const app = createFakeDeployApp({ running: r.base })
    const clock = fakeClock()
    const model = createScriptedModel()
    scriptCure(model)
    const doctor = await startDoctor(r, model, app, clock, { mainline: 'merge' })
    let stopped = false
    clock.beforeWake = async () => {
      if (app.promotes === 1 && !stopped) {
        stopped = true
        await pressStop(doctor)
      }
    }

    await doctor.receiveEvents([priceCrash()])
    const healed = await settledCase(doctor)

    expect(healed.state).toBe('healed')
    expect(app.calls).toContain('confirm')
    expect(git(r.origin, 'rev-parse', 'main')).toBe(r.base)
    const last = (await reports(doctor)).at(-1)!
    expect(last.short).toContain('стоп-кран')
    expect(last.short).toContain(fixBranch(r))
    expect(last.short).toContain('запрос на слияние')
  }, 90_000)

  it('замок потерян посреди наблюдения → выкатка брошена, приложение не трогает, нужен человек', async () => {
    const r = repo()
    const app = createFakeDeployApp({ running: r.base })
    const clock = fakeClock()
    const model = createScriptedModel()
    scriptCure(model)
    const doctor = await startDoctor(r, model, app, clock, { mainline: 'merge' })
    clock.beforeWake = async () => {
      if (app.promotes === 1 && existsSync(r.lockPath)) rmSync(r.lockPath)
    }

    await doctor.receiveEvents([priceCrash()])
    const sick = await settledCase(doctor)

    expect(sick.state).toBe('needs_human')
    expect(app.rollbacks).toBe(0)
    expect(app.calls).not.toContain('confirm')
    expect(git(r.origin, 'rev-parse', 'main')).toBe(r.base)
    const last = (await reports(doctor)).at(-1)!
    expect(last.type).toBe('needs_human')
    expect(last.short).toContain('бросил')
  }, 90_000)
})
