import { truncateText, type IncidentKind } from '@ykurilov/remontnik-core/incident'
import type { ChecksResult, EvalOutcome } from '../checks/index.js'
import type { Deployment, DeployRefusal, RollbackCause } from '../deployer/deploy-sequence.js'
import type { HandoffResult, ReclaimReason } from '../handoff/doc.js'
import type { Diagnosis, FixSummary } from '../treatment/doc.js'
import { REPORT_SHORT_LIMIT, type ReportType } from './index.js'

// Тексты отчётов лечения: короткий — для Telegram, полный — для журнала и Paseo.

export interface ReportText {
  short: string
  full: string
  /** Пути к снимкам экрана браузера врача. */
  screenshots?: string[]
  /** Отчёт сам говорит, что выкатки нет из-за стоп-крана: приписка о нём при отправке не нужна. */
  stopSwitch?: true
}

export interface ReportCase {
  caseId: number
  appName: string
  kind: IncidentKind
  where: string
  message: string
}

const usd = (value: number) => `$${value.toFixed(2)}`

export function head(sick: ReportCase): string {
  return `Случай ${sick.caseId} (${sick.appName})`
}

/**
 * Случай кончился без излечения и сам второй раз не лечится: отчёт заканчивается командой повтора. Короткий текст
 * обрезается так, чтобы команда в Telegram дошла целиком.
 */
export function withRetryHint(text: ReportText, caseId: number): ReportText {
  const hint = `Лечить заново: remontnik-doctor case ${caseId} retry`
  return { ...text, short: `${truncateText(text.short, REPORT_SHORT_LIMIT - hint.length - 2)}\n\n${hint}`, full: `${text.full}\n\n${hint}` }
}

export function caseLines(sick: ReportCase): string[] {
  return [`Сбой: ${sick.kind} в ${sick.where || 'неизвестном месте'} — ${sick.message}`]
}

export function diagnosisLines(diagnosis: Diagnosis | undefined): string[] {
  if (!diagnosis) return []
  return [
    `Причина: ${diagnosis.cause}`,
    `Уверенность: ${diagnosis.confidence}`,
    ...(diagnosis.evidence.length > 0 ? ['Улики:', ...diagnosis.evidence.map((item) => `- ${item}`)] : []),
    ...(diagnosis.fixPlan ? [`План правки: ${diagnosis.fixPlan}`] : []),
  ]
}

function worseScenarios(outcome: EvalOutcome): string[] {
  return outcome.scenarios.filter((scenario) => scenario.candidatePass < scenario.basePass).map((scenario) => scenario.id)
}

export function evalShort(outcome: EvalOutcome): string {
  switch (outcome.status) {
    case 'not_needed':
      return 'eval не нужен'
    case 'not_worse':
      return 'eval не хуже'
    case 'worse':
      return `eval хуже: ${worseScenarios(outcome).join(', ')}`
    case 'stand_broken':
      return 'стенд eval сломан'
    case 'not_run':
      return `eval не запускался${outcome.note ? ` (${outcome.note})` : ''}`
  }
}

export function checksLines(checks: ChecksResult): string[] {
  const { tests } = checks
  return [
    `Тесты: ${tests.status}${tests.failed.length > 0 ? `, упали: ${tests.failed.join(', ')}` : ''} (${Math.round(tests.durationMs / 1000)} с)`,
    ...(tests.outputTail ? ['Хвост вывода:', tests.outputTail] : []),
    `Eval: ${checks.eval.status}${checks.eval.truncated ? ', не все сценарии (предел maxScenarios)' : ''}, расход ${usd(checks.eval.costUsd)}`,
    ...checks.eval.scenarios.map((scenario) => `- ${scenario.id}: ${scenario.basePass}/${scenario.repeats} → ${scenario.candidatePass}/${scenario.repeats}`),
    ...(checks.eval.note ? [`Заметка: ${checks.eval.note}`] : []),
  ]
}

