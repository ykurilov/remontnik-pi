import type { RemontnikConfig } from '@ykurilov/remontnik-core/config'
import { readErrorBaseline, type ErrorBaseline } from '../case-book/error-hours.js'
import { readControls } from '../ledgers/controls.js'
import { copyRecord, type RecordStore } from '../records/index.js'
import type { AppCommands } from './app-commands.js'
import type { DeployLock } from './lock.js'
import { OBSERVE_TICK_MS, observe, readObservationTick, startObservation, type ObservationState, type RollbackReason } from './observer.js'

// Выкатка правки (contracts/deploy-commands.md): замок → `current` → метка git на прежней версии → `build` →
// `promote` → `current` = кандидат → наблюдение (первый тик с `health` — сразу) → `confirm` → замок снят.
// Сбой после `promote` или ухудшение в окне → `rollback` → `current` = прежняя.
//
// Врач может упасть на любом шаге, и шаг тогда идёт заново. Поэтому каждый шаг: записать намерение → сделать →
// проверить настоящее состояние сервера (`current`), а не память. `promote` идёт, только пока работает прежняя
// версия; `rollback` — только пока работает кандидат, и попытки считаются до запуска. Выкатка — документ
// `deployment/<id>`; ждать (замок, тик наблюдения) она не умеет сама: `step()` возвращает `sleep`, и задача
// pi-durable спит через `runtime.sleepUntil` (см. `runDeploymentInTask` в service/harness.ts).

export const DEPLOYMENT_COLLECTION = 'deployment'
export const DEPLOYMENT_INDEX_COLLECTION = 'deployment-index'
const INDEX_KEY = 'main'
/** Как часто проверять, свободен ли замок. */
export const LOCK_RETRY_MS = 30_000
const MAX_ROLLBACK_ATTEMPTS = 3
const DETAIL_LIMIT = 4000

export type DeployStage = 'starting' | 'locked' | 'tagging' | 'building' | 'promoting' | 'observing' | 'rolling_back' | 'confirming' | 'done'
export type DeployOutcome = 'in_progress' | 'holding' | 'not_helped' | 'rolled_back' | 'superseded_by_human' | 'rollback_failed' | 'refused'
/** Почему выкатка не началась; работающую версию при этом не трогали. */
export type DeployRefusal = 'stop_switch' | 'current_unavailable' | 'no_previous_build' | 'already_running' | 'tag_failed' | 'build_failed' | 'promote_failed'
export type RollbackCause = RollbackReason | 'promote_failed' | 'current_unavailable'

export interface Deployment {
  deploymentId: number
  caseId: number
  appName: string
  fingerprint: string
  candidateVersion: string
  candidateDir: string
  stage: DeployStage
  outcome: DeployOutcome
  startedAt: string
  /** С какого времени ждёт замок (ручная или другая выкатка). */
  waitingLockSince?: string
  previousVersion?: string
  preDeployTag?: string
  baseline?: ErrorBaseline
  /** Намерение `promote` записано: дальше по `current` видно, прошёл ли он. */
  promoteRequested?: boolean
  promotedAt?: string
  observeUntil?: string
  nextTickAt?: string
  observation?: ObservationState
  lastTick?: { at: string; errors: number; errorsPerHour: number; newFingerprints: string[]; caseFingerprintSeen: boolean }
  /** Итог окна наблюдения, пока идёт `confirm`. */
  verdict?: 'holding' | 'not_helped'
  rollbackCause?: RollbackCause
  rollbackReason?: string
  rollbackAttempts?: number
  healthyAfterRollback?: boolean
  healthAfterRollback?: string
  refusal?: DeployRefusal
  /** Хвост вывода команды или причина: для отчёта человеку. */
  detail?: string
  supersededBy?: string
  confirmFailed?: string
  endedAt?: string
}

export interface DeployRequest {
  caseId: number
  appName: string
  /** Отпечаток сбоя случая: его повтор после выкатки — «не помогло». */
  fingerprint: string
  /** Коммит правки. */
  candidateVersion: string
  /** Копия кода правки: здесь идёт `build`. */
  candidateDir: string
}

