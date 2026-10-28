import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { testRemontnikConfig } from '../testing/index.js'
import type { EvalProxyRun, EvalProxyRunOptions, EvalSpend } from '../eval-proxy/index.js'
import { SpoiledCopyError, type CommandRunner, type RunOptions, type RunResult } from '../workbench/index.js'
import { createChecks, createMemoryEvalBaseCache, parseFailedTests, type EvalBaseCache } from './checks.js'

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'remontnik-checks-'))
  dirs.push(dir)
  return dir
}

const config = testRemontnikConfig({
  checks: {
    test: 'pnpm test',
    typecheck: 'pnpm typecheck',
    eval: {
      run: 'node eval/run-eval.ts --scenarios {scenarios} --repeat {repeat} --max-cost {maxCostUsd} --out {outDir}',
      resultFile: 'eval-result.json',
      repeat: 3,
      maxScenarios: 3,
      env: ['PATIENT_BUG'],
      providers: [{ name: 'chat', baseUrlEnv: 'CHAT_BASE_URL', keyEnv: 'EVAL_API_KEY', upstream: 'https://api.example.com/v1', models: { 'chat-small': { input: 1, output: 2 } } }],
    },
  },
  evalScope: [{ paths: ['src/bot/**'], scenarios: ['price-named-plan', 'greeting'] }],
})

interface ScenarioOutcome {
  pass: number
  standBroken?: number
  personaBroken?: number
}

interface FakeOptions {
  /** Итоги тестов по очереди запусков: код выхода и вывод. */
  tests?: { exitCode: number; output?: string }[]
  /** Итоги eval по папке (кандидат/основа) и сценарию. */
  evalOutcomes?: (cwd: string, scenario: string) => ScenarioOutcome
  evalCostUsd?: number
  /** Eval тратит столько, получает 402 и не заканчивается, пока его не прервут. */
  evalHangsAtCostUsd?: number
  /** Вывод установки. */
  installOutput?: { exitCode: number; output: string }
  /** Тесты убить не удалось. */
  testsStillRunning?: boolean
  /** Eval убить не удалось. */
  evalStillRunning?: boolean
  /** Расход, который eval пишет в свой файл итога: врач ему не верит. */
  claimedCostUsd?: number
  /** Клиент модели в eval идёт мимо адреса прокси: прокси не видит ни одного запроса. */
  evalBypassesProxy?: boolean
}

/** Подставной прокси модели: eval «тратит» через него, как через настоящий. */
function fakeProxy() {
  const runs: { options: EvalProxyRunOptions; spentUsd: number; requests: number; closed: boolean; overBudget: AbortController }[] = []
  return {
    runs,
    openRun(options: EvalProxyRunOptions): EvalProxyRun {
      const run = { options, spentUsd: 0, requests: 0, closed: false, overBudget: new AbortController() }
      runs.push(run)
      const token = `run-token-${runs.length}`
      const env: Record<string, string> = { [options.tokenEnv]: token }
      for (const provider of options.providers) {
        env[provider.baseUrlEnv] = `http://proxy.test/${token}/${provider.name}`
        env[provider.keyEnv] = token
      }
      return {
        token,
        env,
        overBudget: run.overBudget.signal,
        spentUsd: () => run.spentUsd,
        requests: () => run.requests,
        close: async () => {
          run.closed = true
        },
      }
    },
    /** Eval потратил `usd` через прокси последнего прогона. */
    async spend(usd: number) {
      const run = runs.at(-1)!
      run.requests += 1
      run.spentUsd += usd
      await run.options.onSpend?.({ spentUsd: run.spentUsd, inFlightUsd: 0 })
    },
    /** Запрос не влез в долю: 402, прогон прерван. */
    refuse() {
      runs.at(-1)!.overBudget.abort()
    },
  }
}