export function fixReadyReport(input: {
  case: ReportCase
  diagnosis: Diagnosis
  fix: FixSummary
  branch: string
  commit: string
  checks: ChecksResult
  pushed: boolean
}): ReportText {
  const tests = input.checks.tests.status === 'flaky' ? 'тесты зелёные со второго раза (нестабильный тест)' : 'тесты зелёные'
  const short = [
    `${head(input.case)}: правка готова в ветке ${input.branch}, ${tests}, ${evalShort(input.checks.eval)}.`,
    input.pushed ? '' : ' Ветка не отправлена в origin.',
    ' Я её не выкатывал.',
    ` Причина: ${input.diagnosis.cause}`,
  ].join('')
  const full = [
    short,
    '',
    ...caseLines(input.case),
    ...diagnosisLines(input.diagnosis),
    `Правка: ${input.fix.summary}`,
    `Тесты в правке: ${input.fix.testsAdded.join(', ') || 'нет'}`,
    ...(input.fix.notes ? [`Заметки: ${input.fix.notes}`] : []),
    `Ветка: ${input.branch}, коммит ${input.commit.slice(0, 12)}`,
    ...checksLines(input.checks),
  ].join('\n')
  return { short, full }
}

export function noCauseFoundReport(input: {
  case: ReportCase
  reason: 'budget' | 'day_budget' | 'not_found' | 'no_answer'
  spentUsd: number
  limitUsd: number
  diagnosis?: Diagnosis
}): ReportText {
  const why = {
    budget: `кончился бюджет (${usd(input.spentUsd)} из ${usd(input.limitUsd)})`,
    day_budget: `кончился дневной бюджет модели (${usd(input.limitUsd)} в день), на случай потрачено ${usd(input.spentUsd)}`,
    not_found: 'модель не нашла причину',
    no_answer: 'модель не дала диагноза',
  }[input.reason]
  const short = `${head(input.case)}: причину не нашёл — ${why}.${input.diagnosis?.cause ? ` Что понял: ${input.diagnosis.cause}` : ''}`
  const full = [short, '', ...caseLines(input.case), `Почему остановился: ${why}`, `Потрачено на модель: ${usd(input.spentUsd)}`, ...diagnosisLines(input.diagnosis)].join('\n')
  return { short, full }
}

export function causeFoundReport(input: {
  case: ReportCase
  diagnosis: Diagnosis
  reason: 'budget' | 'day_budget' | 'no_answer' | 'no_changes' | 'checks_red'
  branch?: string
  checks?: ChecksResult
}): ReportText {
  const failed = input.checks?.tests.failed ?? []
  const what = {
    budget: 'правку не сделал: кончился бюджет',
    day_budget: 'правку не сделал: кончился дневной бюджет модели',
    no_answer: 'правку не сделал: модель не закончила',
    no_changes: 'правку не сделал: модель ничего не изменила',
    checks_red: `правка в ветке ${input.branch ?? '—'} не прошла тесты${failed.length > 0 ? `: ${failed.join(', ')}` : ''}`,
  }[input.reason]
  const short = `${head(input.case)}: причину нашёл, ${what}. Причина: ${input.diagnosis.cause}`
  const full = [short, '', ...caseLines(input.case), ...diagnosisLines(input.diagnosis), ...(input.checks ? checksLines(input.checks) : [])].join('\n')
  return { short, full }
}

export function standBrokenReport(input: { case: ReportCase; branch: string; checks: ChecksResult }): ReportText {
  const short = `${head(input.case)}: стенд проверки сломан, правку в ветке ${input.branch} оценить не смог. Нужен человек.`
  const full = [short, '', ...caseLines(input.case), ...checksLines(input.checks)].join('\n')
  return { short, full }
}

export type NeedsHumanReason =
  | { kind: 'escape'; detail: string }
  | { kind: 'spoiled'; detail: string }

/** Врач остановился и ничего не выкатит: правку должен посмотреть человек. */
export function needsHumanReport(input: { case: ReportCase; diagnosis?: Diagnosis; fix?: FixSummary; reason: NeedsHumanReason }): ReportText {
  const { reason } = input
  const what = (() => {
    switch (reason.kind) {
      case 'escape':
        return 'модель пыталась выбраться из верстака: копия подменена, лечение остановлено'
      case 'spoiled':
        return 'команда в копии не остановлена, копия испорчена: я ничего не коммитил, лечение остановлено'
    }
  })()
  const short = `${head(input.case)}: ${what}. Нужен человек.`
  const full = [
    short,
    '',
    ...caseLines(input.case),
    ...diagnosisLines(input.diagnosis),
    ...(input.fix ? [`Правка: ${input.fix.summary}`] : []),
    ...(reason.kind === 'escape' ? [`Что нашёл git-замок: ${reason.detail}`] : []),
    ...(reason.kind === 'spoiled' ? [`Что случилось: ${reason.detail}. Контейнер надо остановить вручную, копию — удалить.`] : []),
  ].join('\n')
  return { short, full }
}

