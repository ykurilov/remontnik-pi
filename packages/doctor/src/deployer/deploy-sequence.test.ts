import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createIncidentEvent } from '@ykurilov/remontnik-core/incident'
import { createCaseBook } from '../case-book/index.js'
import { createControls } from '../ledgers/controls.js'
import { createMemoryRecordStore, type RecordStore } from '../records/index.js'
import { createReports } from '../reports/index.js'
import { testRemontnikConfig } from '../testing/config.js'
import { createFakeDeployApp, type FakeDeployApp } from '../testing/fake-deploy-app.js'
import type { AppCommands } from './app-commands.js'
import { confirmAbandonedVersion, createDeployer, LOCK_RETRY_MS, readDeployment, type DeployIo, type DeployRequest, type Deployment } from './deploy-sequence.js'
import { createDeployLock, type DeployLock } from './lock.js'

// Порядок выкатки (contracts/deploy-commands.md) и её доведение до конца после падения врача на любом шаге.
// Часы подменены: сон выкатки (`sleep`) сразу переводит часы на время пробуждения.

const PREV = 'a'.repeat(40)
const OLDER = 'b'.repeat(40)
const CAND = 'c'.repeat(40)
const START = Date.parse('2026-10-26T12:00:00Z')
const MINUTE = 60_000
const request: DeployRequest = { caseId: 7, appName: 'patient', fingerprint: 'fp-case', candidateVersion: CAND, candidateDir: '/srv/copies/7' }

class Crash extends Error {}

interface RigOptions {
  app?: FakeDeployApp
  request?: DeployRequest
  /** После команды приложения: подставить событие мира (стоп-кран, человек, ошибки). */
  afterCommand?: (name: keyof AppCommands, rig: Rig) => void | Promise<void>
  /** Перед каждым шагом выкатки (после сна). */
  beforeStep?: (rig: Rig) => void | Promise<void>
  /** Врач падает, не успев запустить команду (или посреди неё, не дождавшись конца). */
  crashBefore?: (name: keyof AppCommands) => boolean
}

interface Rig {
  app: FakeDeployApp
  records: RecordStore
  lockPath: string
  tags: Array<[string, string]>
  now(): number
  /** Перевести часы вперёд: команда шла долго или врач спал. */
  advance(ms: number): void
  /** Падение врача сразу после N-го внешнего действия или записи. */
  crashAfter(effect: number): void
  effects(): number
  crashes(): number
  drive(maxSteps?: number): Promise<Deployment>
}

function rig(options: RigOptions = {}): Rig {
  const { app: given } = options
  const app = given ?? createFakeDeployApp({ running: PREV, previous: OLDER })
  const memory = createMemoryRecordStore()
  const lockPath = join(mkdtempSync(join(tmpdir(), 'remontnik-deploy-')), '.remontnik', 'deploy.lock')
  const tags: Array<[string, string]> = []
  const config = testRemontnikConfig()
  let clock = START
  let effects = 0
  let crashAt = Infinity
  let crashes = 0

  async function effect<T>(action: () => Promise<T>): Promise<T> {
    const result = await action()
    effects += 1
    if (effects === crashAt) {
      crashes += 1
      throw new Crash()
    }
    return result
  }

  const store: RecordStore = {
    transaction: (change) => effect(() => memory.transaction(change)),
    read: (collection, key) => memory.read(collection, key),
  }

  const self: Rig = {
    app,
    records: memory,
    lockPath,
    tags,
    now: () => clock,
    advance: (ms) => {
      clock += ms
    },
    crashAfter: (effect) => {
      crashAt = effect
    },
    effects: () => effects,
    crashes: () => crashes,
    async drive(maxSteps = 2000) {
      const commands = Object.fromEntries(
        Object.entries(app.commands).map(([name, command]) => [
          name,
          async (...args: unknown[]) => {
            if (options.crashBefore?.(name as keyof AppCommands)) {
              crashes += 1
              throw new Crash()
            }
            return effect(async () => {
              const result = await (command as (...args: unknown[]) => Promise<unknown>)(...args)
              await options.afterCommand?.(name as keyof AppCommands, self)
              return result
            })
          },
        ]),
      ) as unknown as AppCommands
      const deployer = () =>
        createDeployer({
          loadConfig: async () => config,
          commandsFor: () => commands,
          mainCopyFor: () => app.mainCopy,
          lockFor: () => {
            const lock = createDeployLock(lockPath)
            return {
              acquire: (...args) => effect(() => lock.acquire(...args)),
              release: (id) => effect(() => lock.release(id)),
              holds: (id) => lock.holds(id),
            }
          },
          tagPreDeploy: (name, commit) =>
            effect(async () => {
              const same = tags.find(([tag]) => tag === name)
              if (same && same[1] !== commit) return { ok: false as const, reason: 'метка на другом коммите' }
              if (!same) tags.push([name, commit])
              return { ok: true as const }
            }),
        })
      let current = deployer()
      for (let steps = 0; steps < maxSteps; steps += 1) {
        await options.beforeStep?.(self)
        let step
        try {
          step = await current.step(options.request ?? request, { store, now: () => clock })
        } catch (error) {
          if (!(error instanceof Crash)) throw error
          // Врач упал: новый процесс, те же записи и тот же сервер.
          current = deployer()
          continue
        }
        if (step.kind === 'done') return step.deployment
        clock = Math.max(clock, step.until)
      }
      throw new Error('выкатка не закончилась')
    },
  }
  return self
}