function fakeRunner(options: FakeOptions) {
  const calls: { command: string; options: RunOptions }[] = []
  const proxy = fakeProxy()
  const tests = [...(options.tests ?? [{ exitCode: 0 }])]
  const runner: CommandRunner = {
    isolation: 'none',
    spoiled: () => false,
    async run(command, runOptions): Promise<RunResult> {
      const text = typeof command === 'string' ? command : command.join(' ')
      calls.push({ command: text, options: runOptions })
      if (text === 'pnpm test' && options.testsStillRunning) return { exitCode: null, timedOut: true, aborted: false, output: '', stillRunning: true }
      if (text === 'pnpm test') {
        const next = tests.length > 1 ? tests.shift()! : tests[0]!
        return { exitCode: next.exitCode, timedOut: false, aborted: false, output: next.output ?? '' }
      }
      if (text.startsWith('node eval/run-eval.ts')) {
        const args = text.split(' ')
        const scenarios = args[args.indexOf('--scenarios') + 1]!.split(',')
        const outDir = args[args.indexOf('--out') + 1]!
        const repeats = Number(args[args.indexOf('--repeat') + 1])
        mkdirSync(outDir, { recursive: true })
        if (options.evalStillRunning) return { exitCode: null, timedOut: true, aborted: false, output: '', stillRunning: true }
        if (options.evalHangsAtCostUsd !== undefined) {
          await proxy.spend(options.evalHangsAtCostUsd)
          proxy.refuse()
          await new Promise<void>((resolve) => {
            if (runOptions.signal?.aborted) resolve()
            runOptions.signal?.addEventListener('abort', () => resolve(), { once: true })
          })
          return { exitCode: null, timedOut: false, aborted: true, output: '' }
        }
        if (!options.evalBypassesProxy) await proxy.spend(options.evalCostUsd ?? 0.1)
        writeFileSync(
          join(outDir, 'eval-result.json'),
          JSON.stringify({
            scenarios: scenarios.map((id) => {
              const outcome = options.evalOutcomes?.(runOptions.cwd, id) ?? { pass: repeats }
              return {
                id,
                repeats,
                pass: outcome.pass,
                fail: repeats - outcome.pass,
                standBroken: outcome.standBroken ?? 0,
                personaBroken: outcome.personaBroken ?? 0,
              }
            }),
            costUsd: options.claimedCostUsd ?? 0,
          }),
        )
        return { exitCode: 0, timedOut: false, aborted: false, output: '' }
      }
      if (text === 'pnpm install' && options.installOutput) return { ...options.installOutput, timedOut: false, aborted: false }
      return { exitCode: 0, timedOut: false, aborted: false, output: '' }
    },
  }
  return { runner, calls, proxy }
}

const EVAL_KEY = 'eval-key-example-0000'

function checksWith(fake: ReturnType<typeof fakeRunner>, baseCache: EvalBaseCache = createMemoryEvalBaseCache(), workDir = tempDir()) {
  return createChecks({
    runner: fake.runner,
    config,
    evalEnv: { PATIENT_BUG: 'worsening_fix', EVAL_API_KEY: EVAL_KEY, DEEPSEEK_API_KEY: 'test-not-passed' },
    evalProxy: fake.proxy,
    baseCache,
    workDir,
    timeoutSeconds: 60,
  })
}

const candidateDir = '/work/candidate'
const baseDir = '/work/base'

function runInput(overrides: Partial<Parameters<ReturnType<typeof createChecks>['run']>[0]> = {}) {
  return {
    candidateDir,
    baseDir,
    baseCommit: 'a'.repeat(40),
    changedPaths: ['src/bot/bot.ts'],
    reserveEval: async () => 1,
    ...overrides,
  }
}

describe('неубитая команда проверки', () => {
  it('копия испорчена → проверки останавливаются ошибкой, итогам не верим', async () => {
    const fake = fakeRunner({ testsStillRunning: true })
    await expect(checksWith(fake).run(runInput())).rejects.toBeInstanceOf(SpoiledCopyError)
  })
})

