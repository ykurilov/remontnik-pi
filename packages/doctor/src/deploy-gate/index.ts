import type { DiffInspection } from '../diff-inspector/index.js'
import type { ForbiddenZoneHit } from '../forbidden-zones/index.js'

// Решение о выкатке (R6, FR-020): чистая функция от фактов. Любой непройденный пункт → `report_only`.
// Модель на решение не влияет: факты собирает код, а неуверенность (нет данных, невозможные числа) считается непройденным пунктом.

export type GateReasonCode =
  | 'tests_not_green'
  | 'eval_worse'
  | 'forbidden_zone'
  | 'existing_test_changed'
  | 'suspicious_change'
  | 'diff_too_large'
  | 'stop_switch'
  | 'attempts_exhausted'
  | 'needs_human_after_rollback'
  | 'budget_exhausted'
  | 'rebase_conflict'
  | 'facts_invalid'

export interface GateReason {
  code: GateReasonCode
  /** Объяснение для отчёта. */
  message: string
  /** Файлы или тесты, о которых речь. */
  paths?: string[]
  numbers?: Record<string, number>
}

export interface GateDecision {
  verdict: 'deploy' | 'report_only'
  reasons: GateReason[]
}

export interface DeployFacts {
  tests: { status: 'green' | 'red' | 'flaky' | 'not_run'; failed: string[] }
  /** `not_needed` — правка вне области сценариев; `not_run` — должен был идти, но не шёл. */
  eval: { status: 'not_needed' | 'not_worse' | 'worse' | 'stand_broken' | 'not_run'; worseScenarios: string[] }
  forbiddenZones: ForbiddenZoneHit[]
  diff: DiffInspection
  stopSwitch: boolean
  attempts: {
    autoDeploysForFingerprint: number
    maxPerFingerprintPerDay: number
    autoDeploysToday: number
    maxPerDay: number
    /** Отпечаток помечен «нужен человек» после отката. */
    needsHumanAfterRollback: boolean
  }
  spend: { modelUsd: number; modelLimitUsd: number; evalUsd: number; evalLimitUsd: number }
  /** Перенос правки на свежую основную ветку. */
  rebase: 'clean' | 'conflict'
}

const TESTS_PROBLEM: Record<Exclude<DeployFacts['tests']['status'], 'green'>, string> = {
  red: 'тесты красные',
  flaky: 'тесты нестабильны',
  not_run: 'тесты не запускались',
}

const EVAL_PROBLEM: Record<Exclude<DeployFacts['eval']['status'], 'not_needed' | 'not_worse'>, string> = {
  worse: 'сценарии eval хуже прежних',
  stand_broken: 'стенд eval сломан',
  not_run: 'eval не запускался, хотя должен был',
}

const TESTS_STATUSES = ['green', 'red', 'flaky', 'not_run']
const EVAL_STATUSES = ['not_needed', 'not_worse', 'worse', 'stand_broken', 'not_run']
const EXCEEDS_VALUES = ['lines', 'files', 'unknown']
const REBASE_VALUES = ['clean', 'conflict']

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function isListOf(value: unknown, allowed?: readonly string[]): boolean {
  return Array.isArray(value) && value.every((item) => (allowed ? typeof item === 'string' && allowed.includes(item) : true))
}

/** Названия фактов, которые отсутствуют или невозможны. Пусто — факты годятся. */
function invalidFactNames(facts: unknown): string[] {
  if (!isRecord(facts)) return ['facts']
  const bad: string[] = []
  const check = (name: string, ok: boolean) => {
    if (!ok) bad.push(name)
  }
  const section = (name: string): Record<string, unknown> => {
    const value = facts[name]
    if (!isRecord(value)) {
      bad.push(name)
      return {}
    }
    return value
  }

  const tests = section('tests')
  check('tests.status', typeof tests.status === 'string' && TESTS_STATUSES.includes(tests.status))
  check('tests.failed', isListOf(tests.failed))

  const evalFacts = section('eval')
  check('eval.status', typeof evalFacts.status === 'string' && EVAL_STATUSES.includes(evalFacts.status))
  check('eval.worseScenarios', isListOf(evalFacts.worseScenarios))

  check('forbiddenZones', isListOf(facts.forbiddenZones))

  const diff = section('diff')
  check('diff.existingTestChanges', isListOf(diff.existingTestChanges))
  check('diff.suspicious', isListOf(diff.suspicious))
  const size = isRecord(diff.size) ? diff.size : undefined
  if (!size) bad.push('diff.size')
  else {
    // Правка без файлов — не «всё чисто», а «нечего проверять».
    check('diff.size.files', isCount(size.files) && size.files > 0)
    check('diff.size.lines', isCount(size.lines))
    check('diff.size.exceeds', isListOf(size.exceeds, EXCEEDS_VALUES))
  }

  check('stopSwitch', typeof facts.stopSwitch === 'boolean')
  check('rebase', typeof facts.rebase === 'string' && REBASE_VALUES.includes(facts.rebase))

  const attempts = section('attempts')
  for (const key of ['autoDeploysForFingerprint', 'maxPerFingerprintPerDay', 'autoDeploysToday', 'maxPerDay']) {
    check(`attempts.${key}`, isCount(attempts[key]))
  }
  check('attempts.needsHumanAfterRollback', typeof attempts.needsHumanAfterRollback === 'boolean')

  const spend = section('spend')
  for (const key of ['modelUsd', 'modelLimitUsd', 'evalUsd', 'evalLimitUsd']) {
    check(`spend.${key}`, isCount(spend[key]))
  }
  return bad
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)]
}