const sickAfterPromote = (app: FakeDeployApp) => app.setHealth((running) => (running === CAND ? { ok: false, reason: 'страница отвечает 500' } : { ok: true }))
const count = (calls: string[], name: string) => calls.filter((call) => call === name).length

describe('порядок выкатки', () => {
  it('замок → current → метка на прежней версии → build → promote → current = кандидат → health → наблюдение → confirm → замок снят', async () => {
    const lockSeen: boolean[] = []
    const r = rig({ afterCommand: (name, self) => void (name === 'build' && lockSeen.push(existsSync(self.lockPath))) })
    const deployment = await r.drive()

    const firsts = ['current', `build ${CAND}`, 'promote', 'health', 'confirm'].map((call) => r.app.calls.indexOf(call))
    expect(firsts.every((index, i) => index >= 0 && (i === 0 || index > firsts[i - 1]!))).toBe(true)
    expect(r.app.calls[r.app.calls.indexOf('promote') + 1]).toBe('current')
    expect(lockSeen).toEqual([true])
    expect(existsSync(r.lockPath)).toBe(false)
    expect(r.tags).toEqual([[`remontnik/pre-deploy/2026-10-26-7-${deployment.deploymentId}`, PREV]])

    expect(deployment).toMatchObject({
      caseId: 7,
      outcome: 'holding',
      previousVersion: PREV,
      candidateVersion: CAND,
      preDeployTag: r.tags[0]![0],
      baseline: { errorsPerHour: 0, knownFingerprints7d: [] },
    })
    const promotedAt = Date.parse(deployment.promotedAt!)
    expect(Date.parse(deployment.observeUntil!)).toBe(promotedAt + 30 * MINUTE)
    expect(Date.parse(deployment.endedAt!)).toBeGreaterThanOrEqual(Date.parse(deployment.observeUntil!))
    expect(r.app.running).toBe(CAND)
    expect(r.app.previous).toBe(PREV)
    expect(count(r.app.calls, 'confirm')).toBe(1)
    expect(count(r.app.calls, 'rollback')).toBe(0)
  })

  it('повторный вызов после конца — тот же итог без новых действий', async () => {
    const r = rig()
    const first = await r.drive()
    const calls = r.app.calls.length
    expect(await r.drive()).toEqual(first)
    expect(r.app.calls.length).toBe(calls)
  })

  it('нет работающей версии — откатывать будет некуда: отказ до сборки', async () => {
    const r = rig({ app: createFakeDeployApp({ running: null }) })
    const deployment = await r.drive()
    expect(deployment).toMatchObject({ outcome: 'refused', refusal: 'no_previous_build' })
    expect(r.app.calls).toEqual(['current'])
    expect(r.tags).toEqual([])
    expect(existsSync(r.lockPath)).toBe(false)
  })

  it('current не отвечает до выкатки — отказ, ничего не выкачено', async () => {
    const app = createFakeDeployApp({ running: PREV })
    app.setCurrentBroken(true)
    const r = rig({ app })
    expect(await r.drive()).toMatchObject({ outcome: 'refused', refusal: 'current_unavailable' })
    expect(count(app.calls, 'promote') + count(app.calls, 'rollback')).toBe(0)
  })

  it('сборка упала — отказ, работающую версию не трогали', async () => {
    const app = createFakeDeployApp({ running: PREV })
    app.failNext('build')
    const r = rig({ app })
    expect(await r.drive()).toMatchObject({ outcome: 'refused', refusal: 'build_failed', detail: expect.stringContaining('сборка упала') })
    expect(count(app.calls, 'promote')).toBe(0)
    expect(existsSync(r.lockPath)).toBe(false)
  })

  it('promote упал, а работает всё ещё прежняя — отказ без отката', async () => {
    const app = createFakeDeployApp({ running: PREV, previous: OLDER })
    app.failNext('promote')
    const r = rig({ app })
    expect(await r.drive()).toMatchObject({ outcome: 'refused', refusal: 'promote_failed' })
    expect(count(app.calls, 'rollback')).toBe(0)
    expect(app.running).toBe(PREV)
  })

  it('стоп-кран: до начала — выкатки нет; нажат во время сборки — до promote не доходит', async () => {
    const stopped = rig()
    await createControls(stopped.records).set('stop', 'telegram:admin')
    expect(await stopped.drive()).toMatchObject({ outcome: 'refused', refusal: 'stop_switch' })
    expect(stopped.app.calls).toEqual([])
    expect(existsSync(stopped.lockPath)).toBe(false)

    const midway = rig({ afterCommand: async (name, self) => void (name === 'build' && (await createControls(self.records).set('stop', 'console'))) })
    expect(await midway.drive()).toMatchObject({ outcome: 'refused', refusal: 'stop_switch' })
    expect(count(midway.app.calls, 'promote')).toBe(0)
    expect(existsSync(midway.lockPath)).toBe(false)
  })

  it('стоп-кран нажат после сборки, перед самым promote, — promote нет', async () => {
    let built = false
    const r = rig({
      afterCommand: async (name, self) => {
        if (name === 'build') built = true
        else if (name === 'current' && built) await createControls(self.records).set('stop', 'telegram:admin')
      },
    })
    expect(await r.drive()).toMatchObject({ outcome: 'refused', refusal: 'stop_switch' })
    expect(count(r.app.calls, 'promote')).toBe(0)
    expect(r.app.running).toBe(PREV)
  })

  it('после падения перед promote повтор идёт, только если стоп-кран не нажат и замок всё ещё свой', async () => {
    let crashed = false
    let stopped = false
    const stop = rig({
      crashBefore: (name) => name === 'promote' && !crashed && (crashed = true),
      beforeStep: async (self) => {
        if (!crashed || stopped) return
        stopped = true
        await createControls(self.records).set('stop', 'console')
      },
    })
    expect(await stop.drive()).toMatchObject({ outcome: 'refused', refusal: 'stop_switch' })
    expect(count(stop.app.calls, 'promote')).toBe(0)
    expect(stop.app.running).toBe(PREV)

    let crashedAgain = false
    let replaced = false
    const lost = rig({
      crashBefore: (name) => name === 'promote' && !crashedAgain && (crashedAgain = true),
      beforeStep: (self) => {
        if (!crashedAgain || replaced) return
        replaced = true
        writeFileSync(self.lockPath, 'manual deploy\n')
      },
    })
    expect(await lost.drive()).toMatchObject({ outcome: 'refused', refusal: 'lock_lost' })
    expect(count(lost.app.calls, 'promote')).toBe(0)
    expect(readFileSync(lost.lockPath, 'utf8')).toBe('manual deploy\n')
  })

  it('ошибки кандидата считаются с конца promote, а не с подтверждения current', async () => {
    // Сразу после promote кандидат сыплет ошибками, а current подтверждает его только через 2 минуты.
    let confirmedLate = false
    const r = rig({
      afterCommand: async (name, self) => {
        if (name !== 'current' || self.app.running !== CAND || confirmedLate) return
        confirmedLate = true
        await createCaseBook(self.records).recordEvents([
          createIncidentEvent({ appName: 'patient', kind: 'crash', where: 'src/x.ts', message: 'сбой x', occurredAt: new Date(self.now()), context: { repeats: 9 } }),
        ])
        self.advance(2 * MINUTE)
      },
    })
    const deployment = await r.drive()
    expect(deployment).toMatchObject({ outcome: 'rolled_back', rollbackCause: 'error_rate' })
    expect(Date.parse(deployment.promotedAt!) - Date.parse(deployment.promoteReturnedAt!)).toBe(2 * MINUTE)
    // Окно наблюдения — по-прежнему от подтверждения current.
    expect(Date.parse(deployment.observeUntil!)).toBe(Date.parse(deployment.promotedAt!) + 30 * MINUTE)
  })

  it('время выкатки — когда current подтвердил кандидата, а не когда записано намерение', async () => {
    const r = rig({ afterCommand: (name, self) => void (name === 'promote' && self.advance(10 * MINUTE)) })
    const deployment = await r.drive()
    const promotedAt = Date.parse(deployment.promotedAt!)
    expect(promotedAt).toBeGreaterThanOrEqual(START + 10 * MINUTE)
    expect(Date.parse(deployment.observeUntil!)).toBe(promotedAt + 30 * MINUTE)
  })

  it('врач спал дольше окна наблюдения — окно начинается заново, итог не по одной проверке', async () => {
    let slept = false
    const r = rig({
      beforeStep: (self) => {
        if (slept || self.app.running !== CAND || !self.app.calls.includes('health')) return
        slept = true
        self.advance(45 * MINUTE)
      },
    })
    const deployment = await r.drive()
    expect(deployment.outcome).toBe('holding')
    expect(Date.parse(deployment.observeUntil!)).toBeGreaterThanOrEqual(START + 75 * MINUTE)
    expect(count(r.app.calls, 'health')).toBeGreaterThan(5)
  })
})

