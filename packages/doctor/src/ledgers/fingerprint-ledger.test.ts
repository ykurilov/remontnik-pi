import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { decideDeploy } from '../deploy-gate/index.js'
import { createMemoryRecordStore, type RecordStore } from '../records/index.js'
import { openDoctorHarness } from '../service/harness.js'
import {
  admitAutoDeployIn,
  readDeployAttempts,
  recordRollbackIn,
  refundAutoDeployIn,
  releaseFingerprint,
  type DeployAttemptLimits,
} from './fingerprint-ledger.js'

// Защита от циклов (FR-032): выкатки по отпечатку и по приложению за сутки, «нужен человек» после отката.

const HOUR = 3_600_000
const limits: DeployAttemptLimits = { autoDeploysPerFingerprintPerDay: 2, autoDeploysPerDay: 5 }
const noon = Date.UTC(2026, 10, 2, 12)

async function deploy(store: RecordStore, fingerprint: string, deploymentId: number, at: number, timeZone = 'UTC') {
  const admitted = await store.transaction((tx) => admitAutoDeployIn(tx, { fingerprint, deploymentId, at, timeZone, limits }))
  expect(admitted).toEqual({ admitted: true })
}

async function attempts(store: RecordStore, fingerprint: string, now: number, timeZone = 'UTC') {
  return readDeployAttempts(store, { fingerprint, now, timeZone, limits })
}

