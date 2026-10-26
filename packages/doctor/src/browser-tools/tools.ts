import { Type } from '@earendil-works/pi-ai'
import { defineTool } from '@earendil-works/pi-durable'
import type { RemontnikConfig } from '@ykurilov/remontnik-core/config'
import { redactSecrets } from '@ykurilov/remontnik-core/redact'
import type { Case } from '../case-book/index.js'
import type { RecordStore, RecordTransaction } from '../records/index.js'
import type { Reports } from '../reports/index.js'
import { browserNeedsHumanReport, type ReportCase } from '../reports/texts.js'
import { recordTransactionOver } from '../service/harness.js'
import { TreatmentDoc } from '../treatment/doc.js'
import { addCaseScreenshotIn, caseBrowserIn } from './case-browser.js'
import type { BrowserAnswer, BrowserClient } from './client.js'

// Инструменты `browser_*` модели-врача: команды службы браузера (contracts/browser-api.md) от профиля из настройки.
// Набор постоянный: инструменты есть всегда, а без браузера (нет в настройке, выключен, служба не отвечает) отвечают
// `unavailable` — модель лечит без него, кэш модели не сбрасывается. Снимки экрана копятся у случая и уходят
// в ближайший отчёт. Проверка для человека (капча, код) — отчёт `needs_human`; есть живой экран — ссылка на него,
// врач ждёт, пока владелец не нажмёт «Вернуть», и продолжает с той же страницы. Кадры живого экрана сюда не идут.

export const BROWSER_TOOL_NAMES = [
  'browser_url',
  'browser_back',
  'browser_read',
  'browser_click',
  'browser_type',
  'browser_key',
  'browser_scroll',
  'browser_shot',
  'browser_logins',
  'browser_fill_password',
] as const

/** Сколько врач ждёт, пока человек пройдёт проверку на живом экране. */
export const BROWSER_HUMAN_WAIT_MS = 30 * 60_000
const STATUS_POLL_MS = 5_000

type BrowserSection = NonNullable<RemontnikConfig['browser']>

export interface BrowserToolsDeps {
  /** Нет — браузера у врача нет: инструменты отвечают `unavailable`. */
  client?: BrowserClient
  loadConfig(): Promise<RemontnikConfig>
  /** Окружение врача: адрес живого экрана по `browser.live.linkEnv`. */
  env?: Readonly<Record<string, string | undefined>>
  reports?: Pick<Reports, 'addIn'>
  /** Записан отчёт: пора отправлять. */
  onReport?(): void
  sleep?(ms: number): Promise<void>
  pollMs?: number
}

export interface BrowserCommandScope {
  caseId: number
  reportCase: ReportCase
  records: Pick<RecordStore, 'transaction'>
  now(): number
}

export type BrowserToolAnswer = { text: string; isError: boolean }

/** Адрес живого экрана профиля врача; нет — живой экран выключен или его адрес не задан. */
export function liveLinkOf(browser: BrowserSection, env: Readonly<Record<string, string | undefined>>): string | undefined {
  if (!browser.live?.enabled) return undefined
  const base = env[browser.live.linkEnv]?.trim()
  return base ? `${base.replace(/\/+$/, '')}/live?profile=${encodeURIComponent(browser.profile)}` : undefined
}

function describeAnswer(answer: BrowserAnswer): BrowserToolAnswer {
  if (!answer.ok) return { isError: true, text: `${answer.code}: ${answer.message}` }
  const { ok: _ok, url, title, snapshot, path, logins, state, ...rest } = answer
  const lines = [
    ...(typeof url === 'string' ? [`Адрес: ${url}`] : []),
    ...(typeof title === 'string' ? [`Заголовок: ${title}`] : []),
    ...(typeof path === 'string' ? [`Снимок экрана: ${path} (попадёт в отчёт)`] : []),
    ...(logins !== undefined ? [`Входы: ${JSON.stringify(logins)}`] : []),
    ...(typeof state === 'string' ? [`Состояние: ${state}`] : []),
    ...(Object.keys(rest).length > 0 ? [JSON.stringify(rest)] : []),
    ...(typeof snapshot === 'string' ? ['', snapshot] : []),
  ]
  return { isError: false, text: lines.length > 0 ? lines.join('\n') : 'Готово.' }
}

const UNAVAILABLE: BrowserAnswer = { ok: false, code: 'unavailable', message: 'браузер недоступен — работай без него' }