describe('откат', () => {
  it('сбой после promote (здоровье) — rollback, current = прежняя, причина записана', async () => {
    const app = createFakeDeployApp({ running: PREV, previous: OLDER })
    sickAfterPromote(app)
    const r = rig({ app })
    const deployment = await r.drive()
    expect(deployment).toMatchObject({ outcome: 'rolled_back', rollbackCause: 'health', healthyAfterRollback: true })
    expect(deployment.rollbackReason).toContain('страница отвечает 500')
    expect(app.running).toBe(PREV)
    expect(count(app.calls, 'rollback')).toBe(1)
    expect(count(app.calls, 'confirm')).toBe(0)
    // Три сбоя подряд, раз в 30 с: откат через минуту после выкатки.
    expect(Date.parse(deployment.endedAt!) - Date.parse(deployment.promotedAt!)).toBeLessThanOrEqual(2 * MINUTE)
    expect(existsSync(r.lockPath)).toBe(false)
  })

  it('current молчит после promote — откат; после него снова отвечает', async () => {
    const app = createFakeDeployApp({ running: PREV, previous: OLDER })
    const r = rig({
      app,
      afterCommand: (name) => {
        if (name === 'promote') app.setCurrentBroken(true)
        if (name === 'rollback') app.setCurrentBroken(false)
      },
    })
    expect(await r.drive()).toMatchObject({ outcome: 'rolled_back', rollbackCause: 'current_unavailable' })
    expect(app.running).toBe(PREV)
  })

  it('ошибок после выкатки больше, чем до неё (книга случаев), — откат', async () => {
    const r = rig({
      beforeStep: async (self) => {
        if (self.app.running !== CAND) return
        await createCaseBook(self.records).recordEvents([
          createIncidentEvent({ appName: 'patient', kind: 'crash', where: 'src/x.ts', message: 'сбой x', occurredAt: new Date(self.now()), context: { repeats: 4 } }),
        ])
      },
    })
    const deployment = await r.drive()
    expect(deployment).toMatchObject({ outcome: 'rolled_back', rollbackCause: 'error_rate' })
    expect(r.app.running).toBe(PREV)
  })

  it('откат не удался трижды — rollback_failed, замок снят', async () => {
    const app = createFakeDeployApp({ running: PREV, previous: OLDER })
    sickAfterPromote(app)
    app.failNext('rollback', 3)
    const rolledAt: number[] = []
    const r = rig({ app, afterCommand: (name, self) => void (name === 'rollback' && rolledAt.push(self.now())) })
    const deployment = await r.drive()
    expect(deployment).toMatchObject({ outcome: 'rollback_failed', rollbackCause: 'health' })
    expect(count(app.calls, 'rollback')).toBe(3)
    expect(existsSync(r.lockPath)).toBe(false)
    // После последней попытки — пауза 90 с и ещё одна проверка current.
    expect(Date.parse(deployment.endedAt!) - rolledAt[2]!).toBeGreaterThanOrEqual(90_000)
    expect(app.calls.lastIndexOf('current')).toBeGreaterThan(app.calls.lastIndexOf('rollback'))
  })

  it('приложение вернулось к прежней в паузе после последней попытки — откат удался', async () => {
    const app = createFakeDeployApp({ running: PREV, previous: OLDER })
    sickAfterPromote(app)
    app.failNext('rollback', 3)
    let recovered = false
    const r = rig({
      app,
      beforeStep: () => {
        if (recovered || count(app.calls, 'rollback') < 3) return
        recovered = true
        app.humanDeploys(PREV)
      },
    })
    expect(await r.drive()).toMatchObject({ outcome: 'rolled_back', rollbackAttempts: 3 })
  })

  it('rollback раз за разом обрывается падением врача — потолок запусков, потом нужен человек', async () => {
    const app = createFakeDeployApp({ running: PREV, previous: OLDER })
    sickAfterPromote(app)
    const r = rig({ app, crashBefore: (name) => name === 'rollback' })
    expect(await r.drive()).toMatchObject({ outcome: 'rollback_failed', rollbackLaunches: 6, detail: expect.stringContaining('врач падал') })
    expect(r.crashes()).toBe(6)
    expect(existsSync(r.lockPath)).toBe(false)
  })

  it('откат, прерванный падением врача, не считается попыткой; между неудачными попытками пауза растёт', async () => {
    const app = createFakeDeployApp({ running: PREV, previous: OLDER })
    sickAfterPromote(app)
    app.failNext('rollback', 2)
    const rolledAt: number[] = []
    let interrupted = 0
    const r = rig({
      app,
      crashBefore: (name) => name === 'rollback' && interrupted++ < 3,
      afterCommand: (name, self) => void (name === 'rollback' && rolledAt.push(self.now())),
    })
    const deployment = await r.drive()
    expect(deployment).toMatchObject({ outcome: 'rolled_back', rollbackAttempts: 3 })
    expect(app.running).toBe(PREV)
    expect(rolledAt).toHaveLength(3)
    const [first, second, third] = rolledAt as [number, number, number]
    expect(second - first).toBeGreaterThan(0)
    expect(third - second).toBeGreaterThan(second - first)
  })

  it('после promote приложение вернулось к прежней версии — откат с этой причиной, а не «человек выкатил своё»', async () => {
    const app = createFakeDeployApp({ running: PREV, previous: OLDER })
    const r = rig({ app, beforeStep: (self) => void (self.now() - START >= 10 * MINUTE && app.running === CAND && app.humanDeploys(PREV)) })
    const deployment = await r.drive()
    expect(deployment).toMatchObject({ outcome: 'rolled_back', rollbackCause: 'reverted', rollbackReason: 'приложение вернулось к прежней версии' })
    expect(count(app.calls, 'rollback')).toBe(0)
    expect(existsSync(r.lockPath)).toBe(false)
  })
})

