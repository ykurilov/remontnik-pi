import { randomBytes } from 'node:crypto'
import type { RemontnikConfig } from '@ykurilov/remontnik-core/config'
import { readErrorBaseline, type ErrorBaseline } from '../case-book/error-hours.js'
import { readControls } from '../ledgers/controls.js'
import { copyRecord, type RecordStore, type RecordTransaction } from '../records/index.js'
import { createReports } from '../reports/index.js'
import { abandonedDeploymentReport, lockWaitReport, lostLockReport } from '../reports/texts.js'
import type { AppCommands } from './app-commands.js'
import type { DeployLock, LockHolder } from './lock.js'
import { mainCopyChange, type MainCopy, type MainCopySnapshot } from './main-copy.js'
import { OBSERVE_TICK_MS, observe, readObservationTick, startObservation, type ObservationState, type RollbackReason } from './observer.js'

// Выкатка правки (contracts/deploy-commands.md): замок → снимок рабочей копии → `current` → метка git на прежней
// версии → `build` → стоп-кран → `promote` → `current` = кандидат → наблюдение (первый тик с `health` — сразу) →
// `confirm` → замок снят. Сбой после `promote` или ухудшение в окне → `rollback` → `current` = прежняя.
// Перед `promote`, `rollback`, `current` и `health` рабочая копия сверяется со снимком: изменилась до `promote` —
// отказ, после — откат. После `promote` и перед каждым действием с приложением выкатка проверяет, что замок всё ещё
// её; потерян — выкатка брошена, приложение больше не трогает, нужен человек.
//
// Врач может упасть на любом шаге, и шаг тогда идёт заново. Поэтому каждый шаг: записать намерение → сделать →
// проверить настоящее состояние сервера (`current`), а не память. `promote` идёт, только пока работает прежняя
// версия; `rollback` — только пока работает не прежняя, и попытка считается, когда `rollback` закончился: лучше
// лишний повтор, чем потерянный откат. Выкатка — документ `deployment/<id>`; ждать (замок, тик наблюдения, пауза
// между откатами) она не умеет сама: `step()` возвращает `sleep`, и задача pi-durable спит через
// `runtime.sleepUntil` (см. `runDeploymentInTask` в service/harness.ts).

export const DEPLOYMENT_COLLECTION = 'deployment'
export const DEPLOYMENT_INDEX_COLLECTION = 'deployment-index'
const INDEX_KEY = 'main'
/** Как часто проверять, свободен ли замок. */
export const LOCK_RETRY_MS = 30_000
const MAX_ROLLBACK_ATTEMPTS = 3
/** Запусков `rollback` с прерванными падением врача: больше — врач падает на самом откате, нужен человек. */
const MAX_ROLLBACK_LAUNCHES = 2 * MAX_ROLLBACK_ATTEMPTS
/** Пауза после неудачной попытки отката: 10 с, 30 с, 90 с; после последней — ещё одна проверка `current`. */
const ROLLBACK_PAUSE_MS = 10_000
const DETAIL_LIMIT = 4000

export type DeployStage = 'starting' | 'locked' | 'tagging' | 'building' | 'promoting' | 'observing' | 'rolling_back' | 'confirming' | 'done'
export type DeployOutcome =
  | 'in_progress'
  | 'holding'
  | 'not_helped'
  | 'rolled_back'
  | 'superseded_by_human'
  | 'rollback_failed'
  | 'refused'
  /** Замок потерян посреди выкатки или её задача умерла: что работает, не подтверждено. */
  | 'abandoned'
/** Почему выкатка не началась; работающую версию при этом не трогали. */
export type DeployRefusal =
  | 'stop_switch'
  | 'current_unavailable'
  | 'no_previous_build'
  | 'already_running'
  | 'tag_failed'
  | 'build_failed'
  | 'promote_failed'
  | 'main_copy_changed'
  /** Перед повтором `promote` замок оказался не этой выкатки. */
  | 'lock_lost'
  /** Работает кандидат брошенной выкатки: прежней версии, от которой можно откатиться, никто не подтверждал. */
  | 'unconfirmed_version'
