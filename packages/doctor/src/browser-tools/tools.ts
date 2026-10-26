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
import { addCaseScreenshotIn, caseBrowserIn, type CaseBrowser } from './case-browser.js'
import type { BrowserAnswer, BrowserClient } from './client.js'

// Инструменты `browser_*` модели-врача: команды службы браузера (contracts/browser-api.md) от профиля из настройки.
// Набор постоянный: инструменты есть всегда, а без браузера (нет в настройке, выключен, служба не отвечает) отвечают
// `unavailable` — модель лечит без него, кэш модели не сбрасывается. Снимки экрана копятся у случая и уходят
// в ближайший отчёт. Проверка для человека (капча, код) — отчёт `needs_human`, есть живой экран — со ссылкой на него.
// Команда не ждёт: ждёт отдельный `browser_wait_human`, повторяемый после перезапуска врача. Срок — от записанного
// начала проверки, поэтому перезапуск его не продлевает. Модель видит только известные поля ответа службы:
// кадры живого экрана и всё лишнее отбрасываются.

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
  'browser_wait_human',
] as const

/** Сколько врач ждёт, пока человек пройдёт проверку на живом экране: от начала проверки, а не от каждого вызова. */
export const BROWSER_HUMAN_WAIT_MS = 30 * 60_000
const STATUS_POLL_MS = 5_000
const WAIT_TOOL = 'browser_wait_human'

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
  sleep?(ms: number, signal?: AbortSignal): Promise<void>
  pollMs?: number
}

export interface BrowserCommandScope {
  caseId: number
  reportCase: ReportCase
  records: Pick<RecordStore, 'transaction'>
  now(): number
  /** Врач закрывается: ожидание обрывается, а после перезапуска инструмент повторяется. */
  signal?: AbortSignal
}

export type BrowserToolAnswer = { text: string; isError: boolean }

/** Адрес живого экрана профиля врача; нет — живой экран выключен или его адрес не задан. */
export function liveLinkOf(browser: BrowserSection, env: Readonly<Record<string, string | undefined>>): string | undefined {
  if (!browser.live?.enabled) return undefined
  const base = env[browser.live.linkEnv]?.trim()
  return base ? `${base.replace(/\/+$/, '')}/live?profile=${encodeURIComponent(browser.profile)}` : undefined
}

/** Входы — только номер, сайт, логин и профиль: что бы служба ни прислала, пароль сюда не попадёт. */
function loginsOf(logins: unknown): unknown[] {
  if (!Array.isArray(logins)) return []
  return logins.map((entry) => {
    const { id, site, login, profile } = (entry ?? {}) as Record<string, unknown>
    return { id, site, login, profile }
  })
}

/** Текст для модели — только из известных полей ответа: кадры и прочее лишнее от службы дальше не идут. */
function describeAnswer(answer: BrowserAnswer): BrowserToolAnswer {
  if (!answer.ok) return { isError: true, text: `${answer.code}: ${answer.message}` }
  const { url, title, snapshot, path, logins, state, reason } = answer
  const lines = [
    ...(typeof url === 'string' ? [`Адрес: ${url}`] : []),
    ...(typeof title === 'string' ? [`Заголовок: ${title}`] : []),
    ...(typeof path === 'string' ? [`Снимок экрана: ${path} (попадёт в отчёт)`] : []),
    ...(logins !== undefined ? [`Входы: ${JSON.stringify(loginsOf(logins))}`] : []),
    ...(typeof state === 'string' ? [`Состояние: ${state}`] : []),
    ...(typeof reason === 'string' ? [`Причина: ${reason}`] : []),
    ...(typeof snapshot === 'string' ? ['', snapshot] : []),
  ]
  return { isError: false, text: lines.length > 0 ? lines.join('\n') : 'Готово.' }
}

const UNAVAILABLE: BrowserAnswer = { ok: false, code: 'unavailable', message: 'браузер недоступен — работай без него' }
const error = (text: string): BrowserToolAnswer => ({ isError: true, text })