describe('итоги наблюдения', () => {
  it('тот же сбой повторяется без ухудшения — не помогло, без отката, версия остаётся', async () => {
    const caseEvent = createIncidentEvent({ appName: 'patient', kind: 'crash', where: 'src/case.ts', message: 'сбой случая' })
    const r = rig({
      request: { ...request, fingerprint: caseEvent.fingerprint },
      beforeStep: async (self) => {
        if (self.app.running !== CAND || (self.now() - START) % (10 * MINUTE) !== 0) return
        const event = createIncidentEvent({ appName: 'patient', kind: 'crash', where: 'src/case.ts', message: 'сбой случая', occurredAt: new Date(self.now()) })
        await createCaseBook(self.records).recordEvents([event])
      },
    })
    const deployment = await r.drive()
    expect(deployment.outcome).toBe('not_helped')
    expect(r.app.running).toBe(CAND)
    expect(count(r.app.calls, 'rollback')).toBe(0)
    expect(count(r.app.calls, 'confirm')).toBe(1)
  })

  it('человек выкатил своё в окне наблюдения — superseded_by_human, чужую выкатку не откатываем', async () => {
    const app = createFakeDeployApp({ running: PREV, previous: OLDER })
    const r = rig({ app, beforeStep: (self) => void (self.now() - START >= 10 * MINUTE && app.running === CAND && app.humanDeploys('d'.repeat(40))) })
    const deployment = await r.drive()
    expect(deployment).toMatchObject({ outcome: 'superseded_by_human', supersededBy: 'd'.repeat(40) })
    expect(count(app.calls, 'rollback')).toBe(0)
    expect(app.running).toBe('d'.repeat(40))
    expect(existsSync(r.lockPath)).toBe(false)
  })
})