export type RollbackCause = RollbackReason | 'promote_failed' | 'main_copy_changed'

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
  /** Знак выкатки в файле замка: по нему врач узнаёт свой замок. */
  lockToken: string
  /** Задача pi-durable, которая ведёт выкатку: умерла — замок выкатки брошен. */
  taskId?: number
  /** С какого времени ждёт замок (ручная или другая выкатка). */
  waitingLockSince?: string
  /** Когда позвал человека из-за долгого ожидания замка. */
  lockWaitReportedAt?: string
  /** Рабочая копия основной ветки в начале выкатки. */
  mainCopy?: MainCopySnapshot
  /** Рабочую копию изменили во время отката: откат всё равно шёл, но нужен человек. */
  mainCopyChange?: string
  previousVersion?: string
  preDeployTag?: string
  baseline?: ErrorBaseline
  /** Намерение `promote` записано: дальше по `current` видно, прошёл ли он. */
  promoteRequested?: boolean
  /** Когда `promote` вернулся: с этой минуты считаются ошибки кандидата. */
  promoteReturnedAt?: string
  /** Когда `current` подтвердил кандидата: от него окно наблюдения. */
  promotedAt?: string
  observeUntil?: string
  nextTickAt?: string
  observation?: ObservationState
  lastTick?: { at: string; errors: number; errorsPerHour: number; newFingerprints: string[]; caseFingerprintSeen: boolean }
  /** Итог окна наблюдения, пока идёт `confirm`. */
  verdict?: 'holding' | 'not_helped'
  rollbackCause?: RollbackCause
  rollbackReason?: string
  /** Законченные запуски `rollback`. */
  rollbackAttempts?: number
  /** Все запуски `rollback`, и прерванные падением врача: записываются до запуска. */
  rollbackLaunches?: number
  nextRollbackAt?: string
  healthyAfterRollback?: boolean
  healthAfterRollback?: string
  refusal?: DeployRefusal
  /** Хвост вывода команды или причина: для отчёта человеку. */
  detail?: string
  supersededBy?: string
  /** Какая выкатка сняла замок этой, когда её задача умерла. */
  abandonedBy?: number
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
  /** Задача pi-durable, которая ведёт выкатку. */
  taskId?: number
  /** Жива ли задача (не закончилась): по нему врач снимает замок выкатки, чья задача умерла. */
  isTaskAlive?(taskId: number): Promise<boolean>
}

export type DeployStep =
  | { kind: 'sleep'; until: number; stage: 'waiting_lock' | 'observing' | 'rolling_back'; deployment: Deployment }
  | { kind: 'done'; deployment: Deployment }

export type TagResult = { ok: true } | { ok: false; reason: string }

export interface DeployerDeps {
  /** Настройка приложения из основной ветки. */
  loadConfig(): Promise<RemontnikConfig>
  commandsFor(config: RemontnikConfig): AppCommands
  /** Рабочая копия основной ветки, из которой идут команды выкатки. */
  mainCopyFor(config: RemontnikConfig): MainCopy
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
  /** Кандидаты брошенных выкаток после намерения `promote`: такая версия не считается прежней. */
  abandonedVersions?: string[]
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
      lockToken: randomBytes(8).toString('hex'),
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
      const mainCopy = deps.mainCopyFor(config)
      const lock = deps.lockFor(config)
      const { store } = io
      const now = () => new Date(io.now())
      const windowMs = config.observe.windowMinutes * 60_000
      let deployment = await openDeployment(store, request, now())
      const id = deployment.deploymentId
      const holder: LockHolder = { deploymentId: id, token: deployment.lockToken }
      /** `promote` уже запускали в этом вызове: второй раз подряд — не выкатка, а сломанная команда. */
      let promotedHere = false

      async function save(change: (draft: Deployment) => void, alsoIn?: (tx: RecordTransaction) => Promise<unknown>): Promise<void> {
        deployment = await store.transaction(async (tx) => {
          const draft = await tx.doc<Deployment>(DEPLOYMENT_COLLECTION, String(id), {} as Deployment)
          change(draft)
          await alsoIn?.(tx)
          return copyRecord(draft)
        })
      }

      const reports = createReports({ store, now: () => io.now() })
      /** Гонка при снятии замка: чужой замок отложен в `lostFile` — человеку. */
      async function reportLostLock(lostFile: string): Promise<void> {
        const text = lostLockReport({ deployment, lockFile: config.deploy.lockFile, lostFile })
        await store.transaction((tx) => reports.addIn(tx, { type: 'needs_human', caseId: request.caseId, ...text, telegram: 'pending' }))
      }
      async function releaseLock(): Promise<void> {
        const { lost } = await lock.release(holder)
        if (lost) await reportLostLock(lost)
      }