describe('разбор упавших тестов', () => {
  it('REMONTNIK_FAILED в выводе', () => {
    expect(parseFailedTests('...\nREMONTNIK_FAILED=prices;greeting\n')).toEqual(['prices', 'greeting'])
  })

  it('JUnit XML в выводе', () => {
    const xml = `<?xml version="1.0"?><testsuites><testsuite name="bot"><testcase classname="bot" name="цена по имени"><failure message="x"/></testcase><testcase classname="bot" name="ok"/></testsuite></testsuites>`
    expect(parseFailedTests(xml)).toEqual(['bot › цена по имени'])
  })

  it('ничего не нашлось → пусто (покажут хвост вывода)', () => {
    expect(parseFailedTests('всё сломалось')).toEqual([])
  })
})

describe('проверки', () => {
  it('зелёные тесты — один прогон', async () => {
    const fake = fakeRunner({ tests: [{ exitCode: 0 }] })
    const result = await checksWith(fake).run(runInput())
    expect(result.tests.status).toBe('green')
    expect(fake.calls.filter((call) => call.command === 'pnpm test')).toHaveLength(1)
    expect(fake.calls.map((call) => call.command).slice(0, 2)).toEqual(['pnpm install', 'pnpm typecheck'])
  })

  it('зависимости ставятся строго по файлу-замку — у правки и у основы, независимо от CI=1 в образе', async () => {
    const fake = fakeRunner({ tests: [{ exitCode: 0 }] })
    await checksWith(fake).run(runInput())
    const installs = fake.calls.filter((call) => call.command === 'pnpm install')
    expect(installs.map((call) => call.options.cwd)).toEqual([candidateDir, baseDir])
    for (const install of installs) expect(install.options.env).toMatchObject({ npm_config_frozen_lockfile: 'true' })
  })

  it('упавшие тесты повторяются; разный итог → flaky', async () => {
    const fake = fakeRunner({ tests: [{ exitCode: 1, output: 'REMONTNIK_FAILED=prices' }, { exitCode: 0 }] })
    const result = await checksWith(fake).run(runInput())
    expect(result.tests.status).toBe('flaky')
    expect(result.tests.failed).toEqual(['prices'])
  })

  it('упали дважды → red с именами', async () => {
    const fake = fakeRunner({ tests: [{ exitCode: 1, output: 'REMONTNIK_FAILED=prices' }, { exitCode: 1, output: 'REMONTNIK_FAILED=prices' }] })
    const result = await checksWith(fake).run(runInput())
    expect(result.tests.status).toBe('red')
    expect(result.tests.failed).toEqual(['prices'])
  })

  it('упали без имён → red с хвостом вывода', async () => {
    const fake = fakeRunner({ tests: [{ exitCode: 1, output: 'boom в конце' }] })
    const result = await checksWith(fake).run(runInput())
    expect(result.tests.status).toBe('red')
    expect(result.tests.outputTail).toContain('boom в конце')
  })

  it('eval не хуже основы → not_worse', async () => {
    const fake = fakeRunner({})
    const result = await checksWith(fake).run(runInput())
    expect(result.eval.status).toBe('not_worse')
    expect(result.eval.scenarios).toEqual([
      { id: 'price-named-plan', basePass: 3, candidatePass: 3, repeats: 3 },
      { id: 'greeting', basePass: 3, candidatePass: 3, repeats: 3 },
    ])
  })

  it('eval хуже основы → worse', async () => {
    const fake = fakeRunner({
      evalOutcomes: (cwd, scenario) => ({ pass: cwd === candidateDir && scenario === 'price-named-plan' ? 1 : 3 }),
    })
    const result = await checksWith(fake).run(runInput())
    expect(result.eval.status).toBe('worse')
  })

  it('сломанный стенд или персонаж → stand_broken', async () => {
    const fake = fakeRunner({ evalOutcomes: () => ({ pass: 2, standBroken: 1 }) })
    const result = await checksWith(fake).run(runInput())
    expect(result.eval.status).toBe('stand_broken')
  })

  it('стенд сломан, а к прокси не пришло ни одного запроса — заметка: клиент модели идёт мимо baseUrlEnv', async () => {
    const fake = fakeRunner({ evalOutcomes: () => ({ pass: 0, standBroken: 3 }), evalBypassesProxy: true })
    const result = await checksWith(fake).run(runInput())
    expect(result.eval.status).toBe('stand_broken')
    expect(result.eval.note).toMatch(/к прокси eval не пришло ни одного запроса.*мимо CHAT_BASE_URL/)

    const viaProxy = fakeRunner({ evalOutcomes: () => ({ pass: 0, standBroken: 3 }) })
    expect((await checksWith(viaProxy).run(runInput())).eval.note).toBeUndefined()
  })

  it('eval упал без итога и ни разу не позвал прокси — та же заметка рядом с кодом выхода', async () => {
    const fake = fakeRunner({ evalBypassesProxy: true })
    const runner: CommandRunner = {
      ...fake.runner,
      async run(command, runOptions) {
        const text = typeof command === 'string' ? command : command.join(' ')
        if (text.startsWith('node eval/run-eval.ts')) return { exitCode: 1, timedOut: false, aborted: false, output: 'fetch failed' }
        return fake.runner.run(command, runOptions)
      },
    }
    const result = await checksWith({ ...fake, runner }).run(runInput())
    expect(result.eval.status).toBe('stand_broken')
    expect(result.eval.note).toMatch(/не оставил итог: код 1[\s\S]*к прокси eval не пришло ни одного запроса/)
  })

  it('правка вне карты → not_needed, eval не запускается', async () => {
    const fake = fakeRunner({})
    const result = await checksWith(fake).run(runInput({ changedPaths: ['README.md'] }))
    expect(result.eval.status).toBe('not_needed')
    expect(fake.calls.some((call) => call.command.startsWith('node eval'))).toBe(false)
  })

  it('eval обязателен (плохой ответ), а карта для правки пуста → not_run: проверять нечем', async () => {
    const fake = fakeRunner({})
    const result = await checksWith(fake).run(runInput({ changedPaths: ['README.md'], evalRequired: true }))
    expect(result.eval.status).toBe('not_run')
    expect(result.eval.note).toContain('evalScope')
    expect(fake.calls.some((call) => call.command.startsWith('node eval'))).toBe(false)
  })

  it('eval обязателен, а в настройке его нет → not_run', async () => {
    const fake = fakeRunner({})
    const { eval: _eval, ...withoutEval } = config.checks
    const result = await createChecks({
      runner: fake.runner,
      config: { ...config, checks: withoutEval },
      evalEnv: {},
      baseCache: createMemoryEvalBaseCache(),
      workDir: tempDir(),
      timeoutSeconds: 60,
    }).run(runInput({ evalRequired: true }))
    expect(result.eval.status).toBe('not_run')
  })

  it('eval обязателен и карта накрывает правку → сценарии по карте', async () => {
    const fake = fakeRunner({})
    const result = await checksWith(fake).run(runInput({ evalRequired: true }))
    expect(result.eval.status).toBe('not_worse')
    expect(result.eval.scenarios.map((scenario) => scenario.id)).toEqual(['price-named-plan', 'greeting'])
  })

  it('итог основы кэшируется по паре (коммит, сценарий)', async () => {
    const cache = createMemoryEvalBaseCache()
    const fake = fakeRunner({})
    const checks = checksWith(fake, cache)
    await checks.run(runInput())
    await checks.run(runInput())
    const baseRuns = fake.calls.filter((call) => call.command.startsWith('node eval') && call.options.cwd === baseDir)
    expect(baseRuns).toHaveLength(1)

    await checks.run(runInput({ baseCommit: 'b'.repeat(40) }))
    expect(fake.calls.filter((call) => call.command.startsWith('node eval') && call.options.cwd === baseDir)).toHaveLength(2)
  })

  it('в кэше часть сценариев → основа гоняет только недостающие', async () => {
    const cache = createMemoryEvalBaseCache()
    await cache.set('a'.repeat(40), 'greeting', { id: 'greeting', repeats: 3, pass: 3, fail: 0, standBroken: 0, personaBroken: 0 })
    const fake = fakeRunner({})
    await checksWith(fake, cache).run(runInput())
    const baseRun = fake.calls.find((call) => call.command.startsWith('node eval') && call.options.cwd === baseDir)
    expect(baseRun?.command).toContain('--scenarios price-named-plan ')
  })

  it('потолок денег: бюджет уходит в {maxCostUsd}, остаток — основе; нет бюджета → not_run', async () => {
    const fake = fakeRunner({ evalCostUsd: 0.25 })
    await checksWith(fake).run(runInput({ reserveEval: async () => 0.6 }))
    const evalRuns = fake.calls.filter((call) => call.command.startsWith('node eval'))
    expect(evalRuns[0]?.command).toContain('--max-cost 0.6 ')
    expect(evalRuns[0]?.options.cwd).toBe(candidateDir)
    expect(evalRuns[1]?.command).toContain('--max-cost 0.35 ')

    const broke = fakeRunner({})
    const result = await checksWith(broke).run(runInput({ reserveEval: async () => 0 }))
    expect(result.eval.status).toBe('not_run')
    expect(broke.calls.some((call) => call.command.startsWith('node eval'))).toBe(false)
  })

  it('eval получает переменные из настройки, адрес прокси и токен прогона, но не ключ', async () => {
    const fake = fakeRunner({})
    await checksWith(fake).run(runInput())
    const evalRun = fake.calls.find((call) => call.command.startsWith('node eval'))
    expect(evalRun?.options.env).toEqual({
      PATIENT_BUG: 'worsening_fix',
      CHAT_BASE_URL: 'http://proxy.test/run-token-1/chat',
      EVAL_API_KEY: 'run-token-1',
      REMONTNIK_EVAL_TOKEN: 'run-token-1',
    })
    expect(JSON.stringify(fake.calls.map((call) => call.options.env))).not.toContain(EVAL_KEY)
    // Настоящий ключ — только у прокси, по имени из настройки.
    expect(fake.proxy.runs[0]?.options.providers[0]).toMatchObject({ name: 'chat', key: EVAL_KEY, upstream: 'https://api.example.com/v1' })
    expect(fake.proxy.runs.every((run) => run.closed)).toBe(true)
  })

  it('расход eval — по прокси, а не по файлу итога; складывается и сообщается по ходу', async () => {
    const fake = fakeRunner({ evalCostUsd: 0.2, claimedCostUsd: 0.001 })
    const spends: EvalSpend[] = []
    const result = await checksWith(fake).run(runInput({ onEvalSpend: (spend: EvalSpend) => spends.push(spend) }))
    expect(result.eval.costUsd).toBeCloseTo(0.4)
    expect(spends.at(-1)?.spentUsd).toBeCloseTo(0.4)
    expect(spends.at(-1)?.inFlightUsd).toBe(0)
  })

  it('бронь eval — прямо перед запуском eval: тесты красные или eval не запускается — брони нет', async () => {
    let reserved = 0
    const reserveEval = async () => {
      reserved += 1
      return 1
    }
    await checksWith(fakeRunner({ tests: [{ exitCode: 1 }] })).run(runInput({ reserveEval }))
    await checksWith(fakeRunner({})).run(runInput({ reserveEval, changedPaths: ['src/bot/bot.ts', 'eval/run-eval.ts'] }))
    await checksWith(fakeRunner({})).run(runInput({ reserveEval, changedPaths: ['docs/readme.md'] }))
    expect(reserved).toBe(0)

    const fake = fakeRunner({})
    let callsAtReserve = -1
    await checksWith(fake).run(
      runInput({
        reserveEval: async () => {
          reserved += 1
          callsAtReserve = fake.calls.length
          return 1
        },
      }),
    )
    expect(reserved).toBe(1)
    expect(fake.calls.slice(0, callsAtReserve).some((call) => call.command.startsWith('node eval'))).toBe(false)
    expect(fake.calls.slice(0, callsAtReserve).some((call) => call.command === 'pnpm test')).toBe(true)
  })

  it('пределы прокси — из настройки', async () => {
    const fake = fakeRunner({})
    await checksWith(fake).run(runInput())
    expect(fake.proxy.runs[0]?.options.limits).toEqual(config.checks.eval!.proxy)
  })

  it('расход дошёл до доли, но ни один запрос не получил 402 → итог eval принят', async () => {
    const fake = fakeRunner({ evalCostUsd: 0.5 })
    const result = await checksWith(fake).run(runInput())
    expect(result.eval.status).toBe('not_worse')
    expect(result.eval.costUsd).toBeCloseTo(1)
  })

  it('провайдеры есть, а прокси нет → eval не запускается', async () => {
    const fake = fakeRunner({})
    const checks = createChecks({ runner: fake.runner, config, evalEnv: { EVAL_API_KEY: EVAL_KEY }, baseCache: createMemoryEvalBaseCache(), workDir: tempDir(), timeoutSeconds: 60 })
    const result = await checks.run(runInput())
    expect(result.eval.status).toBe('not_run')
    expect(result.eval.note).toContain('прокси')
    expect(fake.calls.some((call) => call.command.startsWith('node eval'))).toBe(false)
  })

  it('ключа провайдера нет у врача → eval не запускается', async () => {
    const fake = fakeRunner({})
    const checks = createChecks({ runner: fake.runner, config, evalEnv: {}, evalProxy: fake.proxy, baseCache: createMemoryEvalBaseCache(), workDir: tempDir(), timeoutSeconds: 60 })
    const result = await checks.run(runInput())
    expect(result.eval.status).toBe('not_run')
    expect(result.eval.note).toContain('EVAL_API_KEY')
  })

  describe('заголовки к upstream', () => {
    const headerConfig = testRemontnikConfig({
      checks: {
        test: 'pnpm test',
        typecheck: 'pnpm typecheck',
        eval: {
          run: config.checks.eval!.run,
          resultFile: 'eval-result.json',
          repeat: 3,
          maxScenarios: 3,
          env: ['PATIENT_BUG'],
          providers: [
            { name: 'chat', baseUrlEnv: 'CHAT_BASE_URL', keyEnv: 'EVAL_API_KEY', upstream: 'https://api.example.com/v1', upstreamHeaders: [{ name: 'x-gateway-pass', valueEnv: 'GATEWAY_PASS' }], models: { 'chat-small': { input: 1, output: 2 } } },
          ],
        },
      },
      evalScope: [{ paths: ['src/bot/**'], scenarios: ['price-named-plan', 'greeting'] }],
    })

    it('значения берутся из окружения врача и уходят прокси; в окружение eval они не попадают', async () => {
      const fake = fakeRunner({})
      const checks = createChecks({ runner: fake.runner, config: headerConfig, evalEnv: { EVAL_API_KEY: EVAL_KEY, GATEWAY_PASS: 'gateway-pass-value' }, evalProxy: fake.proxy, baseCache: createMemoryEvalBaseCache(), workDir: tempDir(), timeoutSeconds: 60 })
      await checks.run(runInput())
      expect(fake.proxy.runs[0]?.options.providers[0]?.upstreamHeaderValues).toEqual({ 'x-gateway-pass': 'gateway-pass-value' })
      const evalCall = fake.calls.find((call) => call.command.startsWith('node eval'))!
      expect(JSON.stringify(evalCall.options.env ?? {})).not.toContain('gateway-pass-value')
    })

    it('переменной нет у врача → eval не запускается, в заметке её имя', async () => {
      const fake = fakeRunner({})
      const checks = createChecks({ runner: fake.runner, config: headerConfig, evalEnv: { EVAL_API_KEY: EVAL_KEY }, evalProxy: fake.proxy, baseCache: createMemoryEvalBaseCache(), workDir: tempDir(), timeoutSeconds: 60 })
      const result = await checks.run(runInput())
      expect(result.eval.status).toBe('not_run')
      expect(result.eval.note).toContain('GATEWAY_PASS')
      expect(fake.calls.some((call) => call.command.startsWith('node eval'))).toBe(false)
    })
  })

  it('правка задела файлы eval или настройки тестов → eval не запускается: скрипты eval только из основы', async () => {
    const fake = fakeRunner({})
    const result = await checksWith(fake).run(runInput({ changedPaths: ['src/bot/bot.ts', 'eval/run-eval.ts'] }))
    expect(result.eval.status).toBe('not_run')
    expect(result.eval.note).toContain('eval/run-eval.ts')
    expect(fake.calls.some((call) => call.command.startsWith('node eval'))).toBe(false)
  })

  it('тесты, проверка типов и eval — во внутренней сети; установка — во внешней', async () => {
    const fake = fakeRunner({})
    await checksWith(fake).run(runInput())
    for (const call of fake.calls) {
      expect(call.options.network).toBe(call.command === 'pnpm install' ? undefined : 'internal')
    }
  })

  it('eval не удалось убить → ошибка копии, прогон прокси закрыт', async () => {
    const fake = fakeRunner({ evalStillRunning: true })
    await expect(checksWith(fake).run(runInput())).rejects.toBeInstanceOf(SpoiledCopyError)
    expect(fake.proxy.runs.every((run) => run.closed)).toBe(true)
  })

  it('итог eval пишется в папку вне копии, и писать туда может только eval', async () => {
    const workDir = tempDir()
    const fake = fakeRunner({})
    await checksWith(fake, createMemoryEvalBaseCache(), workDir).run(runInput())
    const evalRuns = fake.calls.filter((call) => call.command.startsWith('node eval'))
    expect(evalRuns).toHaveLength(2)
    for (const call of evalRuns) {
      const outDir = call.command.split(' ')[call.command.split(' ').indexOf('--out') + 1]!
      expect(outDir.startsWith(workDir)).toBe(true)
      expect(call.options.writableDirs).toEqual([outDir])
      expect(call.options.copyDir).toBe(call.options.cwd)
    }
    for (const call of fake.calls.filter((call) => !call.command.startsWith('node eval'))) {
      expect(call.options.writableDirs ?? []).toEqual([])
      // Переменных eval у остальных команд нет; установке — только строгий файл-замок.
      expect(call.options.env ?? {}).toEqual(call.command === 'pnpm install' ? { npm_config_frozen_lockfile: 'true' } : {})
      expect(call.options.copyDir).toBe(call.options.cwd)
    }
  })

  it('ключи eval вырезаны из хвоста вывода и заметок', async () => {
    const fake = fakeRunner({ installOutput: { exitCode: 1, output: `ошибка: ключ ${EVAL_KEY} не подошёл` } })
    const result = await checksWith(fake).run(runInput())
    expect(result.tests.outputTail).toContain('ключ')
    expect(result.tests.outputTail).not.toContain(EVAL_KEY)
  })

  it('запрос eval не влез в долю (402) → прокси прерывает eval, итог не принят, расход учтён', async () => {
    const fake = fakeRunner({ evalHangsAtCostUsd: 0.5 })
    const result = await checksWith(fake).run(runInput({ reserveEval: async () => 0.6 }))
    expect(result.eval.status).toBe('not_run')
    expect(result.eval.note).toContain('бюджет')
    expect(result.eval.costUsd).toBeCloseTo(0.5)
    expect(fake.proxy.runs[0]?.options.budgetUsd).toBeCloseTo(0.6)
    expect(fake.calls.find((call) => call.command.startsWith('node eval'))?.options.signal?.aborted).toBe(true)
  })
})

