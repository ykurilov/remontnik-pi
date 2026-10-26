import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { createBot } from '../src/bot/bot.ts'
import { parsePatientBug, type PatientBug } from '../src/bugs.ts'

// Подставной eval «Пациента»: сценарии с заранее известным итогом, без моделей и без денег.
// Итог — в формате contracts/deploy-commands.md.

export interface EvalScenario {
  id: string
  message: string
  expectText: string
}

export const EVAL_SCENARIOS: readonly EvalScenario[] = [
  { id: 'greeting', message: 'Привет!', expectText: 'Здравствуйте' },
  { id: 'price-named-plan', message: 'Сколько стоит тариф Про?', expectText: '2990' },
  { id: 'price-default-plan', message: 'Сколько стоит подписка?', expectText: '990' },
  { id: 'order-status', message: 'Где мой заказ 42?', expectText: 'Заказ 42' },
  { id: 'small-talk', message: 'Как у вас дела?', expectText: 'тарифы и заказы' },
]

export interface ScenarioResult {
  id: string
  repeats: number
  pass: number
  fail: number
  standBroken: number
  personaBroken: number
}

export interface EvalResult {
  scenarios: ScenarioResult[]
  costUsd: number
}

export interface RunEvalOptions {
  scenarios: string[] | 'all'
  repeat: number
  bug: PatientBug | null
}

export async function runEval(options: RunEvalOptions): Promise<EvalResult> {
  const ids = options.scenarios === 'all' ? EVAL_SCENARIOS.map((scenario) => scenario.id) : options.scenarios
  // Падение процесса при PATIENT_BUG=crash в eval не нужно: ответ уже получен.
  const bot = createBot({ bug: options.bug, crashProcess: () => undefined })
  const scenarios: ScenarioResult[] = []

  for (const id of ids) {
    const result: ScenarioResult = { id, repeats: options.repeat, pass: 0, fail: 0, standBroken: 0, personaBroken: 0 }
    const scenario = EVAL_SCENARIOS.find((known) => known.id === id)
    for (let attempt = 0; attempt < options.repeat; attempt += 1) {
      if (!scenario) {
        result.standBroken += 1
        continue
      }
      const reply = await bot.reply(scenario.message).catch(() => null)
      if (reply?.includes(scenario.expectText)) result.pass += 1
      else result.fail += 1
    }
    scenarios.push(result)
  }
  return { scenarios, costUsd: 0 }
}

export const EVAL_RESULT_FILE = 'eval-result.json'

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      scenarios: { type: 'string', default: 'all' },
      repeat: { type: 'string', default: '3' },
      'max-cost': { type: 'string', default: '0' },
      out: { type: 'string' },
    },
  })
  if (!values.out) throw new Error('нужен --out <папка>')
  const repeat = Number(values.repeat)
  if (!Number.isInteger(repeat) || repeat < 1) throw new Error(`--repeat ${values.repeat}: ожидается целое ≥ 1`)
  const scenarios = values.scenarios === 'all' ? 'all' : values.scenarios.split(',').map((id) => id.trim()).filter(Boolean)

  const result = await runEval({ scenarios, repeat, bug: parsePatientBug(process.env.PATIENT_BUG) })
  const outDir = resolve(values.out)
  mkdirSync(outDir, { recursive: true })
  writeFileSync(join(outDir, EVAL_RESULT_FILE), `${JSON.stringify(result, null, 2)}\n`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(`[patient eval] ${error instanceof Error ? error.message : String(error)}`)
    process.exit(2)
  })
}
