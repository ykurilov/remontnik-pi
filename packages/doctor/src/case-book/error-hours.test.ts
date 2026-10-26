import { describe, expect, it } from 'vitest'
import { createIncidentEvent } from '@ykurilov/remontnik-core/incident'
import { createMemoryRecordStore } from '../records/index.js'
import { createCaseBook } from './index.js'
import { readErrorBaseline, readErrorsSince } from './error-hours.js'

function event(name: string, at: string, repeats = 0) {
  return createIncidentEvent({
    appName: 'patient',
    kind: 'crash',
    where: `src/${name}.ts`,
    message: `сбой ${name}`,
    occurredAt: new Date(at),
    ...(repeats > 0 ? { context: { repeats } } : {}),
  })
}

describe('почасовой учёт ошибок', () => {
  it('уровень до выкатки: больший из прошлого часа и среднего за сутки; известные отпечатки — за неделю', async () => {
    const store = createMemoryRecordStore()
    const book = createCaseBook(store)
    const old = event('old', '2026-10-15T10:00:00Z')
    const weekAgo = event('week', '2026-10-20T10:00:00Z')
    const yesterday = event('day', '2026-10-25T13:00:00Z', 47)
    const recent = event('recent', '2026-10-26T11:30:00Z', 1)
    await book.recordEvents([old, weekAgo, yesterday, recent])
    // Повторная доставка не считается дважды.
    await book.recordEvents([recent])

    const baseline = await readErrorBaseline(store, 'patient', new Date('2026-10-26T12:10:00Z'))
    expect(baseline.errorsPerHour).toBeCloseTo(50 / 24) // сутки: 48 + 2 = 50 → больше, чем 2 за прошлый час
    expect(baseline.knownFingerprints7d.sort()).toEqual([weekAgo.fingerprint, yesterday.fingerprint, recent.fingerprint].sort())

    const quiet = await readErrorBaseline(store, 'other-app', new Date('2026-10-26T12:10:00Z'))
    expect(quiet).toEqual({ errorsPerHour: 0, knownFingerprints7d: [] })
  })

  it('ошибки после выкатки: сколько, в час, новые отпечатки и вернулся ли сбой случая', async () => {
    const store = createMemoryRecordStore()
    const book = createCaseBook(store)
    const known = event('known', '2026-10-26T11:00:00Z')
    const caseFailure = event('case', '2026-10-26T11:10:00Z')
    await book.recordEvents([known, caseFailure])

    const from = new Date('2026-10-26T12:00:20Z')
    const before = event('fresh-before', '2026-10-26T11:59:00Z')
    const afterA = event('fresh-a', '2026-10-26T12:05:00Z', 2)
    const afterB = event('fresh-b', '2026-10-26T13:01:00Z')
    const knownAgain = event('known', '2026-10-26T12:06:00Z')
    await book.recordEvents([before, afterA, afterB, knownAgain])

    const seen = await readErrorsSince(store, 'patient', {
      from,
      to: new Date('2026-10-26T13:30:20Z'),
      knownFingerprints: [known.fingerprint, caseFailure.fingerprint],
      caseFingerprint: caseFailure.fingerprint,
    })
    expect(seen.errors).toBe(5)
    expect(seen.errorsPerHour).toBeCloseTo(5 / 1.5, 1)
    expect(seen.newFingerprints.sort()).toEqual([afterA.fingerprint, afterB.fingerprint].sort())
    expect(seen.caseFingerprintSeen).toBe(false)

    await book.recordEvents([event('case', '2026-10-26T13:20:00Z')])
    const again = await readErrorsSince(store, 'patient', {
      from,
      to: new Date('2026-10-26T13:30:20Z'),
      knownFingerprints: [known.fingerprint, caseFailure.fingerprint],
      caseFingerprint: caseFailure.fingerprint,
    })
    expect(again.caseFingerprintSeen).toBe(true)
    expect(again.newFingerprints).not.toContain(caseFailure.fingerprint)
  })

  it('первая минута наблюдения не раздувает частоту: время делится не меньше чем на минуту', async () => {
    const store = createMemoryRecordStore()
    await createCaseBook(store).recordEvents([event('a', '2026-10-26T12:00:01Z')])
    const seen = await readErrorsSince(store, 'patient', {
      from: new Date('2026-10-26T12:00:00Z'),
      to: new Date('2026-10-26T12:00:02Z'),
      knownFingerprints: [],
      caseFingerprint: 'none',
    })
    expect(seen.errors).toBe(1)
    expect(seen.errorsPerHour).toBe(60)
  })
})
