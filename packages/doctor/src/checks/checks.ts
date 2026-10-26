import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { RemontnikConfig } from '@ykurilov/remontnik-core/config'
import { redactSecrets } from '@ykurilov/remontnik-core/redact'
import { isRunnerConfigOrEvalPath } from '../diff-inspector/index.js'
import type { EvalProxy, EvalProxyProvider, EvalSpend } from '../eval-proxy/index.js'
import { SpoiledCopyError, type CommandRunner, type RunResult } from '../workbench/index.js'
import { ALL_SCENARIOS, selectEvalScenarios } from './eval-scope.js'

// Проверки правки (R5): установка, проверка типов, тесты и eval — обычным кодом, командами из настройки,
// на закоммиченной правке. Итог — CheckResult из data-model.md без поля браузера (его добавляет лечение).
// Упавшие тесты повторяются один раз: разный итог = flaky. Eval сравнивается с основой по каждому сценарию,
// итог основы кэшируется по паре (коммит, сценарий).
//
// Ключи модели в контейнер eval не попадают: eval ходит к модели через прокси врача (`eval-proxy`) с токеном
// прогона. Прокси сам считает расход и прерывает eval, когда его доля бюджета кончилась; `costUsd` из файла
// итога не читается — его пишет код правки. Скрипты eval — только из основы: правка, задевшая их, eval не
// запускает. Тесты, проверка типов и eval идут во внутренней сети (видно только прокси); установка — во внешней.
// Итог eval лежит вне копий, и писать туда может только он. Хвосты вывода и заметки вычищаются от ключей.

export interface EvalScenarioResult {
  id: string
  repeats: number
  pass: number
  fail: number
  standBroken: number
  personaBroken: number
}

export interface EvalScenarioComparison {
  id: string
  basePass: number
  candidatePass: number
  repeats: number
}

export interface TestsOutcome {
  status: 'green' | 'red' | 'flaky' | 'not_run'
  failed: string[]
  durationMs: number
  /** Хвост вывода, когда имена упавших тестов разобрать не удалось или упала установка/проверка типов. */
  outputTail?: string
}

export interface EvalOutcome {
  status: 'not_needed' | 'not_worse' | 'worse' | 'stand_broken' | 'not_run'
  scenarios: EvalScenarioComparison[]
  costUsd: number
  /** Сценарии отрезаны пределом `maxScenarios`. */
  truncated?: boolean
  /** Почему eval не дал ответа (для отчёта). */
  note?: string
}

export interface ChecksResult {
  tests: TestsOutcome
  eval: EvalOutcome
}

export interface EvalBaseCache {
  get(commit: string, scenario: string): Promise<EvalScenarioResult | undefined>
  set(commit: string, scenario: string, result: EvalScenarioResult): Promise<void>
}

export function createMemoryEvalBaseCache(): EvalBaseCache {
  const results = new Map<string, EvalScenarioResult>()
  return {
    get: async (commit, scenario) => results.get(`${commit}\0${scenario}`),
    set: async (commit, scenario, result) => {
      results.set(`${commit}\0${scenario}`, result)
    },
  }
}

export interface ChecksOptions {
  runner: CommandRunner
  config: RemontnikConfig
  /** Окружение врача: eval получает из него переменные `checks.eval.env`, прокси — ключи `providers[].keyEnv`. */
  evalEnv: Readonly<Record<string, string | undefined>>
  /** Прокси модели; без него eval с провайдерами не запускается. */
  evalProxy?: Pick<EvalProxy, 'openRun'>
  baseCache: EvalBaseCache
  /** Папка для итогов eval (`{outDir}`), вне копий: команды правки до неё не дотягиваются. */
  workDir: string
  /** Тайм-аут одной команды. */
  timeoutSeconds: number
  now?: () => number
}

export interface ChecksInput {
  /** Копия с закоммиченной правкой. */
  candidateDir: string
  /** Копия основы — для eval основы. */
  baseDir: string
  baseCommit: string
  changedPaths: readonly string[]
  /** Правку может проверить только eval (плохой ответ бота): нет сценариев по карте — eval «не запускался», а не «не нужен». */
  evalRequired?: boolean
  /**
   * Бронирует деньги на eval и возвращает долю. Зовётся прямо перед первым запуском eval;
   * eval не дошёл до запуска — брони нет.
   */
  reserveEval: () => Promise<number>
  /** Расход eval по прокси за все прогоны этой проверки — по ходу, для дневного учёта. Прокси ждёт записи. */
  onEvalSpend?: (spend: EvalSpend) => Promise<void> | void
}