/** Одна команда браузера от имени случая. Профиль — только из настройки. */
export async function runBrowserCommand(
  deps: BrowserToolsDeps,
  request: { command: string; input: Record<string, unknown> },
  scope: BrowserCommandScope,
): Promise<BrowserToolAnswer> {
  const browser = (await deps.loadConfig()).browser
  const client = deps.client
  if (!browser?.enabled || !client) return describeAnswer(UNAVAILABLE)
  const liveLink = liveLinkOf(browser, deps.env ?? {})
  if (liveLink && (await openHumanWait(scope))) {
    return error(`Браузер ждёт человека: проверку проходит владелец. Вызови ${WAIT_TOOL} — он дождётся, пока владелец вернёт управление.`)
  }
  const { profile: _ignored, ...input } = request.input
  const startedAt = scope.now()
  const answer = await client.call(request.command, { ...input, profile: browser.profile }, scope.signal)
  if (!answer.ok && (answer.code === 'needs_human' || answer.code === 'refused_human_control')) {
    await startHumanWait(deps, answer, liveLink, scope)
    const next = liveLink
      ? `Вызови ${WAIT_TOOL}: он дождётся, пока владелец вернёт управление (до ${BROWSER_HUMAN_WAIT_MS / 60_000} мин от начала проверки).`
      : 'Владельцу сообщено, живого экрана нет: продолжай без браузера.'
    return error(`${answer.code}: ${answer.message}. ${next}`)
  }
  // Успех снимает только проверку, начатую раньше этой команды: капча, открытая по ходу её выполнения, ещё не пройдена.
  if (answer.ok) await clearHumanWait(scope, startedAt)
  if (answer.ok && typeof answer.path === 'string') {
    const path = answer.path
    await scope.records.transaction((records) => addCaseScreenshotIn(records, scope.caseId, path))
  }
  return describeAnswer(answer)
}

/**
 * `browser_wait_human`: ждать, пока браузер снова готов (владелец нажал «Вернуть»), и показать модели страницу, где он
 * её оставил. Срок — от записанного начала проверки. Сначала опрос, потом сон: повтор после перезапуска сразу видит,
 * что управление уже вернули или срок вышел. Закрытие врача обрывает сон; инструмент повторяется после перезапуска.
 */
export async function runHumanWait(deps: BrowserToolsDeps, scope: BrowserCommandScope): Promise<BrowserToolAnswer> {
  const browser = (await deps.loadConfig()).browser
  const client = deps.client
  if (!browser?.enabled || !client) return describeAnswer(UNAVAILABLE)
  // Вышедший срок здесь не снимается заранее: цикл ниже сначала спросит службу, а потом скажет «не вернул управление».
  const waiting = await openHumanWait(scope, { keepExpired: true })
  if (!waiting) return describeAnswer(await client.call('read', { profile: browser.profile }, scope.signal))
  if (!liveLinkOf(browser, deps.env ?? {})) return error('Живого экрана нет, ждать нечего: продолжай без браузера.')
  const sleep = deps.sleep ?? sleepUnlessAborted
  const deadline = waiting.since + BROWSER_HUMAN_WAIT_MS
  for (;;) {
    const status = await client.call('status', { profile: browser.profile }, scope.signal)
    if (!status.ok) return describeAnswer(status)
    if (status.state === 'ready') {
      await clearHumanWait(scope)
      const page = describeAnswer(await client.call('read', { profile: browser.profile }, scope.signal))
      return { ...page, text: `Владелец вернул управление. Страница сейчас:\n${page.text}` }
    }
    const left = deadline - scope.now()
    if (left <= 0) {
      await clearHumanWait(scope)
      return error(`Человек не вернул управление за ${BROWSER_HUMAN_WAIT_MS / 60_000} мин: продолжай без браузера.`)
    }
    scope.signal?.throwIfAborted()
    await sleep(Math.min(deps.pollMs ?? STATUS_POLL_MS, left), scope.signal)
  }
}

