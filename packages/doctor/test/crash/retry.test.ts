import { describe, expect, it } from 'vitest'
import { createCrashWorld, FINAL_STATES, git, runDoctor } from './crash-harness.js'
import { priceCrash } from './world.js'

// Задача лечения, которая сама не продолжится (T085): упала насовсем или остановлена после повторных падений врача.
// Владелец получает отчёт со случаем и командой, `case <id> retry` ставит случай в работу снова. Так же — случай,
// закончившийся без излечения: сам он второй раз не лечится, только командой владельца.

describe.concurrent('лечение, которое само не продолжится, владелец ставит в работу снова', () => {
  it('задача упала насовсем → отчёт с командой; case 1 retry → новая попытка на своей ветке, случай healed', async ({ onTestFinished }) => {
    const world = await createCrashWorld()
    onTestFinished(() => world.close())
    const doctor = runDoctor(world, { faultAt: 'fixing', sendEvent: true })
    onTestFinished(async () => void (await doctor.stop()))

    const problem = await doctor.waitForReport('doctor_problem')
    expect(problem.short).toContain('случая 1')
    expect(problem.short).toContain('remontnik-doctor case 1 retry')

    const retried = await doctor.command(['case', '1', 'retry', '--by', 'owner'])
    expect(retried).toMatchObject({ code: 0 })
    expect(JSON.parse(retried.out)).toEqual({ caseId: 1, retried: 'restarted', attempt: 2 })
    // Вторая команда, пока новая попытка идёт, ничего не запускает.
    const again = await doctor.command(['case', '1', 'retry'])
    expect(again.err).toContain('409 already_running')

    const final = await doctor.waitForState(FINAL_STATES, 90_000)
    expect(final.state).toBe('healed')
    const branch = git(world.origin, 'branch', '--list', 'remontnik/*').replace(/^[*\s]+/, '')
    expect(branch).toMatch(/^remontnik\/1-.*-r2$/)
    const app = world.appState()
    expect(app.promotes).toBe(1)
    expect(app.running).toBe(git(world.origin, 'rev-parse', branch))
    expect(final.reports.map((report) => report.type)).toEqual(['case_received', 'doctor_problem', 'deployed', 'deployed'])
    await doctor.stop()
    expect((await world.ledger()).fingerprints[priceCrash().fingerprint]?.autoDeploys).toHaveLength(1)
  }, 180_000)

  it('врач раз за разом падает в одном месте → задача остановлена, отчёт с командой; case 1 retry → продолжает с чекпойнта', async ({ onTestFinished }) => {
    const world = await createCrashWorld()
    onTestFinished(() => world.close())
    const first = runDoctor(world, { crashAt: 'verifying', sendEvent: true })
    expect((await first.exited).signal).toBe('SIGKILL')

    // pi-durable останавливает задачу после пяти падений подряд без продвижения.
    let parked = false
    for (let restart = 0; restart < 8 && !parked; restart += 1) {
      const doctor = runDoctor(world, { crashAt: 'verifying' })
      const ended = await Promise.race([doctor.exited.then(() => 'died' as const), doctor.waitForReport('doctor_problem', 20_000).then(() => 'parked' as const, () => 'died' as const)])
      if (ended === 'parked') {
        parked = true
        expect(doctor.output()).toContain('task_parked')
      }
      await doctor.stop()
    }
    expect(parked).toBe(true)

    // Остановленная задача и после перезапуска стоит, пока владелец не скажет.
    const doctor = runDoctor(world)
    onTestFinished(async () => void (await doctor.stop()))
    const problem = await doctor.waitForReport('doctor_problem')
    expect(problem.short).toContain('remontnik-doctor case 1 retry')
    expect(doctor.states.at(-1)?.state).toBe('verifying')

    const retried = await doctor.command(['case', '1', 'retry', '--by', 'owner'])
    expect(JSON.parse(retried.out)).toEqual({ caseId: 1, retried: 'parked', attempt: 1 })

    const final = await doctor.waitForState(FINAL_STATES, 90_000)
    expect(final.state).toBe('healed')
    const branch = git(world.origin, 'branch', '--list', 'remontnik/*').replace(/^[*\s]+/, '')
    expect(branch).toMatch(/^remontnik\/1-/)
    expect(branch).not.toMatch(/-r\d+$/)
    expect(world.appState().promotes).toBe(1)
  }, 180_000)

  it('лечение кончилось «только отчётом» из-за поломки набора → повтор сбоя сам не лечится; после обновления врача case 1 retry → новая попытка, случай healed', async ({ onTestFinished }) => {
    const world = await createCrashWorld()
    onTestFinished(() => world.close())
    const broken = runDoctor(world, { brokenChecks: true, sendEvent: true })
    onTestFinished(async () => void (await broken.stop()))
    const first = await broken.waitForState(FINAL_STATES, 90_000)
    expect(first.state).toBe('report_only')
    expect(first.reports.at(-1)?.type).toBe('cause_found')
    expect(first.reports.at(-1)?.short).toContain('remontnik-doctor case 1 retry')
    await broken.stop()

    // Набор починен, врач перезапущен, сбой повторился: он склеивается со случаем, лечение само не начинается.
    const doctor = runDoctor(world, { sendEvent: true })
    onTestFinished(async () => void (await doctor.stop()))
    const glued = await doctor.waitForState(['report_only'])
    expect(glued.events).toBe(2)
    expect(glued.reports.map((report) => report.type)).toEqual(['case_received', 'cause_found'])

    const retried = await doctor.command(['case', '1', 'retry', '--by', 'owner'])
    expect(retried).toMatchObject({ code: 0 })
    // Ветка прошлой попытки остаётся, ответ её называет.
    expect(JSON.parse(retried.out)).toEqual({ caseId: 1, retried: 'restarted', attempt: 2, previousBranch: expect.stringMatching(/^remontnik\/1-/) })

    const final = await doctor.waitForState(['healed'], 90_000)
    const branches = git(world.origin, 'branch', '--list', 'remontnik/*').replace(/^[*\s]+/gm, '').split('\n')
    expect(branches.some((branch) => /^remontnik\/1-.*-r2$/.test(branch))).toBe(true)
    expect(world.appState().promotes).toBe(1)
    expect(final.reports.map((report) => report.type)).toEqual(['case_received', 'cause_found', 'deployed', 'deployed'])
    const again = await doctor.command(['case', '1', 'retry'])
    expect(again.err).toContain('409 case_finished')
  }, 180_000)
})