      // Сначала итог в записи, потом замок: упадёт между ними — следующий вызов снимет замок на `done`.
      async function finish(change: (draft: Deployment) => void): Promise<DeployStep> {
        await save((draft) => {
          change(draft)
          draft.stage = 'done'
          draft.endedAt = now().toISOString()
        })
        await releaseLock()
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
      /** Замок потерян посреди выкатки: приложение больше не трогаем, разбираться человеку. */
      const lockLost = () =>
        finish((draft) => {
          draft.outcome = 'abandoned'
          draft.detail = 'замок выкатки потерян: его сняли или заняли посреди выкатки; после этого приложение не трогал'
        })
      const startRollback = (cause: RollbackCause, reason: string) =>
        save((draft) => {
          draft.stage = 'rolling_back'
          draft.rollbackCause = cause
          draft.rollbackReason = clip(reason)
        })
      /**
       * Выкатка, чья задача умерла, брошена: пометить, позвать человека и запомнить её кандидата — `promote` мог
       * пройти, и тогда работает версия, которую никто не подтверждал. Сама она уже никому не доложит.
       */
      async function markAbandoned(otherId: number): Promise<void> {
        await store.transaction(async (tx) => {
          const other = await tx.doc<Deployment>(DEPLOYMENT_COLLECTION, String(otherId), {} as Deployment)
          if (other.outcome !== 'in_progress') return
          other.outcome = 'abandoned'
          other.stage = 'done'
          other.endedAt = now().toISOString()
          other.abandonedBy = id
          other.detail = 'задача врача, которая вела выкатку, умерла; замок снят'
          if (other.promoteRequested) {
            const index = await tx.doc<DeploymentIndex>(DEPLOYMENT_INDEX_COLLECTION, INDEX_KEY, { nextId: 1, byRequest: {} })
            index.abandonedVersions = [...new Set([...(index.abandonedVersions ?? []), other.candidateVersion])]
          }
          const text = abandonedDeploymentReport({ deployment: copyRecord(other) })
          await reports.addIn(tx, { type: 'needs_human', caseId: other.caseId, ...text, telegram: 'pending' })
        })
      }
      /** Замок другой выкатки брошен: она из своих записей и закончилась или её задача умерла. Чужое не трогаем. */
      async function isStale(other: LockHolder): Promise<boolean> {
        const found = await readDeployment(store, other.deploymentId)
        if (!found || found.lockToken !== other.token) return false
        if (found.outcome !== 'in_progress') return true
        if (!found.taskId || found.taskId === io.taskId || !io.isTaskAlive) return false
        if (await io.isTaskAlive(found.taskId)) return false
        await markAbandoned(found.deploymentId)
        return true
      }
      async function acquireLock() {
        const attempt = await lock.acquire(holder, now(), isStale)
        if (!attempt.acquired && attempt.lost) await reportLostLock(attempt.lost)
        return attempt
      }
      /** До `promote` замок должен быть этой выкатки; потерян (сняли руками) — заново в очередь за ним. */
      async function holdsLock(): Promise<boolean> {
        if ((await acquireLock()).acquired) return true
        await save((draft) => {
          draft.stage = 'starting'
        })
        return false
      }
      /** Чем рабочая копия отличается от снимка начала выкатки; `undefined` — ничем. */
      async function mainCopyChanged(): Promise<string | undefined> {
        return deployment.mainCopy ? mainCopyChange(deployment.mainCopy, await mainCopy.snapshot()) : undefined
      }
      /**
       * Файлы, появившиеся в копии за свой `promote` или `rollback` (файлы состояния выкатки), — часть снимка, а не
       * чужая правка. Только список изменённых файлов: коммит и отпечатки настройки и скриптов не принимаются никогда.
       */
      async function acceptOwnFiles(): Promise<void> {
        if (!deployment.mainCopy) return
        const known = new Set(deployment.mainCopy.dirty)
        const fresh = (await mainCopy.snapshot()).dirty.filter((path) => !known.has(path))
        if (fresh.length === 0) return
        await save((draft) => {
          draft.mainCopy!.dirty = [...known, ...fresh].sort()
        })
      }

      if (io.taskId && deployment.taskId !== io.taskId && deployment.stage !== 'done') {
        const taskId = io.taskId
        await save((draft) => {
          draft.taskId = taskId
        })
      }

      for (;;) {
        switch (deployment.stage) {
          case 'done':
            await releaseLock()
            return { kind: 'done', deployment }

          case 'starting': {
            if ((await readControls(store)).autoDeploy === 'stopped') return refuse('stop_switch')
            const attempt = await acquireLock()
            if (!attempt.acquired) {
              const since = deployment.waitingLockSince ?? now().toISOString()
              const reportDue = !deployment.lockWaitReportedAt && io.now() - Date.parse(since) >= config.deploy.lockWaitReportMinutes * 60_000
              if (!deployment.waitingLockSince || reportDue) {
                await save(
                  (draft) => {
                    draft.waitingLockSince = since
                    if (reportDue) draft.lockWaitReportedAt = now().toISOString()
                  },
                  reportDue
                    ? (tx) => {
                        const text = lockWaitReport({ deployment, lockFile: config.deploy.lockFile, minutes: config.deploy.lockWaitReportMinutes, holder: attempt.content })
                        return reports.addIn(tx, { type: 'needs_human', caseId: request.caseId, ...text, telegram: 'pending' })
                      }
                    : undefined,
                )
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
            const snapshot = await mainCopy.snapshot()
            // В начале копия чистая: дальше новые изменённые файлы видны по сравнению с этим снимком.
            if (snapshot.dirty.length > 0) return refuse('main_copy_changed', mainCopyChange({ ...snapshot, dirty: [] }, snapshot))
            const current = await commands.current()
            if (!current.ok) return refuse('current_unavailable', current.reason)
            if (current.version === null) return refuse('no_previous_build')
            const abandoned = (await store.read<DeploymentIndex>(DEPLOYMENT_INDEX_COLLECTION, INDEX_KEY))?.abandonedVersions ?? []
            if (abandoned.includes(current.version)) return refuse('unconfirmed_version', `работает ${current.version} — кандидат брошенной выкатки`)
            if (current.version === request.candidateVersion) return refuse('already_running')
            const previousVersion = current.version
            await save((draft) => {
              draft.mainCopy = snapshot
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
              const changed = await mainCopyChanged()
              if (changed) return refuse('main_copy_changed', changed)
              const before = await commands.current()
              if (!before.ok) return refuse('current_unavailable', before.reason)
              if (before.version === null) return refuse('no_previous_build')
              if (before.version !== previousVersion) return superseded(before.version)
              // Стоп-кран — последним, прямо перед намерением: после него `promote` уже не остановить.
              if ((await readControls(store)).autoDeploy === 'stopped') return refuse('stop_switch')
              await save((draft) => {
                draft.promoteRequested = true
              })
            }
            // Повтор после падения врача: `promote` мог пройти, и его файлы состояния — не чужая правка.
            if (!promotedHere) await acceptOwnFiles()
            const changed = await mainCopyChanged()
            if (changed) {
              await startRollback('main_copy_changed', changed)
              break
            }
            let current = await commands.current()
            if (current.ok && current.version === previousVersion) {
              if (promotedHere) return refuse('promote_failed', 'promote закончился успешно, а работает прежняя версия')
              // Пока врач лежал, замок могли снять или занять, а стоп-кран — нажать.
              if (!(await lock.holds(holder))) return refuse('lock_lost', 'замок выкатки перед promote оказался не этой выкатки')
              if ((await readControls(store)).autoDeploy === 'stopped') return refuse('stop_switch')
              const promoted = await commands.promote()
              promotedHere = true
              await save((draft) => {
                draft.promoteReturnedAt = now().toISOString()
              })
              await acceptOwnFiles()
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
            // Время выкатки — когда `current` подтвердил кандидата: от него окно наблюдения. Ошибки — с конца `promote`.
            await save((draft) => {
              draft.stage = 'observing'
              draft.promotedAt = now().toISOString()
              draft.observeUntil = new Date(io.now() + windowMs).toISOString()
              draft.observation = startObservation()
              draft.nextTickAt = now().toISOString()
            })
            break
          }

          case 'observing': {
            const nextTickAt = Date.parse(deployment.nextTickAt!)
            if (io.now() < nextTickAt) return { kind: 'sleep', until: nextTickAt, stage: 'observing', deployment }
            if (!(await lock.holds(holder))) return lockLost()
            // Врач спал дольше окна: прошлые проверки устарели, окно начинается заново.
            const lastLook = Date.parse(deployment.lastTick?.at ?? deployment.promotedAt!)
            if (io.now() - lastLook > windowMs) {
              await save((draft) => {
                draft.observeUntil = new Date(io.now() + windowMs).toISOString()
                draft.observation = startObservation()
              })
            }
            const changed = await mainCopyChanged()
            if (changed) {
              await startRollback('main_copy_changed', changed)
              break
            }
            const observeUntil = new Date(deployment.observeUntil!)
            const tick = await readObservationTick({
              commands,
              records: store,
              appName: request.appName,
              at: now(),
              errorsFrom: new Date(deployment.promoteReturnedAt ?? deployment.promotedAt!),
              baseline: deployment.baseline!,
              caseFingerprint: request.fingerprint,
            })
            const { state, verdict } = observe(deployment.observation ?? startObservation(), tick, {
              settings: config.observe,
              baseline: deployment.baseline!,
              candidateVersion: request.candidateVersion,
              previousVersion: deployment.previousVersion!,
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
                const untilWindowEnd = observeUntil.getTime() > io.now() ? observeUntil.getTime() : io.now() + tickMs
                draft.nextTickAt = new Date(Math.min(io.now() + tickMs, untilWindowEnd)).toISOString()
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
            if (!(await lock.holds(holder))) return lockLost()
            // Прерванный падением врача `rollback` мог оставить свои файлы состояния.
            if ((deployment.rollbackLaunches ?? 0) > (deployment.rollbackAttempts ?? 0)) await acceptOwnFiles()
            // Изменённая копия отката не останавливает: откатиться важнее, но позвать человека надо.
            const changed = await mainCopyChanged()
            if (changed && changed !== deployment.mainCopyChange) {
              await save((draft) => {
                draft.mainCopyChange = clip(changed)
              })
            }
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
            // Пауза — до решения «не удалось»: приложение могло вернуться к прежней и после последней попытки.
            const pauseUntil = deployment.nextRollbackAt ? Date.parse(deployment.nextRollbackAt) : 0
            if (io.now() < pauseUntil) return { kind: 'sleep', until: pauseUntil, stage: 'rolling_back', deployment }
            const attempts = deployment.rollbackAttempts ?? 0
            if (attempts >= MAX_ROLLBACK_ATTEMPTS) {
              return finish((draft) => {
                draft.outcome = 'rollback_failed'
              })
            }
            const launches = deployment.rollbackLaunches ?? 0
            if (launches >= MAX_ROLLBACK_LAUNCHES) {
              return finish((draft) => {
                draft.outcome = 'rollback_failed'
                draft.detail = `rollback запускался ${launches} раз и не доходил до конца: врач падал посреди него`
              })
            }
            if (!(await lock.holds(holder))) return lockLost()
            await save((draft) => {
              draft.rollbackLaunches = launches + 1
            })
            const rolled = await commands.rollback()
            await save((draft) => {
              draft.rollbackAttempts = attempts + 1
              draft.nextRollbackAt = new Date(io.now() + ROLLBACK_PAUSE_MS * 3 ** attempts).toISOString()
              if (!rolled.ok) draft.detail = clip(rolled.output)
            })
            await acceptOwnFiles()
            break
          }

          case 'confirming': {
            if (!(await lock.holds(holder))) return lockLost()
            const changed = await mainCopyChanged()
            if (changed) {
              await startRollback('main_copy_changed', changed)
              break
            }
            const current = await commands.current()
            if (!current.ok || current.version === null) {
              await startRollback('current_unavailable', current.ok ? 'current: работающей версии нет' : current.reason)
              break
            }
            if (current.version === deployment.previousVersion) {
              await startRollback('reverted', 'приложение вернулось к прежней версии')
              break
            }
            if (current.version !== request.candidateVersion) return superseded(current.version)
            if (!(await lock.holds(holder))) return lockLost()
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
