import { describe, expect, it } from 'vitest'
import { crashAndRestart, createCrashWorld } from './crash-harness.js'
import { BROWSER_CRASH_POINT } from './world.js'

// Врач упал, пока его браузер ждёт человека (T081, история 8): отчёт `needs_human` уже ушёл, врача убивают на опросе
// службы браузера. После перезапуска ожидание продолжается с записанного начала: отчёт не повторяется, срок не обнуляется.

const statusPolls = (calls: string[]) => calls.filter((call) => call === 'status').length

describe.concurrent('врач падает посреди ожидания человека в браузере', () => {
  it('после перезапуска ждёт дальше; владелец вернул управление → модель видит страницу, отчёт needs_human один', async ({ onTestFinished }) => {
    const world = await createCrashWorld()
    onTestFinished(() => world.close())

    const { final, reportsBeforeCrash, restartOutput } = await crashAndRestart(world, BROWSER_CRASH_POINT, {
      browser: true,
      async afterRestart(doctor) {
        const before = statusPolls(world.browserState().calls)
        await doctor.waitFor(() => statusPolls(world.browserState().calls) >= before + 2, 'ожидание человека продолжилось')
        world.editBrowserState((state) => void (state.ownerReturned = true))
      },
    })

    // Врач умер уже после отчёта: после перезапуска он не повторяется.
    expect(reportsBeforeCrash).toEqual(['case_received', 'needs_human'])
    expect(final.state).toBe('healed')
    expect(restartOutput).toContain('HUMAN returned seen')
    expect(final.reports.map((report) => report.type)).toEqual(['case_received', 'needs_human', 'deployed', 'deployed'])
  }, 180_000)

  it('врач лежал дольше срока ожидания → после перезапуска сразу «без браузера», а не новые 30 минут; отчёт needs_human один', async ({ onTestFinished }) => {
    const world = await createCrashWorld()
    onTestFinished(() => world.close())
    let pollsBeforeRestart = 0

    const { final, restartOutput } = await crashAndRestart(world, BROWSER_CRASH_POINT, {
      browser: true,
      whileDown() {
        pollsBeforeRestart = statusPolls(world.browserState().calls)
        world.advanceClock(31 * 60_000)
      },
    })

    expect(final.state).toBe('healed')
    expect(restartOutput).toContain('HUMAN timeout seen')
    expect(statusPolls(world.browserState().calls) - pollsBeforeRestart).toBeLessThanOrEqual(1)
    expect(final.reports.map((report) => report.type)).toEqual(['case_received', 'needs_human', 'deployed', 'deployed'])
  }, 180_000)
})