export interface DeployIo {
  /** Записи врача; в задаче pi-durable — поверх `runtime.commit` (`taskRecordStore`). */
  store: RecordStore
  /** Часы Harness (`runtime.now`). */
  now(): number
}

export type DeployStep =
  | { kind: 'sleep'; until: number; stage: 'waiting_lock' | 'observing'; deployment: Deployment }
  | { kind: 'done'; deployment: Deployment }

export type TagResult = { ok: true } | { ok: false; reason: string }

export interface DeployerDeps {
  /** Настройка приложения из основной ветки. */
  loadConfig(): Promise<RemontnikConfig>
  commandsFor(config: RemontnikConfig): AppCommands
  lockFor(config: RemontnikConfig): DeployLock
  /** Метка прежней версии в git и origin; повтор безопасен. Отказ git — `ok: false`, остальное — исключение. */
  tagPreDeploy(name: string, version: string): Promise<TagResult>
  tickMs?: number
  lockRetryMs?: number
}

export interface Deployer {
  /** Довести выкатку до сна или до конца. Безопасно вызывать заново после падения на любом месте. */
  step(request: DeployRequest, io: DeployIo): Promise<DeployStep>
}

interface DeploymentIndex {
  nextId: number
  /** `<caseId>:<коммит>` → номер выкатки: та же правка случая выкатывается один раз. */
  byRequest: Record<string, number>
}

const requestKey = (request: DeployRequest) => `${request.caseId}:${request.candidateVersion}`
const clip = (text: string) => text.slice(-DETAIL_LIMIT)

export function preDeployTagName(caseId: number, deploymentId: number, at: Date): string {
  return `remontnik/pre-deploy/${at.toISOString().slice(0, 10)}-${caseId}-${deploymentId}`
}

export async function readDeployment(store: RecordStore, deploymentId: number): Promise<Deployment | undefined> {
  return store.read<Deployment>(DEPLOYMENT_COLLECTION, String(deploymentId))
}

async function openDeployment(store: RecordStore, request: DeployRequest, now: Date): Promise<Deployment> {
  const index = await store.read<DeploymentIndex>(DEPLOYMENT_INDEX_COLLECTION, INDEX_KEY)
  const known = index?.byRequest[requestKey(request)]
  if (known !== undefined) {
    const found = await readDeployment(store, known)
    if (found) return found
  }
  return store.transaction(async (tx) => {
    const draft = await tx.doc<DeploymentIndex>(DEPLOYMENT_INDEX_COLLECTION, INDEX_KEY, { nextId: 1, byRequest: {} })
    const deploymentId = draft.byRequest[requestKey(request)] ?? draft.nextId
    if (deploymentId === draft.nextId) draft.nextId += 1
    draft.byRequest[requestKey(request)] = deploymentId
    const deployment = await tx.doc<Deployment>(DEPLOYMENT_COLLECTION, String(deploymentId), {
      deploymentId,
      caseId: request.caseId,
      appName: request.appName,
      fingerprint: request.fingerprint,
      candidateVersion: request.candidateVersion,
      candidateDir: request.candidateDir,
      stage: 'starting',
      outcome: 'in_progress',
      startedAt: now.toISOString(),
    })
    return copyRecord(deployment)
  })
}