describe('учёт попыток выкатки', () => {
  it('пустой учёт: попыток не было, человек не нужен, пределы из настройки', async () => {
    expect(await attempts(createMemoryRecordStore(), 'fp-a', noon)).toEqual({
      autoDeploysForFingerprint: 0,
      maxPerFingerprintPerDay: 2,
      autoDeploysToday: 0,
      maxPerDay: 5,
      needsHumanAfterRollback: false,
    })
  })

  it('2 выкатки на отпечаток в сутки: третья упирается в предел', async () => {
    const store = createMemoryRecordStore()
    await deploy(store, 'fp-a', 1, noon - 2 * HOUR)
    expect((await attempts(store, 'fp-a', noon)).autoDeploysForFingerprint).toBe(1)
    await deploy(store, 'fp-a', 2, noon - HOUR)
    const facts = await attempts(store, 'fp-a', noon)
    expect(facts.autoDeploysForFingerprint).toBe(2)
    expect(gateCodes(facts)).toContain('attempts_exhausted')
    // Другой отпечаток не задет.
    expect(gateCodes(await attempts(store, 'fp-b', noon))).not.toContain('attempts_exhausted')
  })

  it('записи pi-durable: первая выкатка нового отпечатка сохраняется в учёте', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'remontnik-ledger-'))
    const opened = await openDoctorHarness({ stateDir, onReport: () => {} })
    try {
      await deploy(opened.records, 'fp-a', 1, noon - HOUR)
      expect((await attempts(opened.records, 'fp-a', noon)).autoDeploysForFingerprint).toBe(1)
    } finally {
      await opened.close()
      rmSync(stateDir, { recursive: true, force: true })
    }
  })

  it('5 выкаток на приложение в сутки по всем отпечаткам', async () => {
    const store = createMemoryRecordStore()
    for (let id = 1; id <= 5; id += 1) await deploy(store, `fp-${id}`, id, noon - id * 60_000)
    const facts = await attempts(store, 'fp-new', noon)
    expect(facts).toMatchObject({ autoDeploysForFingerprint: 0, autoDeploysToday: 5 })
    expect(gateCodes(facts)).toEqual(['attempts_exhausted'])
  })

  it('сутки — по поясу приложения: в новые сутки пределы снова свободны', async () => {
    const store = createMemoryRecordStore()
    // 21:00 UTC 2 ноября — уже полночь 3 ноября в Москве.
    const moscowMidnight = Date.UTC(2026, 10, 2, 21)
    await deploy(store, 'fp-a', 1, moscowMidnight - HOUR, 'Europe/Moscow')
    await deploy(store, 'fp-a', 2, moscowMidnight + HOUR, 'Europe/Moscow')
    expect(await attempts(store, 'fp-a', moscowMidnight + 2 * HOUR, 'Europe/Moscow')).toMatchObject({ autoDeploysForFingerprint: 1, autoDeploysToday: 1 })
    // По UTC обе выкатки были 2 ноября.
    expect((await attempts(store, 'fp-a', moscowMidnight + 2 * HOUR, 'UTC')).autoDeploysForFingerprint).toBe(2)
  })

  it('повтор записи той же выкатки (фаза после перезапуска) не считается второй попыткой', async () => {
    const store = createMemoryRecordStore()
    await deploy(store, 'fp-a', 7, noon - HOUR)
    await deploy(store, 'fp-a', 7, noon - HOUR + 5_000)
    expect(await attempts(store, 'fp-a', noon)).toMatchObject({ autoDeploysForFingerprint: 1, autoDeploysToday: 1 })
  })

  it('откат → отпечаток «нужен человек», и это не проходит со сменой суток', async () => {
    const store = createMemoryRecordStore()
    await deploy(store, 'fp-a', 1, noon - HOUR)
    await store.transaction((tx) => recordRollbackIn(tx, { fingerprint: 'fp-a', deploymentId: 1, at: noon }))
    expect(gateCodes(await attempts(store, 'fp-a', noon))).toEqual(['needs_human_after_rollback'])
    const tomorrow = await attempts(store, 'fp-a', noon + 30 * HOUR)
    expect(tomorrow).toMatchObject({ autoDeploysForFingerprint: 0, needsHumanAfterRollback: true })
    expect(gateCodes(await attempts(store, 'fp-b', noon))).toEqual([])
  })

  it('снятие командой: «нужен человек» снят, кто и когда — записано; попытки дня остаются', async () => {
    const store = createMemoryRecordStore()
    await deploy(store, 'fp-a', 1, noon - HOUR)
    await store.transaction((tx) => recordRollbackIn(tx, { fingerprint: 'fp-a', deploymentId: 1, at: noon }))
    expect(await releaseFingerprint(store, { fingerprint: 'fp-a', by: 'owner', at: noon + HOUR })).toEqual({ found: true, needsHuman: false })
    expect(await attempts(store, 'fp-a', noon + HOUR)).toMatchObject({ autoDeploysForFingerprint: 1, needsHumanAfterRollback: false })
    // Новый откат снова ставит пометку.
    await deploy(store, 'fp-a', 2, noon + 2 * HOUR)
    await store.transaction((tx) => recordRollbackIn(tx, { fingerprint: 'fp-a', deploymentId: 2, at: noon + 3 * HOUR }))
    expect((await attempts(store, 'fp-a', noon + 3 * HOUR)).needsHumanAfterRollback).toBe(true)
  })

  it('снятие незнакомого отпечатка ничего не создаёт', async () => {
    const store = createMemoryRecordStore()
    expect(await releaseFingerprint(store, { fingerprint: 'fp-x', by: 'owner', at: noon })).toEqual({ found: false, needsHuman: false })
    expect(await attempts(store, 'fp-x', noon)).toMatchObject({ autoDeploysForFingerprint: 0, needsHumanAfterRollback: false })
  })

  it('старые выкатки не копятся: остаются только последние сутки', async () => {
    const store = createMemoryRecordStore()
    for (let day = 0; day < 10; day += 1) await deploy(store, 'fp-a', day + 1, noon - (10 - day) * 24 * HOUR)
    await deploy(store, 'fp-a', 99, noon)
    const ledger = await store.read<{ fingerprints: Record<string, { autoDeploys: unknown[] }> }>('ledger', 'main')
    expect(ledger?.fingerprints['fp-a']?.autoDeploys.length).toBeLessThanOrEqual(2)
  })
})

