import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall, type AssistantMessage, type TranscriptContext } from '@earendil-works/pi-ai'
import type { Wake } from '@earendil-works/pi-durable'
import { startFakeTelegram } from '@ykurilov/remontnik-core/testing'
import { describe, expect, it } from 'vitest'
import type { CaseState } from '../../src/case-book/index.js'
import { createDeployer, createDeployLock } from '../../src/deployer/index.js'
import { createGitGuard } from '../../src/git-guard/index.js'
import { createFallbackProvider, DOCTOR_MODEL_ID, DOCTOR_PROVIDER_ID, type RouteName } from '../../src/model/provider-fallback.js'
import { startDoctorService } from '../../src/service/index.js'
import { testRemontnikConfig } from '../../src/testing/config.js'
import { createFakeDeployApp } from '../../src/testing/fake-deploy-app.js'
import { createLocalRunner } from '../../src/workbench/index.js'
import { BUGGY, FIXED, NEW_TEST, OLD_TEST, priceCrash } from '../crash/world.js'

// История 5, сценарий 3 (T086): основной поставщик модели упал посреди случая. Врач переходит на запасной путь
// и доводит случай до конца: тот же разговор, те же инструменты, без отчёта о сбое и без второй выкатки.

const FINAL_STATES: CaseState[] = ['healed', 'rolled_back', 'not_helped', 'report_only', 'needs_human', 'no_cause_found', 'stand_broken']
/** Сколько ответов основной путь даёт до падения: диагноз начат, но не закончен. */
const PRIMARY_ANSWERS = 1

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' } }).trim()
}

function repo() {
  const root = mkdtempSync(join(tmpdir(), 'remontnik-fallback-'))
  const origin = join(root, 'origin.git')
  const repoDir = join(root, 'main')
  git(root, 'init', '--bare', '--initial-branch=main', origin)
  git(root, 'clone', origin, repoDir)
  git(repoDir, 'config', 'user.email', 'owner@example.com')
  git(repoDir, 'config', 'user.name', 'Owner')
  for (const [path, content] of Object.entries({ '.gitignore': 'node_modules\n.remontnik/\n', 'src/price.mjs': BUGGY, 'test/price.test.mjs': OLD_TEST })) {
    mkdirSync(dirname(join(repoDir, path)), { recursive: true })
    writeFileSync(join(repoDir, path), content)
  }
  git(repoDir, 'add', '-A')
  git(repoDir, 'commit', '-m', 'начало')
  git(repoDir, 'push', 'origin', 'main')
  return { root, origin, repoDir, base: git(repoDir, 'rev-parse', 'HEAD'), stateDir: join(root, 'state'), worktreesDir: join(root, 'worktrees') }
}

/** Следующий шаг лечения по истории разговора: какой путь ни ответит, он продолжает с того же места. */
function nextStep(context: TranscriptContext): AssistantMessage {
  const calls = context.messages.flatMap((message) => (message.role === 'assistant' ? message.content.filter((part) => part.type === 'toolCall') : []))
  const called = (name: string, path?: string) => calls.some((call) => call.name === name && (path === undefined || call.arguments.path === path))
  const tool = (name: string, args: Record<string, unknown>) => fauxAssistantMessage(fauxToolCall(name, args as Parameters<typeof fauxToolCall>[1]), { stopReason: 'toolUse' })
  if (!called('finish_diagnosis')) {
    if (!called('read')) return tool('read', { path: 'src/price.mjs' })
    return tool('finish_diagnosis', { found: true, cause: 'Тариф по умолчанию starter не существует', evidence: ["src/price.mjs: DEFAULT_PLAN = 'starter'"], confidence: 'high' })
  }
  if (!called('write', 'src/price.mjs')) return tool('write', { path: 'src/price.mjs', content: FIXED })
  if (!called('write', 'test/default-plan.test.mjs')) return tool('write', { path: 'test/default-plan.test.mjs', content: NEW_TEST })
  return tool('finish_fix', { summary: 'Тариф по умолчанию — start', testsAdded: ['test/default-plan.test.mjs'] })
}

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