/** Выкатывать правку самому или только сообщить. Возвращает все причины отказа, а не первую. */
export function decideDeploy(facts: DeployFacts): GateDecision {
  const invalid = invalidFactNames(facts)
  if (invalid.length > 0) {
    return {
      verdict: 'report_only',
      reasons: [
        {
          code: 'facts_invalid',
          message: `Выкатки нет: факты неполные или невозможные (${invalid.join(', ')}). Нет данных — нет выкатки.`,
          paths: invalid,
        },
      ],
    }
  }

  const reasons: GateReason[] = []

  if (facts.tests.status !== 'green') {
    reasons.push({
      code: 'tests_not_green',
      message: `Выкатки нет: ${TESTS_PROBLEM[facts.tests.status]}.`,
      paths: [...facts.tests.failed],
    })
  }

  if (facts.eval.status !== 'not_needed' && facts.eval.status !== 'not_worse') {
    reasons.push({
      code: 'eval_worse',
      message: `Выкатки нет: ${EVAL_PROBLEM[facts.eval.status]}.`,
      paths: [...facts.eval.worseScenarios],
    })
  }

  if (facts.forbiddenZones.length > 0) {
    const zones = unique(facts.forbiddenZones.map((hit) => hit.zone))
    reasons.push({
      code: 'forbidden_zone',
      message: `Выкатки нет: правка затрагивает запретные зоны (${zones.join(', ')}). Нужен человек.`,
      paths: unique(facts.forbiddenZones.map((hit) => hit.path)),
    })
  }

  if (facts.diff.existingTestChanges.length > 0) {
    reasons.push({
      code: 'existing_test_changed',
      message: 'Выкатки нет: правка меняет или удаляет существующие тесты, сценарии eval или рубрики.',
      paths: unique(facts.diff.existingTestChanges.map((change) => change.path)),
    })
  }

  if (facts.diff.suspicious.length > 0) {
    const signals = unique(facts.diff.suspicious.map((finding) => finding.signal))
    reasons.push({
      code: 'suspicious_change',
      message: `Выкатки нет: в правке есть подозрительное (${signals.join(', ')}).`,
      paths: unique(facts.diff.suspicious.map((finding) => finding.path)),
    })
  }

  if (facts.diff.size.exceeds.length > 0) {
    reasons.push({
      code: 'diff_too_large',
      message: `Выкатки нет: правка слишком большая (файлов: ${facts.diff.size.files}, строк: ${facts.diff.size.lines}).`,
      numbers: { files: facts.diff.size.files, lines: facts.diff.size.lines },
    })
  }

  if (facts.stopSwitch) {
    reasons.push({ code: 'stop_switch', message: 'Выкатки нет: включён стоп-кран.' })
  }

  const { attempts } = facts
  if (
    attempts.autoDeploysForFingerprint >= attempts.maxPerFingerprintPerDay ||
    attempts.autoDeploysToday >= attempts.maxPerDay
  ) {
    reasons.push({
      code: 'attempts_exhausted',
      message: 'Выкатки нет: лимит автоматических выкаток исчерпан.',
      numbers: {
        autoDeploysForFingerprint: attempts.autoDeploysForFingerprint,
        maxPerFingerprintPerDay: attempts.maxPerFingerprintPerDay,
        autoDeploysToday: attempts.autoDeploysToday,
        maxPerDay: attempts.maxPerDay,
      },
    })
  }

  if (attempts.needsHumanAfterRollback) {
    reasons.push({
      code: 'needs_human_after_rollback',
      message: 'Выкатки нет: после отката эта причина помечена «нужен человек».',
    })
  }

  const { spend } = facts
  if (spend.modelUsd >= spend.modelLimitUsd || spend.evalUsd >= spend.evalLimitUsd) {
    reasons.push({
      code: 'budget_exhausted',
      message: 'Выкатки нет: потолок расходов за сутки достигнут.',
      numbers: {
        modelUsd: spend.modelUsd,
        modelLimitUsd: spend.modelLimitUsd,
        evalUsd: spend.evalUsd,
        evalLimitUsd: spend.evalLimitUsd,
      },
    })
  }

  if (facts.rebase === 'conflict') {
    reasons.push({ code: 'rebase_conflict', message: 'Выкатки нет: основа устарела, перенос правки дал конфликт.' })
  }

  return { verdict: reasons.length === 0 ? 'deploy' : 'report_only', reasons }
}