describe('рабочая копия основной ветки', () => {
  it('изменена ещё до выкатки — отказ, сборки нет', async () => {
    const app = createFakeDeployApp({ running: PREV, previous: OLDER })
    app.changeMainCopy('dirty')
    const r = rig({ app })
    expect(await r.drive()).toMatchObject({ outcome: 'refused', refusal: 'main_copy_changed', detail: expect.stringContaining('src/app.ts') })
    expect(app.calls.filter((call) => call.startsWith('build'))).toHaveLength(0)
    expect(existsSync(r.lockPath)).toBe(false)
  })

  it('сборка правки испортила рабочую копию — promote нет, нужен человек', async () => {
    const app = createFakeDeployApp({ running: PREV, previous: OLDER })
    const r = rig({ app, afterCommand: (name) => void (name === 'build' && app.changeMainCopy('file')) })
    expect(await r.drive()).toMatchObject({ outcome: 'refused', refusal: 'main_copy_changed', detail: expect.stringContaining('remontnik.config.ts') })
    expect(count(app.calls, 'promote')).toBe(0)
    expect(app.running).toBe(PREV)
  })

  it('promote и rollback оставили свои файлы состояния в рабочей копии — это не чужая правка', async () => {
    const app = createFakeDeployApp({ running: PREV, previous: OLDER })
    const r = rig({ app, afterCommand: (name) => void (name === 'promote' && app.changeMainCopy('dirty', '.deploy-state')) })
    expect(await r.drive()).toMatchObject({ outcome: 'holding' })
    expect(count(app.calls, 'rollback')).toBe(0)

    const sick = createFakeDeployApp({ running: PREV, previous: OLDER })
    sickAfterPromote(sick)
    const rolled = rig({ app: sick, afterCommand: (name) => void (name === 'rollback' && sick.changeMainCopy('dirty', '.rollback-state')) })
    const deployment = await rolled.drive()
    expect(deployment).toMatchObject({ outcome: 'rolled_back', rollbackCause: 'health' })
    expect(deployment.mainCopyChange).toBeUndefined()
  })

  it('новый изменённый файл после promote — по-прежнему откат', async () => {
    const app = createFakeDeployApp({ running: PREV, previous: OLDER })
    const r = rig({
      app,
      afterCommand: (name) => void (name === 'promote' && app.changeMainCopy('dirty', '.deploy-state')),
      beforeStep: (self) => void (self.now() - START >= 10 * MINUTE && app.running === CAND && app.changeMainCopy('dirty', 'src/app.ts')),
    })
    const deployment = await r.drive()
    expect(deployment).toMatchObject({ outcome: 'rolled_back', rollbackCause: 'main_copy_changed', rollbackReason: expect.stringContaining('src/app.ts') })
    expect(deployment.rollbackReason).not.toContain('.deploy-state')
  })

  it('принятый файл состояния потом изменили — изменённая копия, откат', async () => {
    const app = createFakeDeployApp({ running: PREV, previous: OLDER })
    const r = rig({
      app,
      afterCommand: (name) => void (name === 'promote' && app.changeMainCopy('dirty', '.deploy-state')),
      beforeStep: (self) => void (self.now() - START >= 10 * MINUTE && app.running === CAND && app.changeMainCopy('dirty', '.deploy-state')),
    })
    const deployment = await r.drive()
    expect(deployment).toMatchObject({ outcome: 'rolled_back', rollbackCause: 'main_copy_changed', rollbackReason: expect.stringContaining('.deploy-state') })
  })

  it('врач упал после намерения promote, но до запуска; за это время копию изменили — правка не принимается за свою', async () => {
    const app = createFakeDeployApp({ running: PREV, previous: OLDER })
    let crashed = false
    let changed = false
    const r = rig({
      app,
      // Третий `current` — сразу после записи намерения: врач падает, не дойдя до promote.
      crashBefore: (name) => name === 'current' && count(app.calls, 'current') === 2 && !crashed && (crashed = true),
      beforeStep: () => void (crashed && !changed && ((changed = true), app.changeMainCopy('dirty', 'src/app.ts'))),
    })
    const deployment = await r.drive()
    expect(r.crashes()).toBe(1)
    expect(count(app.calls, 'promote')).toBe(0)
    expect(deployment.rollbackReason ?? deployment.detail).toContain('src/app.ts')
    expect(app.running).toBe(PREV)
  })

  it('рабочую копию сменили после promote — откат', async () => {
    const app = createFakeDeployApp({ running: PREV, previous: OLDER })
    const r = rig({ app, beforeStep: (self) => void (self.now() - START >= 10 * MINUTE && app.running === CAND && app.changeMainCopy('commit')) })
    const deployment = await r.drive()
    expect(deployment).toMatchObject({ outcome: 'rolled_back', rollbackCause: 'main_copy_changed' })
    expect(app.running).toBe(PREV)
    expect(count(app.calls, 'rollback')).toBe(1)
  })
})

