import type { RemontnikConfig } from '@ykurilov/remontnik-core/config'
import type { CaseState } from '../case-book/index.js'
import type { ChangedFile } from '../changed-files/index.js'
import type { ChecksResult } from '../checks/index.js'
import type { DeployFacts, GateDecision, GateReasonCode } from '../deploy-gate/index.js'
import { inspectDiff, type DiffInspection } from '../diff-inspector/index.js'
import { findForbiddenZones, type ForbiddenZoneHit } from '../forbidden-zones/index.js'
import type { ReportType } from '../reports/index.js'
import type { Diagnosis } from './doc.js'
import { findProtectedChanges, type ProtectedChange } from './protected-changes.js'
import { evalSpentUsd, modelSpentUsd, type SpendDay } from '../ledgers/spend-ledger.js'

// Фаза `gated` лечения (R6, FR-020): факты о правке собирает код, выкатывать или нет — решает только `decideDeploy`.
// Осмотр диффа делается один раз, после коммита правки. Если правке нельзя доверить собственную проверку
// (защищённые пути, подозрительный код), проверки не запускаются и ветка не отправляется: решение получает
// «тесты и eval не запускались» и, как и при любом другом отказе, закрывает случай отчётом.
// Сбой, брошенный в коде Agent Chat SDK (место сбоя или верхний кадр стека), считается запретной зоной
// `agent_chat_sdk`, даже если модель SDK не назвала: правку в приложении выкатывает только человек.

/** Всё, что код знает о диффе правки. */
export interface FixInspection {
  forbiddenZones: ForbiddenZoneHit[]
  protectedChanges: ProtectedChange[]
  diff: DiffInspection
}

/** Стоп-кран и перенос правки на свежую основную ветку — их даёт выкатка (этап 6). Попытки — учёт по отпечатку (`ledgers/fingerprint-ledger.ts`). */
export type DeployControlFacts = Pick<DeployFacts, 'stopSwitch' | 'rebase'>

export interface DeployControls {
  read(input: { caseId: number; fingerprint: string; config: RemontnikConfig }): Promise<DeployControlFacts>
}

/** Итог фазы: каким отчётом и состоянием закрыть случай. */
export interface GateClosing {
  kind: 'deploy' | 'checks_red' | 'stand_broken' | 'needs_human' | 'not_deployed'
  caseState: CaseState
  report: ReportType
}

const SDK_PACKAGE_PREFIX = '@ykurilov/agent-chat-'
const SDK_PACKAGE_NAME = /^@ykurilov\/agent-chat-[a-z0-9-]+$/
const SDK_PACKAGE_IN_PATH = /@ykurilov(?:\/|\+|__)(agent-chat-[a-z0-9-]+)/
const STACK_FRAME = /^\s*at\s+(.*)$/
/** Правка готова и проверена; выкатке мешает только состояние врача, а не сама правка. */
const OPERATIONAL: readonly GateReasonCode[] = ['stop_switch', 'attempts_exhausted', 'budget_exhausted', 'rebase_conflict']

/** Место сбоя в коде Agent Chat SDK: `where` или верхний кадр стека. Кадры SDK глубже — обычный путь вызова. */
function sdkFrameOf(incident: { where: string; stack: string }): { location: string; packageName: string } | undefined {
  const topFrame = incident.stack.split('\n').flatMap((line) => STACK_FRAME.exec(line)?.[1] ?? [])[0]
  for (const location of [incident.where, topFrame]) {
    const found = location ? SDK_PACKAGE_IN_PATH.exec(location) : null
    if (location && found) return { location: location.trim(), packageName: `@ykurilov/${found[1]}` }
  }
  return undefined
}

export function inspectFix(config: RemontnikConfig, files: readonly ChangedFile[], incident: { where: string; stack: string }): FixInspection {
  const sdkFrame = sdkFrameOf(incident)
  return {
    forbiddenZones: [
      ...findForbiddenZones(config, files),
      ...(sdkFrame ? [{ path: sdkFrame.location, zone: 'agent_chat_sdk' as const, rule: `стек случая: сбой в коде ${sdkFrame.packageName}` }] : []),
    ],
    protectedChanges: findProtectedChanges(config, files),
    diff: inspectDiff(files, config.limits, {
      knownHosts: config.browser?.allowedOrigins ?? [],
      ...(config.checks.eval ? { evalResultFile: config.checks.eval.resultFile } : {}),
    }),
  }
}

