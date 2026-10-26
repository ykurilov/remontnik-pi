import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { EVAL_SCENARIOS, runEval } from '../eval/run-eval.ts'

const patientRoot = fileURLToPath(new URL('..', import.meta.url))
let outDir: string | undefined

afterEach(() => {
  if (outDir) rmSync(outDir, { recursive: true, force: true })
  outDir = undefined
})

describe('подставной eval «Пациента»', () => {
  it('без ошибок все сценарии проходят, расход 0', async () => {
    const result = await runEval({ scenarios: 'all', repeat: 3, bug: null })

    expect(result.costUsd).toBe(0)
    expect(result.scenarios.map((scenario) => scenario.id)).toEqual(EVAL_SCENARIOS.map((scenario) => scenario.id))
    for (const scenario of result.scenarios) {
      expect(scenario).toEqual({ id: scenario.id, repeats: 3, pass: 3, fail: 0, standBroken: 0, personaBroken: 0 })
    }
  })

  it('worsening_fix: падает только сценарий цены без тарифа', async () => {
    const result = await runEval({ scenarios: ['price-named-plan', 'price-default-plan'], repeat: 2, bug: 'worsening_fix' })

    expect(result.scenarios).toEqual([
      { id: 'price-named-plan', repeats: 2, pass: 2, fail: 0, standBroken: 0, personaBroken: 0 },
      { id: 'price-default-plan', repeats: 2, pass: 0, fail: 2, standBroken: 0, personaBroken: 0 },
    ])
  })

  it('неизвестный сценарий — сломанный стенд, а не провал', async () => {
    const result = await runEval({ scenarios: ['nope'], repeat: 2, bug: null })

    expect(result.scenarios).toEqual([{ id: 'nope', repeats: 2, pass: 0, fail: 0, standBroken: 2, personaBroken: 0 }])
  })

  it('команда из настройки пишет итог в формате контракта', () => {
    outDir = mkdtempSync(join(tmpdir(), 'patient-eval-'))

    execFileSync(
      process.execPath,
      ['eval/run-eval.ts', '--scenarios', 'greeting,small-talk', '--repeat', '3', '--max-cost', '0.5', '--out', outDir],
      { cwd: patientRoot, env: { ...process.env, PATIENT_BUG: 'model_error' }, stdio: 'pipe' },
    )

    const result = JSON.parse(readFileSync(join(outDir, 'eval-result.json'), 'utf8'))
    expect(result).toEqual({
      scenarios: [
        { id: 'greeting', repeats: 3, pass: 3, fail: 0, standBroken: 0, personaBroken: 0 },
        { id: 'small-talk', repeats: 3, pass: 0, fail: 3, standBroken: 0, personaBroken: 0 },
      ],
      costUsd: 0,
    })
  })
})