/** Одна команда браузера от имени случая. Профиль — только из настройки. */
export async function runBrowserCommand(
  deps: BrowserToolsDeps,
  request: { command: string; input: Record<string, unknown> },
  scope: BrowserCommandScope,
): Promise<BrowserToolAnswer> {
  const browser = (await deps.loadConfig()).browser
  const client = deps.client
  if (!browser?.enabled || !client) return describeAnswer(UNAVAILABLE)
  const { profile: _ignored, ...input } = request.input
  let answer = await client.call(request.command, { ...input, profile: browser.profile })
  let prefix = ''
  if (!answer.ok && (answer.code === 'needs_human' || answer.code === 'refused_human_control')) {
    const waited = await waitForHuman(deps, client, browser, answer, scope)
    answer = waited.answer
    prefix = waited.prefix
  } else if (answer.ok) {
    await clearHumanWait(scope)
  }
  if (answer.ok && typeof answer.path === 'string') {
    const path = answer.path
    await scope.records.transaction((records) => addCaseScreenshotIn(records, scope.caseId, path))
  }
  const described = describeAnswer(answer)
  return prefix ? { ...described, text: `${prefix}\n${described.text}` } : described
}

async function clearHumanWait(scope: BrowserCommandScope): Promise<void> {
  await scope.records.transaction(async (records) => {
    const state = await caseBrowserIn(records, scope.caseId)
    if (state.humanWait) delete state.humanWait
  })
}

/**
 * Проверка для человека. `needs_human` — отчёт владельцу (один на проверку). Есть живой экран — ждать, пока браузер
 * снова готов (владелец вернул управление), и показать модели страницу, где он её оставил. Управление владелец взял
 * сам (`refused_human_control`) — просто ждать. Не дождались — модель продолжает без браузера.
 */
async function waitForHuman(
  deps: BrowserToolsDeps,
  client: BrowserClient,
  browser: BrowserSection,
  refusal: Extract<BrowserAnswer, { ok: false }>,
  scope: BrowserCommandScope,
): Promise<{ answer: BrowserAnswer; prefix: string }> {
  const liveLink = liveLinkOf(browser, deps.env ?? {})
  if (refusal.code === 'needs_human') await reportHumanCheck(deps, refusal.message, liveLink, scope)
  const withoutBrowser = (why: string): { answer: BrowserAnswer; prefix: string } => ({
    answer: { ok: false, code: refusal.code, message: `${refusal.message}. ${why}: продолжай без браузера.` },
    prefix: '',
  })
  if (!liveLink) return withoutBrowser('Владельцу сообщено, живого экрана нет')

  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const deadline = scope.now() + BROWSER_HUMAN_WAIT_MS
  while (scope.now() < deadline) {
    await sleep(deps.pollMs ?? STATUS_POLL_MS)
    const status = await client.call('status', { profile: browser.profile })
    if (!status.ok) return { answer: status, prefix: '' }
    if (status.state !== 'ready') continue
    await clearHumanWait(scope)
    return { answer: await client.call('read', { profile: browser.profile }), prefix: 'Владелец вернул управление. Страница сейчас:' }
  }
  return withoutBrowser(`Человек не вернул управление за ${BROWSER_HUMAN_WAIT_MS / 60_000} мин`)
}

async function reportHumanCheck(deps: BrowserToolsDeps, reason: string, liveLink: string | undefined, scope: BrowserCommandScope): Promise<void> {
  const reports = deps.reports
  if (!reports) return
  const text = browserNeedsHumanReport({ case: scope.reportCase, reason, ...(liveLink ? { liveLink } : {}), waitMinutes: BROWSER_HUMAN_WAIT_MS / 60_000 })
  const reported = await scope.records.transaction(async (records: RecordTransaction) => {
    const state = await caseBrowserIn(records, scope.caseId)
    if (state.humanWait) return false
    const report = await reports.addIn(records, {
      type: 'needs_human',
      caseId: scope.caseId,
      short: redactSecrets(text.short),
      full: redactSecrets(text.full),
      telegram: 'pending',
    })
    const sick = await records.doc<Case>('case', String(scope.caseId), {} as Case)
    if (sick.caseId === scope.caseId && !sick.reportIds.includes(report.reportId)) sick.reportIds.push(report.reportId)
    state.humanWait = { reportId: report.reportId, since: scope.now() }
    return true
  })
  if (reported) deps.onReport?.()
}

const DANGER = Type.Union(['none', 'submit', 'send', 'pay', 'delete', 'publish'].map((kind) => Type.Literal(kind)), {
  description: 'Что сделает действие: none — ничего не меняет, submit — отправит форму. send, pay, delete, publish браузер отклоняет всегда.',
})