/** Проверки правки чего-то стоят, только если она не трогает то, чем её проверяют, и не похожа на подделку итога. */
export function fixCanBeChecked(inspection: FixInspection): boolean {
  return inspection.protectedChanges.length === 0 && inspection.diff.suspicious.length === 0
}

/** Пока выкатки нет: стоп-крана нет, перенос не нужен. Решение `deploy` закрывается отчётом. */
export function noDeployControls(): DeployControlFacts {
  return { stopSwitch: false, rebase: 'clean' }
}

export function deployFactsOf(input: {
  inspection: FixInspection
  /** Нет — проверки не запускались. */
  checks: ChecksResult | undefined
  controls: DeployControlFacts
  /** Учёт попыток по отпечатку. */
  attempts: DeployFacts['attempts']
  spendDay: SpendDay
  limits: RemontnikConfig['limits']
}): DeployFacts {
  const { inspection, checks } = input
  // Путь — под самой точной причиной: тест или запретная зона не повторяются среди защищённых путей.
  const named = new Set([...inspection.diff.existingTestChanges.map((change) => change.path), ...inspection.forbiddenZones.map((hit) => hit.path)])
  return {
    tests: checks ? { status: checks.tests.status, failed: [...checks.tests.failed] } : { status: 'not_run', failed: [] },
    eval: checks
      ? {
          status: checks.eval.status,
          worseScenarios: checks.eval.scenarios.filter((scenario) => scenario.candidatePass < scenario.basePass).map((scenario) => scenario.id),
        }
      : { status: 'not_run', worseScenarios: [] },
    forbiddenZones: inspection.forbiddenZones,
    protectedChanges: inspection.protectedChanges.filter((change) => !named.has(change.path)),
    diff: inspection.diff,
    ...input.controls,
    attempts: input.attempts,
    spend: {
      modelUsd: modelSpentUsd(input.spendDay),
      modelLimitUsd: input.limits.doctorModelUsdPerDay,
      evalUsd: evalSpentUsd(input.spendDay),
      evalLimitUsd: input.limits.evalUsdPerDay,
    },
  }
}

/**
 * Пакет Agent Chat SDK, в котором причина: его назвал диагноз, на него указывает стек или в него полезла правка. SDK врач не правит —
 * пишет задачу для агента SDK. Модель может только остановить лечение, но не разрешить выкатку.
 */
export function agentChatSdkPackage(diagnosis: Diagnosis, inspection?: FixInspection): string | undefined {
  // Имя не по форме пакета SDK считается неназванным.
  const named = diagnosis.causeInPackage
  if (named !== undefined && SDK_PACKAGE_NAME.test(named)) return named
  const hit = inspection?.forbiddenZones.find((zone) => zone.zone === 'agent_chat_sdk')
  if (!hit) return undefined
  const found = SDK_PACKAGE_IN_PATH.exec(hit.path) ?? SDK_PACKAGE_IN_PATH.exec(hit.rule)
  return found ? `@ykurilov/${found[1]!.toLowerCase()}` : `${SDK_PACKAGE_PREFIX}*`
}

export function closingOf(decision: GateDecision, checks: ChecksResult | undefined): GateClosing {
  if (decision.verdict === 'deploy') return { kind: 'deploy', caseState: 'report_only', report: 'fix_ready' }
  const codes = decision.reasons.map((reason) => reason.code)
  const only = (allowed: readonly GateReasonCode[]) => codes.every((code) => allowed.includes(code))
  if (only(OPERATIONAL)) return { kind: 'not_deployed', caseState: 'report_only', report: 'fix_ready' }
  if (checks && only(['tests_not_green', 'eval_worse', ...OPERATIONAL])) {
    if (checks.eval.status === 'stand_broken') return { kind: 'stand_broken', caseState: 'stand_broken', report: 'stand_broken' }
    if (checks.tests.status === 'red' || checks.tests.status === 'not_run') return { kind: 'checks_red', caseState: 'report_only', report: 'cause_found' }
  }
  return { kind: 'needs_human', caseState: 'report_only', report: 'needs_human' }
}
