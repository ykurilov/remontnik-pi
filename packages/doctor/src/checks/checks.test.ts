import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { testRemontnikConfig } from '../testing/index.js'
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
      env: ['PATIENT_BUG', 'EVAL_API_KEY'],
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
  /** Eval пишет итог с этим расходом и не заканчивается, пока его не прервут. */
  evalHangsAtCostUsd?: number
  /** Вывод установки. */
  installOutput?: { exitCode: number; output: string }
  /** Тесты убить не удалось. */
  testsStillRunning?: boolean
}

function fakeRunner(options: FakeOptions) {
  const calls: { command: string; options: RunOptions }[] = []
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
        if (options.evalHangsAtCostUsd !== undefined) {
          writeFileSync(join(outDir, 'eval-result.json'), JSON.stringify({ scenarios: [], costUsd: options.evalHangsAtCostUsd }))
          await new Promise<void>((resolve) => runOptions.signal?.addEventListener('abort', () => resolve(), { once: true }))
          return { exitCode: null, timedOut: false, aborted: true, output: '' }
        }
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
            costUsd: options.evalCostUsd ?? 0.1,
          }),
        )
        return { exitCode: 0, timedOut: false, aborted: false, output: '' }
      }
      if (text === 'pnpm install' && options.installOutput) return { ...options.installOutput, timedOut: false, aborted: false }
      return { exitCode: 0, timedOut: false, aborted: false, output: '' }
    },
  }
  return { runner, calls }
}

const EVAL_KEY = 'eval-key-example-0000'

function checksWith(fake: ReturnType<typeof fakeRunner>, baseCache: EvalBaseCache = createMemoryEvalBaseCache(), workDir = tempDir()) {
  return createChecks({
    runner: fake.runner,
    config,
    evalEnv: { PATIENT_BUG: 'worsening_fix', EVAL_API_KEY: EVAL_KEY, DEEPSEEK_API_KEY: 'test-not-passed' },
    baseCache,
    workDir,
    timeoutSeconds: 60,
    costPollMs: 5,
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
    budgetUsd: 1,
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

  it('правка вне карты → not_needed, eval не запускается', async () => {
    const fake = fakeRunner({})
    const result = await checksWith(fake).run(runInput({ changedPaths: ['README.md'] }))
    expect(result.eval.status).toBe('not_needed')
    expect(fake.calls.some((call) => call.command.startsWith('node eval'))).toBe(false)
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
    await checksWith(fake).run(runInput({ budgetUsd: 0.6 }))
    const evalRuns = fake.calls.filter((call) => call.command.startsWith('node eval'))
    expect(evalRuns[0]?.command).toContain('--max-cost 0.6 ')
    expect(evalRuns[0]?.options.cwd).toBe(candidateDir)
    expect(evalRuns[1]?.command).toContain('--max-cost 0.35 ')

    const broke = fakeRunner({})
    const result = await checksWith(broke).run(runInput({ budgetUsd: 0 }))
    expect(result.eval.status).toBe('not_run')
    expect(broke.calls.some((call) => call.command.startsWith('node eval'))).toBe(false)
  })

  it('eval получает только переменные из настройки', async () => {
    const fake = fakeRunner({})
    await checksWith(fake).run(runInput())
    const evalRun = fake.calls.find((call) => call.command.startsWith('node eval'))
    expect(evalRun?.options.env).toEqual({ PATIENT_BUG: 'worsening_fix', EVAL_API_KEY: EVAL_KEY })
  })

  it('стоимость eval складывается', async () => {
    const fake = fakeRunner({ evalCostUsd: 0.2 })
    const result = await checksWith(fake).run(runInput())
    expect(result.eval.costUsd).toBeCloseTo(0.4)
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
      expect(call.options.env ?? {}).toEqual({})
      expect(call.options.copyDir).toBe(call.options.cwd)
    }
  })

  it('ключи eval вырезаны из хвоста вывода и заметок', async () => {
    const fake = fakeRunner({ installOutput: { exitCode: 1, output: `ошибка: ключ ${EVAL_KEY} не подошёл` } })
    const result = await checksWith(fake).run(runInput())
    expect(result.tests.outputTail).toContain('ключ')
    expect(result.tests.outputTail).not.toContain(EVAL_KEY)
  })

  it('eval потратил свою долю бюджета → врач его прерывает, расход учтён', async () => {
    const fake = fakeRunner({ evalHangsAtCostUsd: 0.7 })
    const result = await checksWith(fake).run(runInput({ budgetUsd: 0.6 }))
    expect(result.eval.status).toBe('not_run')
    expect(result.eval.note).toContain('бюджет')
    expect(result.eval.costUsd).toBeCloseTo(0.7)
    expect(fake.calls.find((call) => call.command.startsWith('node eval'))?.options.signal?.aborted).toBe(true)
  })
})
