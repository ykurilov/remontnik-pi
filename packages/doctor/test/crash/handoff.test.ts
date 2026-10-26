import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { crashAndRestart, createCrashWorld, type CrashWorld, type DoctorProcess } from './crash-harness.js'
import { STAND_BRIDGE_SILENCE_MS } from './world.js'

// Врач падает посреди передачи случая агенту Paseo (T124): фазы передачи — чекпойнты, после перезапуска передача
// продолжается. Мост не получает второго письма агенту, задача агента отменяется один раз, выкатку агента врач
// наблюдает дальше, а не бросает.

/** Агент Paseo: подключён к врачу и ждёт, пока случай ему передадут. */
async function agentGetsCase(world: CrashWorld, doctor: DoctorProcess): Promise<void> {
  world.bridge!.connect(await doctor.bridgeUrl())
  await doctor.waitForReport('handed_off')
}

const types = (reports: { type: string }[]) => reports.map((report) => report.type)

/** Время по часам врача: сдвиг часов лежит в файле мира и переживает перезапуск. */
const doctorNow = (world: CrashWorld) => Date.now() + Number(readFileSync(world.clockPath, 'utf8'))

describe.concurrent('врач падает посреди передачи случая Paseo', () => {
  it('мост принял задачу, передача не записана → после перезапуска то же письмо, агент сделал — случай закрыт агентом', async ({ onTestFinished }) => {
    const world = await createCrashWorld({ paseo: true })
    onTestFinished(() => world.close())

    const { final, reportsBeforeCrash } = await crashAndRestart(world, 'handoff_sent', {
      async afterRestart(doctor) {
        await agentGetsCase(world, doctor)
        expect((await world.bridge!.accept(1)).status).toBe(200)
        expect((await world.bridge!.done(1, { commit: 'abc1234' })).status).toBe(200)
      },
    })

    expect(reportsBeforeCrash).toEqual(['case_received'])
    expect(final.state).toBe('healed_by_paseo')
    // Номер задачи помнится: повтор мост узнаёт, второго письма агенту нет.
    expect(world.bridge!.tasks).toHaveLength(1)
    expect(types(final.reports)).toEqual(['case_received', 'handed_off', 'paseo_done'])
    expect(world.appState().promotes).toBe(0)
  }, 180_000)

  it('агент работает → после перезапуска врач ждёт его дальше, а не лечит сам', async ({ onTestFinished }) => {
    const world = await createCrashWorld({ paseo: true })
    onTestFinished(() => world.close())

    const { final } = await crashAndRestart(world, 'paseo_working', {
      async whileUp(doctor) {
        await agentGetsCase(world, doctor)
        await world.bridge!.accept(1)
      },
      async afterRestart(doctor) {
        world.bridge!.connect(await doctor.bridgeUrl())
        await doctor.waitForState(['paseo_working'])
        expect((await world.bridge!.done(1, { commit: 'abc1234' })).status).toBe(200)
      },
    })

    expect(final.state).toBe('healed_by_paseo')
    expect(world.bridge!.cancels).toHaveLength(0)
    expect(types(final.reports)).toEqual(['case_received', 'handed_off', 'paseo_done'])
  }, 180_000)

  it('врач наблюдает выкатку агента → после перезапуска наблюдение продолжается; держится — confirm, отката нет', async ({ onTestFinished }) => {
    const world = await createCrashWorld({ paseo: true })
    onTestFinished(() => world.close())

    const { final } = await crashAndRestart(world, 'paseo_observing', {
      async whileUp(doctor) {
        await agentGetsCase(world, doctor)
        await world.bridge!.accept(1)
        // Агент выкатил по правилам приложения: работает его версия, прежняя — на месте для отката.
        world.editAppState((state) => {
          state.previous = state.running
          state.running = 'agent-v2'
        })
        await world.bridge!.done(1, { commit: 'abc1234', version: 'agent-v2' })
      },
    })

    expect(final.state).toBe('healed_by_paseo')
    const app = world.appState()
    expect(app.running).toBe('agent-v2')
    expect(app.rollbacks).toBe(0)
    expect(app.promotes).toBe(0)
    expect(app.calls).toContain('confirm')
    expect(types(final.reports)).toEqual(['case_received', 'handed_off', 'paseo_done', 'paseo_done'])
  }, 180_000)

  it('врач забрал случай, отмена не ушла → после перезапуска отмена одна, дальше врач лечит сам', async ({ onTestFinished }) => {
    const world = await createCrashWorld({ paseo: true })
    onTestFinished(() => world.close())

    const { final, reportsBeforeCrash } = await crashAndRestart(world, 'before_cancel', {
      async whileUp(doctor) {
        await agentGetsCase(world, doctor)
        await world.bridge!.accept(1)
        await world.bridge!.cannot(1, 'не нашёл, где считается цена')
      },
    })

    expect(reportsBeforeCrash).toEqual(['case_received', 'handed_off', 'reclaimed'])
    expect(world.bridge!.cancels).toHaveLength(1)
    expect(final.state).toBe('healed')
    expect(types(final.reports).filter((type) => type === 'reclaimed')).toHaveLength(1)
  }, 180_000)
  it('мост молчит → после перезапуска отсчёт молчания продолжается, а не начинается заново', async ({ onTestFinished }) => {
    const world = await createCrashWorld({ paseo: true })
    onTestFinished(() => world.close())
    let restartAt = 0

    const { final } = await crashAndRestart(world, 'bridge_silent', {
      async whileUp(doctor) {
        await agentGetsCase(world, doctor)
        await world.bridge!.accept(1)
        world.bridge!.health = 'down'
      },
      whileDown() {
        // Врач пролежал почти всё молчание моста: забрать случай он должен вскоре после перезапуска.
        world.advanceClock(STAND_BRIDGE_SILENCE_MS - 10_000)
        restartAt = doctorNow(world)
      },
      async afterRestart(doctor) {
        await doctor.waitForReport('reclaimed')
        world.bridge!.health = 'up'
      },
    })

    expect(final.state).toBe('healed')
    const handoff = (await world.handoff(1))!
    expect(handoff).toMatchObject({ owner: 'doctor', reclaimReason: 'bridge_unreachable', cancelSent: true })
    expect(Date.parse(handoff.reclaimedAt!) - restartAt).toBeLessThan(STAND_BRIDGE_SILENCE_MS / 2)
    expect(world.bridge!.cancels).toHaveLength(1)
  }, 180_000)
})