describe('службы для тестов (checks.services)', () => {
  const servicesConfig = (services = 'test/services.yml') => testRemontnikConfig({ checks: { ...config.checks, services }, evalScope: config.evalScope })

  /** Основа с файлом служб; подставные службы пишут подъёмы и уборки в общий журнал с командами. */
  function setup(options: { upFails?: boolean; servicesPath?: string } = {}) {
    const base = tempDir()
    mkdirSync(join(base, 'test'))
    writeFileSync(join(base, 'test/services.yml'), 'services:\n  db:\n    image: postgres:17@sha256:'+'a'.repeat(64)+'\n')
    const fake = fakeRunner({ tests: [{ exitCode: 0 }] })
    const journal: string[] = []
    const run = fake.runner.run.bind(fake.runner)
    fake.runner.run = (command, runOptions) => {
      journal.push(`${typeof command === 'string' ? command : command.join(' ')} @ ${runOptions.cwd}`)
      return run(command, runOptions)
    }
    const services = {
      async up(copyDir: string, text: string) {
        journal.push(`up ${copyDir} ${text.includes('postgres:17') ? 'файл основы' : 'чужой файл'}`)
        if (options.upFails) throw new Error('службы для тестов не поднялись: db unhealthy')
        return { project: `p-${copyDir}`, down: async () => void journal.push(`down ${copyDir}`) }
      },
    }
    const checks = createChecks({ runner: fake.runner, config: servicesConfig(options.servicesPath), evalEnv: { EVAL_API_KEY: EVAL_KEY }, evalProxy: fake.proxy, baseCache: createMemoryEvalBaseCache(), workDir: tempDir(), timeoutSeconds: 60, services })
    return { base, fake, journal, checks }
  }

  it('службы поднимаются из файла основы до проверок своей копии и убираются после всех проверок', async () => {
    const { base, journal, checks } = setup()
    // Файл в копии правки модель могла поменять — врач его не берёт.
    const result = await checks.run(runInput({ baseDir: base }))
    expect(result.tests.status).toBe('green')
    expect(journal.filter((line) => line.startsWith('up') || line.startsWith('down'))).toEqual([
      `up ${candidateDir} файл основы`,
      `up ${base} файл основы`,
      `down ${candidateDir}`,
      `down ${base}`,
    ])
    const at = (line: string) => journal.indexOf(line)
    expect(at(`up ${candidateDir} файл основы`)).toBeGreaterThan(at(`pnpm install @ ${candidateDir}`))
    expect(at(`up ${candidateDir} файл основы`)).toBeLessThan(at(`pnpm typecheck @ ${candidateDir}`))
    expect(at(`up ${base} файл основы`)).toBeLessThan(journal.findIndex((line) => line.startsWith('node eval') && line.endsWith(`@ ${base}`)))
  })

  it('службы не поднялись → тесты красные с шагом services, команды тестов не идут', async () => {
    const { base, journal, checks } = setup({ upFails: true })
    const result = await checks.run(runInput({ baseDir: base }))
    expect(result.tests).toMatchObject({ status: 'red', failed: ['services'] })
    expect(result.tests.outputTail).toMatch(/unhealthy/)
    expect(journal.some((line) => line.startsWith('pnpm test'))).toBe(false)
  })

  it('службы заданы, а поднять их нечем → красные с объяснением, а не тесты без базы', async () => {
    const base = tempDir()
    const fake = fakeRunner({})
    const checks = createChecks({ runner: fake.runner, config: servicesConfig(), evalEnv: {}, baseCache: createMemoryEvalBaseCache(), workDir: tempDir(), timeoutSeconds: 60 })
    const result = await checks.run(runInput({ baseDir: base }))
    expect(result.tests).toMatchObject({ status: 'red', failed: ['services'] })
    expect(result.tests.outputTail).toMatch(/checks\.services/)
    expect(fake.calls.some((call) => call.command === 'pnpm test')).toBe(false)
  })

  it('файл служб вне копии основы — отказ', async () => {
    const { base, checks } = setup({ servicesPath: '../services.yml' })
    const result = await checks.run(runInput({ baseDir: base }))
    expect(result.tests).toMatchObject({ status: 'red', failed: ['services'] })
    expect(result.tests.outputTail).toMatch(/вне копии/)
  })
})