/**
 * Браузер врача упёрся в проверку для человека (капча, код из SMS). Есть живой экран — ссылка на него: человек
 * проходит проверку и жмёт «Вернуть», врач продолжает с того же шага. Нет — врач продолжает без браузера.
 */
export function browserNeedsHumanReport(input: { case: ReportCase; reason: string; liveLink?: string; waitMinutes: number }): ReportText {
  const next = input.liveLink
    ? `Пройдите её на живом экране: ${input.liveLink} — затем нажмите «Вернуть», и я продолжу с того же шага. Жду до ${input.waitMinutes} мин, потом продолжу без браузера.`
    : 'Живой экран не включён (browser.live): продолжаю лечение без браузера.'
  const short = `${head(input.case)}: браузер врача остановился на проверке для человека — ${input.reason}. ${next}`
  return { short, full: [short, '', ...caseLines(input.case)].join('\n') }
}

const version = (value: string | undefined) => (value ? value.slice(0, 12) : '—')
/** Время из ISO-строки: `12:31 UTC`. */
const clock = (iso: string | undefined) => (iso ? `${iso.slice(11, 16)} UTC` : '—')

const ROLLBACK_CAUSES: Record<RollbackCause, string> = {
  health: 'приложение не прошло проверку здоровья',
  error_rate: 'ошибок стало больше, чем до выкатки',
  new_fingerprints: 'появились новые сбои',
  promote_failed: 'команда promote не довела выкатку',
  current_unavailable: 'приложение не говорит, какая версия работает',
  reverted: 'приложение вернулось к прежней версии',
  main_copy_changed: 'рабочую копию основной ветки на сервере кто-то изменил',
}

const REFUSALS: Record<DeployRefusal, string> = {
  stop_switch: 'включён стоп-кран',
  current_unavailable: 'приложение не говорит, какая версия работает',
  no_previous_build: 'на сервере нет прежней сборки, откатываться было бы некуда',
  already_running: 'эта версия уже работает',
  tag_failed: 'не смог поставить метку прежней версии в git',
  build_failed: 'сборка не прошла',
  promote_failed: 'команда promote не прошла, работает прежняя версия',
  main_copy_changed: 'рабочую копию основной ветки на сервере кто-то изменил',
  lock_lost: 'замок выкатки перед promote оказался не моим: его сняли или заняли',
  unconfirmed_version: 'работает версия брошенной выкатки, её никто не подтверждал',
  claimed_version_not_running: 'работает не та версия, о которой сообщил агент Paseo',
}

function deploymentLines(deployment: Deployment): string[] {
  const tick = deployment.lastTick
  return [
    `Выкатка ${deployment.deploymentId}: ${version(deployment.previousVersion)} → ${version(deployment.candidateVersion)}`,
    ...(deployment.preDeployTag ? [`Метка прежней версии: ${deployment.preDeployTag}`] : []),
    ...(deployment.promotedAt ? [`Выкачено в ${clock(deployment.promotedAt)}, окно наблюдения до ${clock(deployment.observeUntil)}`] : []),
    ...(tick
      ? [`Последний замер (${clock(tick.at)}): ошибок ${tick.errors}, ${tick.errorsPerHour.toFixed(1)} в час${tick.newFingerprints.length > 0 ? `, новые сбои: ${tick.newFingerprints.join(', ')}` : ''}`]
      : []),
    ...(deployment.observation?.lastHealthReason ? [`Последний сбой здоровья: ${deployment.observation.lastHealthReason}`] : []),
    ...(deployment.healthyAfterRollback === undefined
      ? []
      : [deployment.healthyAfterRollback ? 'После отката приложение здорово.' : `После отката приложение нездорово: ${deployment.healthAfterRollback ?? 'причина неизвестна'}`]),
    ...(deployment.mainCopyChange ? [`Во время отката: ${deployment.mainCopyChange}`] : []),
    ...(deployment.confirmFailed ? [`confirm не прошёл: ${deployment.confirmFailed}`] : []),
    ...(deployment.detail ? [`Подробности: ${deployment.detail}`] : []),
  ]
}