describe('допуск автовыкатки: проверить и записать одной транзакцией', () => {
  it('при 4 из 5 за сутки два случая просят разом → проходит ровно один', async () => {
    const store = createMemoryRecordStore()
    for (let id = 1; id <= 4; id += 1) await deploy(store, `fp-${id}`, id, noon - id * 60_000)
    const both = await Promise.all(
      ['fp-a', 'fp-b'].map((fingerprint, index) =>
        store.transaction((tx) => admitAutoDeployIn(tx, { fingerprint, deploymentId: 10 + index, at: noon, timeZone: 'UTC', limits })),
      ),
    )
    expect(both.filter((answer) => answer.admitted)).toHaveLength(1)
    expect(both.find((answer) => !answer.admitted)).toEqual({ admitted: false, reasons: ['attempts_exhausted'] })
    expect((await attempts(store, 'fp-c', noon)).autoDeploysToday).toBe(5)
  })

  it('отказ — с причиной и без записи: предел по отпечатку, «нужен человек» после отката', async () => {
    const store = createMemoryRecordStore()
    await deploy(store, 'fp-a', 1, noon - 2 * HOUR)
    await deploy(store, 'fp-a', 2, noon - HOUR)
    const admit = (fingerprint: string, deploymentId: number) =>
      store.transaction((tx) => admitAutoDeployIn(tx, { fingerprint, deploymentId, at: noon, timeZone: 'UTC', limits }))
    expect(await admit('fp-a', 3)).toEqual({ admitted: false, reasons: ['attempts_exhausted'] })
    await store.transaction((tx) => recordRollbackIn(tx, { fingerprint: 'fp-a', deploymentId: 2, at: noon }))
    expect(await admit('fp-a', 3)).toEqual({ admitted: false, reasons: ['attempts_exhausted', 'needs_human_after_rollback'] })
    expect(await attempts(store, 'fp-a', noon)).toMatchObject({ autoDeploysForFingerprint: 2, autoDeploysToday: 2 })
  })

  it('выкатка не началась → допуск возвращается: попытка и место дня свободны; повторный возврат ничего не меняет', async () => {
    const store = createMemoryRecordStore()
    await deploy(store, 'fp-a', 1, noon - HOUR)
    await deploy(store, 'fp-a', 2, noon - HOUR)
    await deploy(store, 'fp-b', 3, noon - HOUR)
    const refund = () => store.transaction((tx) => refundAutoDeployIn(tx, { fingerprint: 'fp-a', deploymentId: 2, timeZone: 'UTC' }))
    await refund()
    expect(await attempts(store, 'fp-a', noon)).toMatchObject({ autoDeploysForFingerprint: 1, autoDeploysToday: 2 })
    await refund()
    expect(await attempts(store, 'fp-a', noon)).toMatchObject({ autoDeploysForFingerprint: 1, autoDeploysToday: 2 })
    // Незнакомая выкатка или отпечаток — ничего не меняется и не создаётся.
    await store.transaction((tx) => refundAutoDeployIn(tx, { fingerprint: 'fp-x', deploymentId: 9, timeZone: 'UTC' }))
    expect(await attempts(store, 'fp-b', noon)).toMatchObject({ autoDeploysForFingerprint: 1, autoDeploysToday: 2 })
    await deploy(store, 'fp-a', 4, noon)
  })

  it('повтор той же выкатки после перезапуска пропускается, даже когда предел уже выбран', async () => {
    const store = createMemoryRecordStore()
    await deploy(store, 'fp-a', 1, noon - HOUR)
    await deploy(store, 'fp-a', 2, noon - 30_000)
    await deploy(store, 'fp-a', 2, noon)
    expect(await attempts(store, 'fp-a', noon)).toMatchObject({ autoDeploysForFingerprint: 2, autoDeploysToday: 2 })
  })
})

function gateCodes(attemptsFacts: Awaited<ReturnType<typeof attempts>>): string[] {
  const decision = decideDeploy({
    tests: { status: 'green', failed: [] },
    eval: { status: 'not_needed', worseScenarios: [] },
    forbiddenZones: [],
    protectedChanges: [],
    diff: { existingTestChanges: [], suspicious: [], size: { files: 1, lines: 2, exceeds: [] } },
    stopSwitch: false,
    attempts: attemptsFacts,
    spend: { modelUsd: 0, modelLimitUsd: 5, evalUsd: 0, evalLimitUsd: 5 },
    rebase: 'clean',
  } as Parameters<typeof decideDeploy>[0])
  return decision.reasons.map((reason) => reason.code)
}