describe('общий замок', () => {
  it('ручная выкатка держит замок: врач спит и ждёт, потом выкатывает', async () => {
    let steps = 0
    const r = rig({
      beforeStep: (self) => {
        steps += 1
        if (steps === 3) rmSync(self.lockPath)
      },
    })
    mkdirSync(dirname(r.lockPath), { recursive: true })
    writeFileSync(r.lockPath, 'manual deploy\n', { flag: 'wx' })

    const deployment = await r.drive()
    expect(deployment.outcome).toBe('holding')
    expect(deployment.waitingLockSince).toBe(new Date(START).toISOString())
    expect(Date.parse(deployment.startedAt)).toBe(START)
    expect(Date.parse(deployment.promotedAt!)).toBeGreaterThan(START)
    expect(r.app.calls.indexOf('current')).toBeGreaterThanOrEqual(0)
    expect(existsSync(r.lockPath)).toBe(false)
  })

  it('пока выкатка идёт, файл замка — её, ручной скрипт с noclobber не начнёт свою', async () => {
    const seen: string[] = []
    const r = rig({ afterCommand: (name, self) => void (name === 'promote' && seen.push(readFileSync(self.lockPath, 'utf8'))) })
    const deployment = await r.drive()
    expect(seen[0]).toMatch(new RegExp(`^remontnik deployment ${deployment.deploymentId} `))
  })

  it('замок занят дольше 30 минут — один отчёт человеку, врач ждёт дальше', async () => {
    const r = rig({
      beforeStep: (self) => {
        if (self.now() - START >= 50 * MINUTE && existsSync(self.lockPath) && readFileSync(self.lockPath, 'utf8') === 'manual deploy\n') rmSync(self.lockPath)
      },
    })
    mkdirSync(dirname(r.lockPath), { recursive: true })
    writeFileSync(r.lockPath, 'manual deploy\n', { flag: 'wx' })

    const deployment = await r.drive()
    expect(deployment.outcome).toBe('holding')
    const reports = await createReports({ store: r.records }).list({ after: 0, limit: 10 })
    expect(reports).toHaveLength(1)
    expect(reports[0]).toMatchObject({ type: 'needs_human', caseId: 7, telegram: { state: 'pending' } })
    expect(reports[0]!.full).toContain('manual deploy')
    expect(Date.parse(deployment.lockWaitReportedAt!) - START).toBeGreaterThanOrEqual(30 * MINUTE)
  })

  it('замок потерян посреди наблюдения, отката или подтверждения — выкатка брошена, приложение больше не трогает', async () => {
    const replace = (self: Rig) => writeFileSync(self.lockPath, 'manual deploy\n')

    let observed = false
    const observing = rig({ beforeStep: (self) => void (!observed && self.app.calls.includes('health') && ((observed = true), replace(self))) })
    expect(await observing.drive()).toMatchObject({ outcome: 'abandoned', detail: expect.stringContaining('замок выкатки потерян') })
    expect(count(observing.app.calls, 'health')).toBe(1)
    expect(count(observing.app.calls, 'confirm') + count(observing.app.calls, 'rollback')).toBe(0)
    expect(readFileSync(observing.lockPath, 'utf8')).toBe('manual deploy\n')

    const sick = createFakeDeployApp({ running: PREV, previous: OLDER })
    sickAfterPromote(sick)
    const rollingBack = rig({ app: sick, afterCommand: (name, self) => void (name === 'health' && count(sick.calls, 'health') === 3 && replace(self)) })
    expect(await rollingBack.drive()).toMatchObject({ outcome: 'abandoned', rollbackCause: 'health' })
    expect(count(sick.calls, 'rollback')).toBe(0)

    const confirming = rig({ afterCommand: (name, self) => void (name === 'health' && self.now() - START >= 30 * MINUTE && replace(self)) })
    expect(await confirming.drive()).toMatchObject({ outcome: 'abandoned', verdict: 'holding' })
    expect(count(confirming.app.calls, 'confirm')).toBe(0)
  })

  it('замок потерян после promote — кандидат брошенной выкатки не считается прежней версией, пока владелец не подтвердит', async () => {
    let replaced = false
    const r = rig({ beforeStep: (self) => void (!replaced && self.app.calls.includes('health') && ((replaced = true), writeFileSync(self.lockPath, 'manual deploy\n'))) })
    expect(await r.drive()).toMatchObject({ outcome: 'abandoned' })
    const { app, lockPath, records } = r
    rmSync(lockPath)

    const other: DeployRequest = { ...request, caseId: 8, candidateVersion: 'e'.repeat(40) }
    const next = await plainDeployer(app, lockPath).step(other, { store: records, now: () => START + 60 * MINUTE })
    expect(next).toMatchObject({ kind: 'done', deployment: { outcome: 'refused', refusal: 'unconfirmed_version' } })

    // Владелец подтвердил версию — блок снят, следующая выкатка идёт.
    expect(await confirmAbandonedVersion(records, CAND)).toEqual({ wasBlocked: true })
    expect(await confirmAbandonedVersion(records, CAND)).toEqual({ wasBlocked: false })
    const third: DeployRequest = { ...request, caseId: 9, candidateVersion: 'e'.repeat(40) }
    expect(await plainDeployer(app, lockPath).step(third, { store: records, now: () => START + 61 * MINUTE })).toMatchObject({ kind: 'sleep', stage: 'observing' })
  })

  it('рядом с замком остался .stale-* (врач упал, снимая замок) — человеку, выкатка не начинается', async () => {
    const app = createFakeDeployApp({ running: PREV, previous: OLDER })
    const records = createMemoryRecordStore()
    const lockPath = join(mkdtempSync(join(tmpdir(), 'remontnik-deploy-')), 'deploy.lock')
    writeFileSync(`${lockPath}.stale-0a1b2c`, 'manual deploy\n')
    const deployer = plainDeployer(app, lockPath)
    for (let hour = 0; hour < 3; hour += 1) {
      expect(await deployer.step(request, { store: records, now: () => START + hour * 60 * MINUTE })).toMatchObject({ kind: 'sleep', stage: 'waiting_lock' })
    }
    expect(app.calls).toEqual([])
    expect(existsSync(lockPath)).toBe(false)
    const reports = await createReports({ store: records }).list({ after: 0, limit: 10 })
    expect(reports).toEqual([expect.objectContaining({ type: 'needs_human', caseId: 7, short: expect.stringContaining('deploy.lock.stale-0a1b2c') })])
  })

  function plainDeployer(app: FakeDeployApp, lockPath: string, lockFor: () => DeployLock = () => createDeployLock(lockPath)) {
    return createDeployer({
      loadConfig: async () => testRemontnikConfig(),
      commandsFor: () => app.commands,
      mainCopyFor: () => app.mainCopy,
      lockFor,
      tagPreDeploy: async () => ({ ok: true }),
    })
  }

  it('замок при снятии отложен в .lost-* (гонка) — врач зовёт человека и ждёт', async () => {
    const app = createFakeDeployApp({ running: PREV, previous: OLDER })
    const records = createMemoryRecordStore()
    const lockPath = join(mkdtempSync(join(tmpdir(), 'remontnik-deploy-')), 'deploy.lock')
    const lost = `${lockPath}.lost-ab12`
    const racing: DeployLock = {
      acquire: async () => ({ acquired: false, holder: 'human', content: 'manual deploy\n', lost }),
      release: async () => ({}),
      holds: async () => false,
    }
    const step = await plainDeployer(app, lockPath, () => racing).step(request, { store: records, now: () => START })
    expect(step).toMatchObject({ kind: 'sleep', stage: 'waiting_lock' })
    const reports = await createReports({ store: records }).list({ after: 0, limit: 10 })
    expect(reports).toHaveLength(1)
    expect(reports[0]).toMatchObject({ type: 'needs_human', caseId: 7 })
    expect(reports[0]!.short).toContain(lost)
  })

  it('замок выкатки, чья задача умерла, снимается: та выкатка брошена, её кандидат — не прежняя версия', async () => {
    const app = createFakeDeployApp({ running: PREV, previous: OLDER })
    const records = createMemoryRecordStore()
    const lockPath = join(mkdtempSync(join(tmpdir(), 'remontnik-deploy-')), 'deploy.lock')
    const deployer = plainDeployer(app, lockPath)
    let clock = START
    const dead = new Set<number>()
    const io = (taskId: number): DeployIo => ({ store: records, now: () => clock, taskId, isTaskAlive: async (id) => !dead.has(id) })

    const first = await deployer.step(request, io(1))
    expect(first).toMatchObject({ kind: 'sleep', stage: 'observing' })
    const other: DeployRequest = { ...request, caseId: 8, candidateVersion: 'e'.repeat(40) }
    expect(await deployer.step(other, io(2))).toMatchObject({ kind: 'sleep', stage: 'waiting_lock' })

    dead.add(1)
    clock += LOCK_RETRY_MS
    const next = await deployer.step(other, io(2))
    // Брошенная выкатка не подтверждена: её кандидат работает, но выкатывать поверх него врач не будет.
    expect(next).toMatchObject({ kind: 'done', deployment: { caseId: 8, outcome: 'refused', refusal: 'unconfirmed_version' } })
    expect(await readDeployment(records, first.deployment.deploymentId)).toMatchObject({
      stage: 'done',
      outcome: 'abandoned',
      abandonedBy: next.deployment.deploymentId,
    })
    const reports = await createReports({ store: records }).list({ after: 0, limit: 10 })
    expect(reports).toEqual([expect.objectContaining({ type: 'needs_human', caseId: 7 })])
    expect(existsSync(lockPath)).toBe(false)
    expect(app.calls.filter((call) => call === 'promote')).toHaveLength(1)
  })

  it('замок врача, которого нет в своих записях (чужой врач), не снимается никогда', async () => {
    const app = createFakeDeployApp({ running: PREV, previous: OLDER })
    const lockPath = join(mkdtempSync(join(tmpdir(), 'remontnik-deploy-')), 'deploy.lock')
    const foreign = 'remontnik deployment 99 0123456789abcdef 2026-10-25T00:00:00.000Z\n'
    writeFileSync(lockPath, foreign)
    const deployer = plainDeployer(app, lockPath)
    const records = createMemoryRecordStore()
    for (let hour = 0; hour < 3; hour += 1) {
      const step = await deployer.step(request, { store: records, now: () => START + hour * 60 * MINUTE, taskId: 1, isTaskAlive: async () => false })
      expect(step).toMatchObject({ kind: 'sleep', stage: 'waiting_lock' })
    }
    expect(readFileSync(lockPath, 'utf8')).toBe(foreign)
    expect(app.calls).toEqual([])
  })
})