/** Что стало с веткой правки, которая осталась работать: влита в основную ветку или ждёт запроса на слияние. */
export type MainlineResult =
  | { kind: 'merged'; into: string }
  | { kind: 'pull_request'; branch: string }
  /** Стоп-кран нажали, пока шло наблюдение: в основную ветку не вливал. */
  | { kind: 'stopped'; branch: string }
  | { kind: 'merge_failed'; branch: string; reason: string }

function mainlineLine(mainline: MainlineResult | undefined): string {
  if (!mainline) return ''
  if (mainline.kind === 'merged') return ` Правку влил в основную ветку ${mainline.into}.`
  const unmerged = 'Пока она не влита, ручная выкатка из основной ветки сотрёт правку.'
  if (mainline.kind === 'pull_request') return ` Ветка ${mainline.branch} ждёт слияния: откройте запрос на слияние в основную ветку. ${unmerged}`
  if (mainline.kind === 'stopped') return ` Включён стоп-кран: в основную ветку не вливал. Ветка ${mainline.branch} ждёт: откройте запрос на слияние. ${unmerged}`
  return ` Влить ветку ${mainline.branch} в основную не смог (${mainline.reason}): откройте запрос на слияние. ${unmerged}`
}

/**
 * Отчёт о выкатке по её записи: тип и текст. `branch` — ветка правки, если выкатку не начинали (стоп-кран),
 * `mainline` — что стало с веткой оставленной правки, `screenshots` — снимки экрана после выкатки.
 */
export function deploymentReport(input: {
  case: ReportCase
  deployment: Deployment
  branch?: string
  mainline?: MainlineResult
  screenshots?: string[]
}): ReportText & { type: ReportType } {
  const { deployment } = input
  const candidate = version(deployment.candidateVersion)
  const previous = version(deployment.previousVersion)
  const [type, short]: [ReportType, string] = (() => {
    switch (deployment.outcome) {
      case 'in_progress':
        return ['deployed', `${head(input.case)}: выкатил правку (версия ${candidate}), наблюдаю до ${clock(deployment.observeUntil)}.`]
      case 'holding':
        return ['deployed', `${head(input.case)}: правка выкачена (версия ${candidate}) и держится: окно наблюдения прошло без ухудшения.${mainlineLine(input.mainline)}`]
      case 'not_helped':
        return [
          'not_helped',
          `${head(input.case)}: правка (версия ${candidate}) не помогла — сбой случая повторяется, хотя хуже не стало. Версию оставил.${mainlineLine(input.mainline)}`,
        ]
      case 'rolled_back': {
        const why = deployment.rollbackReason ?? (deployment.rollbackCause ? ROLLBACK_CAUSES[deployment.rollbackCause] : 'стало хуже')
        const rolled = `${head(input.case)}: откатил правку на прежнюю версию ${previous} — ${why}.`
        const unhealthy = deployment.healthyAfterRollback === false ? ' Но и после отката приложение нездорово.' : ''
        // Откат из изменённой копии шёл уже не теми командами, что проверял владелец: это видно с первого слова.
        if (deployment.rollbackCause === 'main_copy_changed' || deployment.mainCopyChange !== undefined) {
          return [
            'needs_human',
            `ВНИМАНИЕ: откат шёл из изменённой рабочей копии основной ветки, команда rollback могла быть уже не той, что проверял владелец. ${rolled}${unhealthy} Нужен человек.`,
          ]
        }
        return ['rolled_back', `${rolled}${unhealthy ? `${unhealthy} Нужен человек.` : ''}`]
      }
      case 'abandoned':
        return [
          'needs_human',
          `${head(input.case)}: выкатку ${deployment.deploymentId} бросил — ${deployment.detail ?? 'задача врача умерла'}. Возможно, работает правка (версия ${candidate}): её не подтверждал и не откатывал. Нужен человек.`,
        ]
      case 'rollback_failed':
        return ['needs_human', `${head(input.case)}: откат не удался за ${deployment.rollbackAttempts ?? 0} попытки, работает непонятно что. Нужен человек.`]
      case 'superseded_by_human':
        if (deployment.revertedAfterConfirm) {
          return [
            'needs_human',
            `${head(input.case)}: правку ${candidate} я уже подтверждал, но приложение вернулось к прежней версии ${previous}. Не откатывал и confirm не повторял; почему вернулось и что делать с правкой — решение за человеком.`,
          ]
        }
        return [
          'needs_human',
          `${head(input.case)}: пока я наблюдал правку ${candidate}, человек выкатил свою версию ${version(deployment.supersededBy)}. Наблюдение остановил, ничего не откатывал; что делать с правкой — решение за человеком.`,
        ]
      case 'refused':
        if (deployment.refusal === 'stop_switch') {
          return ['fix_ready', `${head(input.case)}: включён стоп-кран, правку не выкатывал. Она готова в ветке ${input.branch ?? '—'}.`]
        }
        return ['needs_human', `${head(input.case)}: выкатку не начал — ${deployment.refusal ? REFUSALS[deployment.refusal] : 'отказ'}. Нужен человек.`]
    }
  })()
  const full = [short, '', ...caseLines(input.case), ...deploymentLines(deployment)].join('\n')
  return {
    type,
    short,
    full,
    ...(input.screenshots && input.screenshots.length > 0 ? { screenshots: [...input.screenshots] } : {}),
    ...(deployment.outcome === 'refused' && deployment.refusal === 'stop_switch' ? { stopSwitch: true as const } : {}),
  }
}