function sleepUnlessAborted(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason)
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort)
      resolve()
    }, ms)
    const abort = () => {
      clearTimeout(timer)
      reject(signal?.reason)
    }
    signal?.addEventListener('abort', abort, { once: true })
  })
}

/** Открытое ожидание человека; вышедшее за срок снимается: следующая проверка — новый отчёт. */
async function openHumanWait(scope: BrowserCommandScope, options: { keepExpired?: boolean } = {}): Promise<CaseBrowser['humanWait']> {
  return scope.records.transaction(async (records) => {
    const state = await caseBrowserIn(records, scope.caseId)
    if (!options.keepExpired && state.humanWait && scope.now() - state.humanWait.since >= BROWSER_HUMAN_WAIT_MS) delete state.humanWait
    return state.humanWait ? { ...state.humanWait } : undefined
  })
}

/** `before` — снять, только если проверка началась раньше этого момента. */
async function clearHumanWait(scope: BrowserCommandScope, before?: number): Promise<void> {
  await scope.records.transaction(async (records) => {
    const state = await caseBrowserIn(records, scope.caseId)
    if (state.humanWait && (before === undefined || state.humanWait.since < before)) delete state.humanWait
  })
}

/**
 * Проверка для человека началась: метка с моментом начала (от него считается срок) и для `needs_human` — отчёт
 * владельцу, один на проверку. Управление владелец взял сам (`refused_human_control`) — без отчёта.
 */
async function startHumanWait(
  deps: BrowserToolsDeps,
  refusal: Extract<BrowserAnswer, { ok: false }>,
  liveLink: string | undefined,
  scope: BrowserCommandScope,
): Promise<void> {
  const reports = refusal.code === 'needs_human' ? deps.reports : undefined
  const text = browserNeedsHumanReport({ case: scope.reportCase, reason: refusal.message, ...(liveLink ? { liveLink } : {}), waitMinutes: BROWSER_HUMAN_WAIT_MS / 60_000 })
  const reported = await scope.records.transaction(async (records: RecordTransaction) => {
    const state = await caseBrowserIn(records, scope.caseId)
    if (state.humanWait && scope.now() - state.humanWait.since < BROWSER_HUMAN_WAIT_MS) return false
    state.humanWait = { since: scope.now() }
    if (!reports) return false
    const report = await reports.addIn(records, {
      type: 'needs_human',
      caseId: scope.caseId,
      short: redactSecrets(text.short),
      full: redactSecrets(text.full),
      telegram: 'pending',
    })
    const sick = await records.doc<Case>('case', String(scope.caseId), {} as Case)
    if (sick.caseId === scope.caseId && !sick.reportIds.includes(report.reportId)) sick.reportIds.push(report.reportId)
    state.humanWait.reportId = report.reportId
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
  {
    name: WAIT_TOOL,
    command: undefined,
    description:
      'Ждать, пока владелец пройдёт проверку на живом экране и вернёт управление; потом снимок страницы. Звать после ответа needs_human или refused_human_control.',
    parameters: Type.Object({}),
    replay: 'safe',
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
        const scope: BrowserCommandScope = {
          caseId,
          reportCase: { caseId, appName, kind, where, message },
          records: { transaction: (change) => api.commit((tx) => change(recordTransactionOver(tx)), context) },
          now: () => api.now(),
          ...(context.abortSignal ? { signal: context.abortSignal } : {}),
        }
        const answer =
          spec.command === undefined
            ? await runHumanWait(deps, scope)
            : await runBrowserCommand(deps, { command: spec.command, input: { ...(args as Record<string, unknown>) } }, scope)
        return { output: [{ type: 'text', text: answer.text }], ...(answer.isError ? { isError: true } : {}) }
      },
    }),
  )
}