describe('основной поставщик модели упал посреди случая', () => {
  it('врач переходит на запасной путь и долечивает: тот же разговор, одна выкатка, без жалоб на себя', async ({ onTestFinished }) => {
    const r = repo()
    const telegram = await startFakeTelegram()
    onTestFinished(async () => {
      await telegram.close()
      rmSync(r.root, { recursive: true, force: true })
    })

    // Цены путей заданы: модель без цены врач не зовёт.
    const cost = { input: 0.1, output: 0.4, cacheRead: 0, cacheWrite: 0 }
    const primary = fauxProvider({ provider: 'primary-test', models: [{ id: 'flash', contextWindow: 200_000, maxTokens: 4_000, cost }] })
    const fallback = fauxProvider({ provider: 'fallback-test', models: [{ id: 'flash-routed', contextWindow: 200_000, maxTokens: 4_000, cost }] })
    const answered: { route: RouteName; context: TranscriptContext }[] = []
    let primaryAnswers = 0
    primary.appendResponses(
      Array.from({ length: 40 }, () => (context: TranscriptContext) => {
        if (primaryAnswers >= PRIMARY_ANSWERS) return fauxAssistantMessage('', { stopReason: 'error', errorMessage: '503 Service Unavailable' })
        primaryAnswers += 1
        answered.push({ route: 'primary', context: structuredClone(context) })
        return nextStep(context)
      }),
    )
    fallback.appendResponses(
      Array.from({ length: 40 }, () => (context: TranscriptContext) => {
        answered.push({ route: 'fallback', context: structuredClone(context) })
        return nextStep(context)
      }),
    )
    const switches: RouteName[] = []
    const time = clock()
    const provider = createFallbackProvider({
      primary: { provider: primary.provider, modelId: 'flash', apiKey: 'test-primary-key' },
      fallback: { provider: fallback.provider, modelId: 'flash-routed', apiKey: 'test-fallback-key' },
      now: time.now,
      onSwitch: (event) => switches.push(event.to),
    })
    const models = createModels()
    models.setProvider(provider)

    const base = testRemontnikConfig()
    const config = testRemontnikConfig({
      repo: { mainBranch: 'main', mainline: 'merge' },
      workbench: { image: 'node:22', install: 'true', bashTimeoutMs: 30_000 },
      checks: { test: 'node --test test/*.test.mjs' },
      evalScope: [],
      limits: { ...base.limits, diagnoseUsdPerCase: 1 },
      observe: { ...base.observe, windowMinutes: 1, healthWindowTicks: 3 },
    })
    const loadConfig = async () => config
    const app = createFakeDeployApp({ running: r.base })
    const guard = createGitGuard({ repoDir: r.repoDir, worktreesDir: r.worktreesDir, mainBranch: 'main', mainline: 'merge', author: { name: 'Ремонтник', email: 'doctor@example.invalid' } })
    const deployer = createDeployer({
      loadConfig,
      commandsFor: () => app.commands,
      mainCopyFor: () => app.mainCopy,
      lockFor: () => createDeployLock(join(r.repoDir, '.remontnik', 'deploy.lock')),
      async tagPreDeploy(name, version) {
        await guard.tagPreDeploy(name, version)
        return { ok: true }
      },
    })
    const doctor = await startDoctorService({
      stateDir: r.stateDir,
      sharedSecret: 'shared-test-secret',
      listen: { host: '127.0.0.1', port: 0 },
      telegram: { botToken: '123456:test-bot-token', chatId: 'owner-chat', apiBaseUrl: telegram.baseUrl },
      exit: () => {},
      log: () => {},
      now: time.now,
      onWake: time.onWake,
      treatment: {
        guard,
        loadConfig,
        currentVersion: async () => app.running ?? undefined,
        worktreesDir: r.worktreesDir,
        models,
        model: { provider: DOCTOR_PROVIDER_ID, modelId: DOCTOR_MODEL_ID },
        runner: createLocalRunner(),
        allowUnisolatedRunner: true,
        deployer,
      },
    })
    onTestFinished(() => doctor.close())

    await doctor.receiveEvents([priceCrash()])
    const deadline = Date.now() + 60_000
    let final = await doctor.caseBook.getCase(1)
    while (!final || !FINAL_STATES.includes(final.state)) {
      if (Date.now() > deadline) throw new Error(`случай не дошёл до итога: ${final?.state}`)
      await new Promise((resolve) => setTimeout(resolve, 20))
      final = await doctor.caseBook.getCase(1)
    }

    expect(final.state).toBe('healed')
    // Основной путь ответил и упал; дальше — только запасной, и он продолжил тот же разговор.
    expect(answered.map((answer) => answer.route).slice(0, PRIMARY_ANSWERS + 1)).toEqual(['primary', 'fallback'])
    expect(answered.slice(PRIMARY_ANSWERS).every((answer) => answer.route === 'fallback')).toBe(true)
    expect(switches).toEqual(['fallback'])
    const firstOnFallback = answered[PRIMARY_ANSWERS]!.context
    expect(firstOnFallback.systemPrompt).toBe(answered[0]!.context.systemPrompt)
    expect(firstOnFallback.messages.some((message) => message.role === 'toolResult')).toBe(true)
    // Правка выкачена один раз и влита; сбой поставщика — не сбой врача.
    const branch = git(r.origin, 'branch', '--list', 'remontnik/*').replace(/^[*\s]+/, '')
    expect(app.promotes).toBe(1)
    expect(app.running).toBe(git(r.origin, 'rev-parse', branch))
    expect(git(r.origin, 'rev-parse', 'main')).toBe(app.running)
    const reports = await doctor.reports.list({ after: 0, limit: 50 })
    expect(reports.map((report) => report.type)).not.toContain('doctor_problem')
  }, 120_000)
})