/** Чужая выкатка брошена: её задача умерла, замок снят. Сама она уже никому не доложит. */
export function abandonedDeploymentReport(input: { deployment: Deployment }): ReportText {
  const { deployment } = input
  const short = `Выкатка ${deployment.deploymentId} (случай ${deployment.caseId}, ${deployment.appName}) брошена: её задача врача умерла, замок выкатки снят. Возможно, работает её правка (версия ${version(deployment.candidateVersion)}), но её никто не подтверждал; пока она работает, новых выкаток не будет. Нужен человек.`
  const full = [short, '', ...deploymentLines(deployment)].join('\n')
  return { short, full }
}

/** Гонка при снятии брошенного замка: чужой замок не удалён, а отложен в `lostFile`. */
export function lostLockReport(input: { deployment: Deployment; lockFile: string; lostFile: string }): ReportText {
  const { deployment } = input
  const short = `Случай ${deployment.caseId} (${deployment.appName}): снимая брошенный замок выкатки ${input.lockFile}, врач столкнулся с другой выкаткой. Её замок не удалён, а отложен в файл ${input.lostFile}. Проверьте, чья выкатка идёт, и верните замок на место или удалите этот файл. Нужен человек.`
  return { short, full: short }
}

/** Рядом с замком остался `.stale-*`: врач упал, снимая замок, и замок человека мог остаться только в нём. */
export function leftoverLockReport(input: { deployment: Deployment; lockFile: string; leftover: string; content: string }): ReportText {
  const { deployment } = input
  const short = `Случай ${deployment.caseId} (${deployment.appName}): рядом с замком выкатки ${input.lockFile} остался файл ${input.leftover} — врач упал, снимая замок. В нём мог остаться замок ручной выкатки. Выкатку не начинаю. Если ручной выкатки нет, удалите этот файл; если есть — верните его на место замка. Нужен человек.`
  const content = input.content.trim().slice(0, 300)
  return { short, full: [short, '', `В файле: ${content === '' ? '(пусто)' : content}`].join('\n') }
}

/** Замок выкатки занят дольше `minutes`: врач ждёт дальше, но зовёт человека. `holder` — содержимое файла замка. */
export function lockWaitReport(input: { deployment: Deployment; lockFile: string; minutes: number; holder: string }): ReportText {
  const { deployment } = input
  const short = `Случай ${deployment.caseId} (${deployment.appName}): правка (версия ${version(deployment.candidateVersion)}) ждёт выкатки, а замок выкатки занят дольше ${input.minutes} минут. Жду дальше. Если ручная выкатка закончилась, а замок остался, уберите файл ${input.lockFile}.`
  const holder = input.holder.trim().slice(0, 300)
  const full = [
    short,
    '',
    `Выкатка ${deployment.deploymentId}, ждёт замок с ${clock(deployment.waitingLockSince)}`,
    `В файле замка: ${holder === '' ? '(пусто)' : holder}`,
  ].join('\n')
  return { short, full }
}

