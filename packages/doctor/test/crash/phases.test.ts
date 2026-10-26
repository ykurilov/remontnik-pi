import { describe, expect, it } from 'vitest'
import { crashAndRestart, createCrashWorld, git } from './crash-harness.js'
import { CRASH_POINTS, priceCrash, ROLLBACK_CRASH_POINT } from './world.js'

// Падения врача по фазам (T082): врача убивают в каждой точке и запускают снова. Случай должен дойти до конца,
// выкатка — не больше одной, приложение — на здоровой правке. Ничего из уже сделанного не повторяется дважды.

describe.concurrent('врач падает посреди лечения и продолжает после перезапуска', () => {
  for (const point of CRASH_POINTS) {
    it(`падение в точке ${point} → случай healed, одна выкатка, приложение на правке`, async ({ onTestFinished }) => {
      const world = await createCrashWorld()
      onTestFinished(() => world.close())

      const { final, restartOutput } = await crashAndRestart(world, point)

      expect(final.state).toBe('healed')
      const branch = git(world.origin, 'branch', '--list', 'remontnik/*').replace(/^[*\s]+/, '')
      expect(branch).toMatch(/^remontnik\/1-/)
      const fixCommit = git(world.origin, 'rev-parse', branch)
      const app = world.appState()
      expect(app.promotes).toBe(1)
      expect(app.rollbacks).toBe(0)
      expect(app.running).toBe(fixCommit)
      expect(app.previous).toBe(world.base)
      // Правка продержалась окно и влита в main; метка прежней версии — одна.
      expect(git(world.origin, 'rev-parse', 'main')).toBe(fixCommit)
      expect(git(world.origin, 'tag', '--list', 'remontnik/pre-deploy/*').split('\n')).toHaveLength(1)
      // Отчёты: без жалоб врача на себя и без повторов.
      expect(final.reports.map((report) => report.type)).toEqual(['case_received', 'deployed', 'deployed'])
      // Допуск к выкатке взят один раз: продолжение после перезапуска — не вторая попытка.
      expect((await world.ledger()).fingerprints[priceCrash().fingerprint]?.autoDeploys).toHaveLength(1)
      // Команду модели, на которой врач умер, модель видит прерванной и идёт дальше, а не повторяет её.
      if (point === 'fixing') expect(restartOutput).toContain('INTERRUPTED seen')
    }, 180_000)
  }

  it('падение сразу после отката плохой правки → случай rolled_back, откат один, main не тронута', async ({ onTestFinished }) => {
    const world = await createCrashWorld({ sickFix: true })
    onTestFinished(() => world.close())

    const { final } = await crashAndRestart(world, ROLLBACK_CRASH_POINT)

    expect(final.state).toBe('rolled_back')
    const app = world.appState()
    expect(app.promotes).toBe(1)
    expect(app.rollbacks).toBe(1)
    expect(app.running).toBe(world.base)
    expect(git(world.origin, 'rev-parse', 'main')).toBe(world.base)
    expect(final.reports.map((report) => report.type)).toEqual(['case_received', 'deployed', 'rolled_back'])
    expect((await world.ledger()).fingerprints[priceCrash().fingerprint]).toMatchObject({ needsHuman: true })
  }, 180_000)
})