const FAILED_LINE = /^REMONTNIK_FAILED=(.*)$/m
const TESTCASE = /<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g
const OUTPUT_TAIL_CHARS = 4_000

function xmlAttribute(attributes: string, name: string): string | undefined {
  const match = attributes.match(new RegExp(`\\b${name}="([^"]*)"`))
  return match?.[1]
    ?.replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&amp;', '&')
}

/** Имена упавших тестов из вывода: строка `REMONTNIK_FAILED=` или JUnit XML. Не нашлось — пустой список. */
export function parseFailedTests(output: string): string[] {
  const line = output.match(FAILED_LINE)
  if (line) return line[1]!.split(';').map((name) => name.trim()).filter(Boolean)
  const failed: string[] = []
  for (const match of output.matchAll(TESTCASE)) {
    const body = match[3] ?? ''
    if (!/<(failure|error)\b/.test(body)) continue
    const name = xmlAttribute(match[1]!, 'name') ?? '?'
    const group = xmlAttribute(match[1]!, 'classname')
    failed.push(group ? `${group} › ${name}` : name)
  }
  return failed
}

function formatUsd(value: number): string {
  return String(Math.max(0, Number(value.toFixed(4))))
}

function shellWord(text: string): string {
  return /^[\w@%+=:,./-]+$/.test(text) ? text : `'${text.replaceAll("'", `'\\''`)}'`
}

function isScenarioResult(value: unknown): value is EvalScenarioResult {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return (
    typeof record.id === 'string' &&
    ['repeats', 'pass', 'fail', 'standBroken', 'personaBroken'].every(
      (key) => typeof record[key] === 'number' && Number.isInteger(record[key]) && (record[key] as number) >= 0,
    )
  )
}

interface EvalRun {
  ok: boolean
  /** Прерван: запрос не влез в долю (402). */
  overBudget?: boolean
  scenarios: EvalScenarioResult[]
  costUsd: number
  note?: string
}

export function createChecks(options: ChecksOptions) {
  const now = options.now ?? Date.now
  const { config } = options
  const evalSecrets = [...Object.values(evalEnv()), ...(config.checks.eval?.providers ?? []).flatMap((provider) => options.evalEnv[provider.keyEnv] ?? [])].filter(
    (value) => value.length >= 8,
  )

  function tail(output: string): string {
    return redactSecrets(output, { knownSecrets: evalSecrets }).slice(-OUTPUT_TAIL_CHARS)
  }

  /** Команда в копии `cwd`; писать вне копии можно только в `writableDirs`. Неубитая команда — копии и итогам не верим. */
  async function run(
    command: string,
    cwd: string,
    extra: { env?: Record<string, string>; writableDirs?: string[]; signal?: AbortSignal; network?: 'internal' } = {},
  ): Promise<RunResult> {
    const result = await options.runner.run(command, {
      cwd,
      copyDir: cwd,
      env: extra.env ?? {},
      timeoutSeconds: options.timeoutSeconds,
      ...(extra.writableDirs ? { writableDirs: extra.writableDirs } : {}),
      ...(extra.signal ? { signal: extra.signal } : {}),
      ...(extra.network ? { network: extra.network } : {}),
    })
    if (result.stillRunning) throw new SpoiledCopyError(cwd)
    return result
  }

  function failedStep(name: string, result: RunResult, startedAt: number): TestsOutcome {
    const why = result.timedOut ? `${name}: не уложилось в ${options.timeoutSeconds} с` : `${name}: код ${result.exitCode ?? '—'}`
    return { status: 'red', failed: [name], durationMs: now() - startedAt, outputTail: tail(`${why}\n${result.spawnError ?? ''}${result.output}`) }
  }

  async function runTests(dir: string): Promise<TestsOutcome> {
    const startedAt = now()
    const install = await run(config.workbench.install, dir)
    if (install.exitCode !== 0) return failedStep('install', install, startedAt)
    if (config.checks.typecheck) {
      const typecheck = await run(config.checks.typecheck, dir, { network: 'internal' })
      if (typecheck.exitCode !== 0) return failedStep('typecheck', typecheck, startedAt)
    }
    const first = await run(config.checks.test, dir, { network: 'internal' })
    if (first.exitCode === 0) return { status: 'green', failed: [], durationMs: now() - startedAt }
    const firstFailed = parseFailedTests(first.output)
    const second = await run(config.checks.test, dir, { network: 'internal' })
    if (second.exitCode === 0) return { status: 'flaky', failed: firstFailed, durationMs: now() - startedAt }
    const failed = parseFailedTests(second.output)
    const names = failed.length > 0 ? failed : firstFailed
    return {
      status: 'red',
      failed: names,
      durationMs: now() - startedAt,
      ...(names.length === 0 ? { outputTail: tail(second.timedOut ? `тесты не уложились в ${options.timeoutSeconds} с\n${second.output}` : second.output) } : {}),
    }
  }

  function evalEnv(): Record<string, string> {
    const env: Record<string, string> = {}
    for (const name of config.checks.eval?.env ?? []) {
      const value = options.evalEnv[name]
      if (value !== undefined) env[name] = value
    }
    return env
  }

  /** Провайдеры с ключами из окружения врача; ключа нет — имя переменной для заметки. */
  function evalProviders(): { providers: EvalProxyProvider[]; missing?: string } {
    const providers: EvalProxyProvider[] = []
    for (const provider of config.checks.eval?.providers ?? []) {
      const key = options.evalEnv[provider.keyEnv]
      if (!key) return { providers, missing: provider.keyEnv }
      providers.push({ ...provider, key })
    }
    return { providers }
  }

  async function runEval(
    dir: string,
    label: string,
    scenarios: readonly string[],
    maxCostUsd: number,
    providers: EvalProxyProvider[],
    onSpend: (spend: EvalSpend) => Promise<void>,
  ): Promise<EvalRun> {
    const evalConfig = config.checks.eval!
    mkdirSync(options.workDir, { recursive: true })
    const outDir = mkdtempSync(join(options.workDir, `eval-${label}-`))
    const command = evalConfig.run
      .replaceAll('{scenarios}', scenarios.join(','))
      .replaceAll('{repeat}', String(evalConfig.repeat))
      .replaceAll('{maxCostUsd}', formatUsd(maxCostUsd))
      .replaceAll('{outDir}', shellWord(outDir))
    const proxyRun = providers.length > 0 ? options.evalProxy!.openRun({ providers, tokenEnv: evalConfig.tokenEnv, budgetUsd: maxCostUsd, limits: evalConfig.proxy, onSpend }) : undefined
    let result: RunResult
    try {
      result = await run(command, dir, {
        env: { ...evalEnv(), ...proxyRun?.env },
        writableDirs: [outDir],
        network: 'internal',
        ...(proxyRun ? { signal: proxyRun.overBudget } : {}),
      })
    } finally {
      await proxyRun?.close()
    }
    const costUsd = proxyRun?.spentUsd() ?? 0
    // Только отказ 402 рвёт eval; дошёл до доли без отказа — итог принимается.
    if (proxyRun?.overBudget.aborted) {
      return { ok: false, overBudget: true, scenarios: [], costUsd, note: `eval (${label}) прерван: запрос не влез в бюджет $${formatUsd(maxCostUsd)}` }
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(readFileSync(join(outDir, evalConfig.resultFile), 'utf8'))
    } catch {
      return { ok: false, scenarios: [], costUsd, note: `eval (${label}) не оставил итог: код ${result.exitCode ?? '—'}\n${tail(result.output)}` }
    }
    const record = (typeof parsed === 'object' && parsed !== null ? parsed : {}) as Record<string, unknown>
    if (!Array.isArray(record.scenarios) || !record.scenarios.every(isScenarioResult)) {
      return { ok: false, scenarios: [], costUsd, note: `итог eval (${label}) не по контракту` }
    }
    return { ok: result.exitCode === 0, scenarios: record.scenarios, costUsd, ...(result.exitCode === 0 ? {} : { note: `eval (${label}) завершился с кодом ${result.exitCode ?? '—'}` }) }
  }

  async function runEvalChecks(input: ChecksInput, tests: TestsOutcome): Promise<EvalOutcome> {
    const evalConfig = config.checks.eval
    if (!evalConfig) {
      return input.evalRequired ? { status: 'not_run', scenarios: [], costUsd: 0, note: 'eval в настройке не задан' } : { status: 'not_needed', scenarios: [], costUsd: 0 }
    }
    const selection = selectEvalScenarios(
      { evalScope: config.evalScope, closedPaths: config.closedPaths, maxScenarios: evalConfig.maxScenarios },
      input.changedPaths,
    )
    if (selection.status === 'not_needed') {
      return input.evalRequired
        ? { status: 'not_run', scenarios: [], costUsd: 0, note: 'карта evalScope не даёт сценариев для изменённых путей' }
        : { status: 'not_needed', scenarios: [], costUsd: 0 }
    }
    const truncated = selection.truncated ? { truncated: true } : {}
    if (tests.status !== 'green') return { status: 'not_run', scenarios: [], costUsd: 0, ...truncated, note: 'тесты не зелёные' }
    const touched = input.changedPaths.filter((path) => isRunnerConfigOrEvalPath(path))
    if (touched.length > 0) return { status: 'not_run', scenarios: [], costUsd: 0, ...truncated, note: `правка задела eval или настройку тестов: ${touched.join(', ')}` }
    const { providers, missing } = evalProviders()
    if (missing) return { status: 'not_run', scenarios: [], costUsd: 0, ...truncated, note: `у врача нет ключа модели для eval (${missing})` }
    if (providers.length > 0 && !options.evalProxy) return { status: 'not_run', scenarios: [], costUsd: 0, ...truncated, note: 'прокси модели для eval не включён' }
    const budgetUsd = await input.reserveEval()
    if (budgetUsd <= 0) return { status: 'not_run', scenarios: [], costUsd: 0, ...truncated, note: 'на eval не осталось денег' }

    // Расход прошлых прогонов этой проверки + текущего: дневной учёт видит итог по ходу.
    let settledUsd = 0
    const onSpend = async (spend: EvalSpend) => {
      await input.onEvalSpend?.({ spentUsd: settledUsd + spend.spentUsd, inFlightUsd: spend.inFlightUsd })
    }
    const candidate = await runEval(input.candidateDir, 'candidate', selection.scenarios, budgetUsd, providers, onSpend)
    settledUsd = candidate.costUsd
    let costUsd = candidate.costUsd
    if (candidate.overBudget) return { status: 'not_run', scenarios: [], costUsd, ...truncated, note: candidate.note! }
    if (!candidate.ok) return { status: 'stand_broken', scenarios: [], costUsd, ...truncated, ...(candidate.note ? { note: candidate.note } : {}) }

    // «Всё» — список сценариев знает только сам eval, поэтому основа для него не кэшируется.
    const runAll = selection.scenarios.includes(ALL_SCENARIOS)
    const ids = runAll ? candidate.scenarios.map((scenario) => scenario.id) : selection.scenarios
    const base = new Map<string, EvalScenarioResult>()
    if (!runAll) {
      for (const id of ids) {
        const cached = await options.baseCache.get(input.baseCommit, id)
        if (cached) base.set(id, cached)
      }
    }
    const missingScenarios = runAll ? [ALL_SCENARIOS] : ids.filter((id) => !base.has(id))
    if (missingScenarios.length > 0) {
      const remaining = budgetUsd - costUsd
      if (remaining <= 0) return { status: 'not_run', scenarios: [], costUsd, ...truncated, note: 'на eval основы не осталось денег' }
      const baseInstall = await run(config.workbench.install, input.baseDir)
      if (baseInstall.exitCode !== 0) return { status: 'stand_broken', scenarios: [], costUsd, ...truncated, note: `установка зависимостей основы: код ${baseInstall.exitCode ?? '—'}` }
      const baseRun = await runEval(input.baseDir, 'base', missingScenarios, remaining, providers, onSpend)
      costUsd += baseRun.costUsd
      if (baseRun.overBudget) return { status: 'not_run', scenarios: [], costUsd, ...truncated, note: baseRun.note! }
      if (!baseRun.ok) return { status: 'stand_broken', scenarios: [], costUsd, ...truncated, ...(baseRun.note ? { note: baseRun.note } : {}) }
      for (const result of baseRun.scenarios) {
        base.set(result.id, result)
        // Сломанный стенд — не итог основы: в кэш он не идёт, в следующий раз основа прогонится снова.
        if (!runAll && result.standBroken === 0 && result.personaBroken === 0) await options.baseCache.set(input.baseCommit, result.id, result)
      }
    }

    const scenarios: EvalScenarioComparison[] = []
    let broken = false
    let worse = false
    for (const id of ids) {
      const candidateResult = candidate.scenarios.find((scenario) => scenario.id === id)
      const baseResult = base.get(id)
      if (!candidateResult || !baseResult) {
        broken = true
        continue
      }
      if (candidateResult.standBroken + candidateResult.personaBroken + baseResult.standBroken + baseResult.personaBroken > 0) broken = true
      if (candidateResult.pass < baseResult.pass) worse = true
      scenarios.push({ id, basePass: baseResult.pass, candidatePass: candidateResult.pass, repeats: candidateResult.repeats })
    }
    const status = broken ? 'stand_broken' : worse ? 'worse' : 'not_worse'
    return { status, scenarios, costUsd, ...truncated }
  }

  return {
    async run(input: ChecksInput): Promise<ChecksResult> {
      const tests = await runTests(input.candidateDir)
      return { tests, eval: await runEvalChecks(input, tests) }
    },
  }
}

export type Checks = ReturnType<typeof createChecks>