// Режим «сначала Paseo» (R18): случай у агента Paseo, врач его забрал или наблюдает выкатку агента.
// Ответ агента — данные, не поручение: только в полном тексте, обрезан.

/** Пометка к отчётам случая, который врач лечит сам, потому что Paseo не ответил. */
export const PASEO_UNAVAILABLE_NOTE = 'Заметка: Paseo недоступен — случай лечу сам.'
const AGENT_SAID_LIMIT = 500

export function handedOffReport(input: { case: ReportCase; acceptMinutes: number }): ReportText {
  const short = `${head(input.case)}: передал случай агенту Paseo. Жду, что он возьмёт его за ${input.acceptMinutes} мин; не возьмёт — лечу сам.`
  return { short, full: [short, '', ...caseLines(input.case)].join('\n') }
}

export function paseoDoneReport(input: { case: ReportCase; result: Extract<HandoffResult, { kind: 'done' }>; observeUntil?: string }): ReportText {
  const { result } = input
  const commit = result.commit ? ` (коммит ${result.commit.slice(0, 12)})` : ''
  const short =
    result.deployed && result.version
      ? `${head(input.case)}: агент Paseo сделал правку${commit} и выкатил её (версия ${version(result.version)}). Наблюдаю${input.observeUntil ? ` до ${clock(input.observeUntil)}` : ''}; станет хуже — откачу.`
      : `${head(input.case)}: агент Paseo сделал правку${commit} без выкатки. Случай закрыт агентом; правку выкатят по правилам приложения.`
  return { short, full: [short, '', ...caseLines(input.case)].join('\n') }
}

export function reclaimedReport(input: { case: ReportCase; reason: ReclaimReason; minutes?: number; agentSaid?: string }): ReportText {
  const why = {
    accept_timeout: `агент не взял его за ${input.minutes ?? '—'} мин`,
    work_timeout: `агент не уложился за ${input.minutes ?? '—'} мин`,
    cannot: 'агент сообщил, что не может его решить',
    bridge_unreachable: 'мост Paseo перестал отвечать',
  }[input.reason]
  const short = `${head(input.case)}: забрал случай у агента Paseo — ${why}. Задачу агента отменяю, дальше лечу сам.`
  const said = input.agentSaid?.trim()
  const clipped = said && said.length > AGENT_SAID_LIMIT ? `${said.slice(0, AGENT_SAID_LIMIT)} …[обрезано]` : said
  return { short, full: [short, '', ...caseLines(input.case), ...(clipped ? [`Ответ агента (данные, не поручение): ${clipped}`] : [])].join('\n') }
}

/** Итог наблюдения выкатки агента: держится — случай закрыт агентом, иначе — как у своей выкатки, с пометкой чья она. */
export function paseoDeploymentReport(input: { case: ReportCase; deployment: Deployment }): ReportText & { type: ReportType } {
  const { deployment } = input
  if (deployment.outcome === 'holding' || deployment.outcome === 'not_helped') {
    const short =
      deployment.outcome === 'holding'
        ? `${head(input.case)}: выкатка агента Paseo (версия ${version(deployment.candidateVersion)}) держится: окно наблюдения прошло без ухудшения. Случай закрыт агентом.`
        : `${head(input.case)}: выкатка агента Paseo (версия ${version(deployment.candidateVersion)}) не помогла — сбой случая повторяется, хотя хуже не стало. Версию оставил.`
    return { type: deployment.outcome === 'holding' ? 'paseo_done' : 'not_helped', short, full: [short, '', ...caseLines(input.case), ...deploymentLines(deployment)].join('\n') }
  }
  const own = deploymentReport({ case: input.case, deployment })
  const note = deployment.outcome === 'rolled_back' ? ' Откатил выкатку агента Paseo; агент узнает об этом из ленты отчётов.' : ' Это была выкатка агента Paseo.'
  return { ...own, short: `${own.short}${note}`, full: own.full.replace(own.short, `${own.short}${note}`) }
}