export function createDeployer(deps: DeployerDeps): Deployer {
  const tickMs = deps.tickMs ?? OBSERVE_TICK_MS
  const lockRetryMs = deps.lockRetryMs ?? LOCK_RETRY_MS

  return {
    async step(request, io) {
      const config = await deps.loadConfig()
      const commands = deps.commandsFor(config)
      const lock = deps.lockFor(config)
      const { store } = io
      const now = () => new Date(io.now())
      let deployment = await openDeployment(store, request, now())
      const id = deployment.deploymentId
      /** `promote` уже запускали в этом вызове: второй раз подряд — не выкатка, а сломанная команда. */
      let promotedHere = false

      async function save(change: (draft: Deployment) => void): Promise<void> {
        deployment = await store.transaction(async (tx) => {
          const draft = await tx.doc<Deployment>(DEPLOYMENT_COLLECTION, String(id), {} as Deployment)
          change(draft)
          return copyRecord(draft)
        })
      }

      // Сначала итог в записи, потом замок: упадёт между ними — следующий вызов снимет замок на `done`.
      async function finish(change: (draft: Deployment) => void): Promise<DeployStep> {
        await save((draft) => {
          change(draft)
          draft.stage = 'done'
          draft.endedAt = now().toISOString()
        })
        await lock.release(id)
        return { kind: 'done', deployment }
      }

      const refuse = (refusal: DeployRefusal, detail?: string) =>
        finish((draft) => {
          draft.outcome = 'refused'
          draft.refusal = refusal
          if (detail) draft.detail = clip(detail)
        })
      const superseded = (version: string) =>
        finish((draft) => {
          draft.outcome = 'superseded_by_human'
          draft.supersededBy = version
        })
      const startRollback = (cause: RollbackCause, reason: string) =>
        save((draft) => {
          draft.stage = 'rolling_back'
          draft.rollbackCause = cause
          draft.rollbackReason = clip(reason)
        })
      const isFinished = async (other: number) => ((await readDeployment(store, other))?.outcome ?? 'refused') !== 'in_progress'
      /** До `promote` замок должен быть этой выкатки; потерян (сняли руками) — заново в очередь за ним. */
      async function holdsLock(): Promise<boolean> {
        if ((await lock.acquire(id, now(), isFinished)).acquired) return true
        await save((draft) => {
          draft.stage = 'starting'
        })
        return false
      }

      for (;;) {
        switch (deployment.stage) {
          case 'done':
            await lock.release(id)
            return { kind: 'done', deployment }

          case 'starting': {
            if ((await readControls(store)).autoDeploy === 'stopped') return refuse('stop_switch')
            if (!(await lock.acquire(id, now(), isFinished)).acquired) {
              if (!deployment.waitingLockSince) {
                await save((draft) => {
                  draft.waitingLockSince = now().toISOString()
                })
              }
              return { kind: 'sleep', until: io.now() + lockRetryMs, stage: 'waiting_lock', deployment }
            }
            await save((draft) => {
              draft.stage = 'locked'
            })
            break
          }

          case 'locked': {
            if (!(await holdsLock())) break
            const current = await commands.current()
            if (!current.ok) return refuse('current_unavailable', current.reason)
            if (current.version === null) return refuse('no_previous_build')
            if (current.version === request.candidateVersion) return refuse('already_running')
            const previousVersion = current.version
            await save((draft) => {
              draft.previousVersion = previousVersion
              draft.preDeployTag = preDeployTagName(request.caseId, id, now())
              draft.stage = 'tagging'
            })
            break
          }

          case 'tagging': {
            if (!(await holdsLock())) break
            const tagged = await deps.tagPreDeploy(deployment.preDeployTag!, deployment.previousVersion!)
            if (!tagged.ok) return refuse('tag_failed', tagged.reason)
            await save((draft) => {
              draft.stage = 'building'
            })
            break
          }

          case 'building': {
            if (!(await holdsLock())) break
            const built = await commands.build(request.candidateDir, request.candidateVersion)
            if (!built.ok) return refuse('build_failed', built.output)
            if ((await readControls(store)).autoDeploy === 'stopped') return refuse('stop_switch')
            const baseline = await readErrorBaseline(store, request.appName, now())
            await save((draft) => {
              draft.baseline = baseline
              draft.stage = 'promoting'
            })
            break
          }

          case 'promoting': {
            const previousVersion = deployment.previousVersion!
            if (!deployment.promoteRequested) {
              if (!(await holdsLock())) break
              const before = await commands.current()
              if (!before.ok) return refuse('current_unavailable', before.reason)
              if (before.version === null) return refuse('no_previous_build')
              if (before.version !== previousVersion) return superseded(before.version)
              await save((draft) => {
                draft.promoteRequested = true
                draft.promotedAt = now().toISOString()
              })
            }
            let current = await commands.current()
            if (current.ok && current.version === previousVersion) {
              if (promotedHere) return refuse('promote_failed', 'promote закончился успешно, а работает прежняя версия')
              const promoted = await commands.promote()
              promotedHere = true
              current = await commands.current()
              if (!promoted.ok) {
                if (current.ok && current.version === previousVersion) return refuse('promote_failed', promoted.output)
                await startRollback('promote_failed', `promote упал: ${promoted.output}`)
                break
              }
            }
            if (!current.ok || current.version === null) {
              await startRollback('current_unavailable', current.ok ? 'current: работающей версии нет' : current.reason)
              break
            }
            if (current.version === previousVersion) break
            if (current.version !== request.candidateVersion) return superseded(current.version)
            if (current.previous !== previousVersion) {
              await startRollback('promote_failed', `после promote прежняя сборка — ${current.previous ?? 'нет'}, а не ${previousVersion}`)
              break
            }
            await save((draft) => {
              draft.stage = 'observing'
              draft.observeUntil = new Date(Date.parse(draft.promotedAt!) + config.observe.windowMinutes * 60_000).toISOString()
              draft.observation = startObservation()
              draft.nextTickAt = now().toISOString()
            })
            break
          }

          case 'observing': {
            const nextTickAt = Date.parse(deployment.nextTickAt!)
            if (io.now() < nextTickAt) return { kind: 'sleep', until: nextTickAt, stage: 'observing', deployment }
            const observeUntil = new Date(deployment.observeUntil!)
            const tick = await readObservationTick({
              commands,
              records: store,
              appName: request.appName,
              at: now(),
              promotedAt: new Date(deployment.promotedAt!),
              baseline: deployment.baseline!,
              caseFingerprint: request.fingerprint,
            })
            const { state, verdict } = observe(deployment.observation ?? startObservation(), tick, {
              settings: config.observe,
              baseline: deployment.baseline!,
              candidateVersion: request.candidateVersion,
              observeUntil,
            })
            const lastTick = {
              at: tick.at.toISOString(),
              errors: tick.errors.errors,
              errorsPerHour: tick.errors.errorsPerHour,
              newFingerprints: tick.errors.newFingerprints.slice(0, 10),
              caseFingerprintSeen: tick.errors.caseFingerprintSeen,
            }
            if (verdict.kind === 'superseded') return superseded(verdict.version)
            await save((draft) => {
              draft.observation = state
              draft.lastTick = lastTick
              if (verdict.kind === 'continue') {
                draft.nextTickAt = new Date(Math.min(io.now() + tickMs, Math.max(observeUntil.getTime(), io.now() + 1))).toISOString()
              } else if (verdict.kind === 'rollback') {
                draft.stage = 'rolling_back'
                draft.rollbackCause = verdict.reason
                draft.rollbackReason = verdict.detail
              } else {
                draft.stage = 'confirming'
                draft.verdict = verdict.outcome
              }
            })
            break
          }

          case 'rolling_back': {
            const current = await commands.current()
            if (current.ok && current.version === deployment.previousVersion) {
              const health = await commands.health()
              return finish((draft) => {
                draft.outcome = 'rolled_back'
                draft.healthyAfterRollback = health.ok
                if (!health.ok) draft.healthAfterRollback = health.reason
              })
            }
            if (current.ok && current.version !== null && current.version !== request.candidateVersion) return superseded(current.version)
            if ((deployment.rollbackAttempts ?? 0) >= MAX_ROLLBACK_ATTEMPTS) {
              return finish((draft) => {
                draft.outcome = 'rollback_failed'
              })
            }
            await save((draft) => {
              draft.rollbackAttempts = (draft.rollbackAttempts ?? 0) + 1
            })
            const rolled = await commands.rollback()
            if (!rolled.ok) {
              await save((draft) => {
                draft.detail = clip(rolled.output)
              })
            }
            break
          }

          case 'confirming': {
            const current = await commands.current()
            if (!current.ok || current.version === null) {
              await startRollback('current_unavailable', current.ok ? 'current: работающей версии нет' : current.reason)
              break
            }
            if (current.version !== request.candidateVersion) return superseded(current.version)
            const confirmed = await commands.confirm()
            return finish((draft) => {
              draft.outcome = draft.verdict ?? 'holding'
              if (!confirmed.ok) draft.confirmFailed = clip(confirmed.output)
            })
          }
        }
      }
    },
  }
}