describe('падение врача посреди выкатки', () => {
  const scenarios = {
    holding: { prepare: () => createFakeDeployApp({ running: PREV, previous: OLDER }), running: CAND, rollbacks: 0 },
    rolled_back: {
      prepare: () => {
        const app = createFakeDeployApp({ running: PREV, previous: OLDER })
        sickAfterPromote(app)
        return app
      },
      running: PREV,
      rollbacks: 1,
    },
  } as const

  for (const [outcome, scenario] of Object.entries(scenarios)) {
    it(`${outcome}: падение после каждого шага — тот же итог, одна выкатка, откат не потерян и не повторён`, async () => {
      const clean = rig({ app: scenario.prepare() })
      expect((await clean.drive()).outcome).toBe(outcome)
      const total = clean.effects()
      expect(total).toBeGreaterThan(10)

      for (let crashAt = 1; crashAt <= total; crashAt += 1) {
        const r = rig({ app: scenario.prepare() })
        r.crashAfter(crashAt)
        const deployment = await r.drive()
        const where = `падение после действия ${crashAt}`
        expect(r.crashes(), where).toBe(1)
        expect(deployment.outcome, where).toBe(outcome)
        expect(count(r.app.calls, 'promote'), where).toBe(1)
        expect(count(r.app.calls, 'rollback'), where).toBe(scenario.rollbacks)
        expect(r.app.running, where).toBe(scenario.running)
        expect(r.tags.length, where).toBe(1)
        expect(existsSync(r.lockPath), where).toBe(false)
      }
      // Полная выкатка заново после каждого из десятков шагов: на занятой машине дольше обычных 5 с.
    }, 60_000)
  }
})