const BROWSER_TOOL_SPECS = [
  {
    name: 'browser_url',
    command: 'url',
    description: 'Открыть адрес приложения в браузере врача и получить снимок страницы с номерами элементов (e12). Только сайты из настройки.',
    parameters: Type.Object({ url: Type.String({ description: 'Полный адрес страницы' }) }),
    replay: 'safe',
  },
  { name: 'browser_back', command: 'back', description: 'Назад по истории браузера; снимок страницы.', parameters: Type.Object({}), replay: 'unsafe' },
  {
    name: 'browser_read',
    command: 'read',
    description: 'Снимок текущей страницы с номерами элементов. Значения полей пароля скрыты.',
    parameters: Type.Object({}),
    replay: 'safe',
  },
  {
    name: 'browser_click',
    command: 'click',
    description: 'Нажать на элемент по номеру из снимка. Укажи danger честно; оплату, удаление, публикацию и отправку людям браузер не выполнит.',
    parameters: Type.Object({ ref: Type.String({ description: 'Номер элемента из снимка, например e12' }), danger: DANGER }),
    replay: 'unsafe',
  },
  {
    name: 'browser_type',
    command: 'type',
    description: 'Впечатать текст в поле по номеру из снимка; submit — нажать Enter после ввода. Пароли так не вводятся: для них browser_fill_password.',
    parameters: Type.Object({
      ref: Type.String({ description: 'Номер поля из снимка' }),
      text: Type.String(),
      submit: Type.Optional(Type.Boolean()),
      danger: DANGER,
    }),
    replay: 'unsafe',
  },
  {
    name: 'browser_key',
    command: 'key',
    description: 'Нажать клавишу на странице, например Enter, Escape или Shift+Tab.',
    parameters: Type.Object({ key: Type.String() }),
    replay: 'unsafe',
  },
  {
    name: 'browser_scroll',
    command: 'scroll',
    description: 'Прокрутить страницу; снимок после прокрутки.',
    parameters: Type.Object({
      direction: Type.Union([Type.Literal('up'), Type.Literal('down'), Type.Literal('left'), Type.Literal('right')]),
      px: Type.Optional(Type.Number({ description: 'На сколько пикселей, по умолчанию 600' })),
    }),
    replay: 'safe',
  },
  {
    name: 'browser_shot',
    command: 'shot',
    description: 'Снимок экрана текущей страницы (поля пароля под маской). Снимки прикладываются к отчёту владельцу.',
    parameters: Type.Object({}),
    replay: 'safe',
  },
  {
    name: 'browser_logins',
    command: 'logins',
    description: 'Сохранённые входы браузера: номер, сайт, логин. Паролей в ответе нет.',
    parameters: Type.Object({ site: Type.Optional(Type.String({ description: 'Origin сайта' })) }),
    replay: 'safe',
  },
  {
    name: 'browser_fill_password',
    command: 'fill-password',
    description: 'Браузер сам впишет пароль сохранённого входа в поле пароля по номеру из снимка. Пароль ты не видишь.',
    parameters: Type.Object({ entryId: Type.Number({ description: 'Номер входа из browser_logins' }), ref: Type.String({ description: 'Номер поля пароля' }) }),
    replay: 'unsafe',
  },
] as const

/** Инструменты браузера врача; без `deps` — все отвечают `unavailable`. */
export function createBrowserTools(deps?: BrowserToolsDeps) {
  return BROWSER_TOOL_SPECS.map((spec) =>
    defineTool({
      name: spec.name,
      description: spec.description,
      parameters: spec.parameters,
      replay: spec.replay,
      execute: async (args, api, context) => {
        const state = await api.snapshot(TreatmentDoc, api.conversationId, context)
        if (!deps || !state?.case) return { output: [{ type: 'text', text: describeAnswer(UNAVAILABLE).text }], isError: true }
        const { caseId, appName, kind, where, message } = state.case
        const answer = await runBrowserCommand(
          deps,
          { command: spec.command, input: { ...(args as Record<string, unknown>) } },
          {
            caseId,
            reportCase: { caseId, appName, kind, where, message },
            records: { transaction: (change) => api.commit((tx) => change(recordTransactionOver(tx)), context) },
            now: () => api.now(),
          },
        )
        return { output: [{ type: 'text', text: answer.text }], ...(answer.isError ? { isError: true } : {}) }
      },
    }),
  )
}
