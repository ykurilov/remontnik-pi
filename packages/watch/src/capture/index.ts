import { join } from 'node:path'
import {
  createIncidentEvent,
  whereFromStack,
  type BadAnswer,
  type IncidentContext,
  type IncidentEvent,
  type IncidentKind,
} from '@ykurilov/remontnik-core/incident'
import type { RemontnikConfig } from '@ykurilov/remontnik-core/config'
import { createModelRoute, type ModelRoute, type ModelRouteOptions } from '@ykurilov/remontnik-core/model-route'
import { signBody } from '@ykurilov/remontnik-core/signed-http'
import { createTelegramClient, type TelegramClient } from '@ykurilov/remontnik-core/telegram'
import { createIncidentNotifier, formatIncidentAlert } from '../notify/index.js'
import { openOutbox, type Outbox, type OutboxEntry, type OutboxStats } from '../outbox/index.js'
import { createStopButtonHandler } from '../stop-button/index.js'
import {
  BAD_ANSWER_LABELS,
  createConversationReviewer,
  type ConversationReviewer,
  type FinishedConversation,
  type ReviewQueueStats,
  type ReviewedFinding,
} from '../review/index.js'

// Сторож внутри приложения. Горячий путь — только синхронная запись в очередь на диске;
// доставка врачу и тревога в Telegram идут позже, в фоне. Ошибки сторожа не роняют приложение:
// они уходят строкой `[remontnik] …` в журнал и в счётчик ownErrors, но случаем не становятся.
// Ни один путь сторожа (вызов, таймер, промис) не выпускает исключение в приложение.

export interface WatchOptions {
  appName: string
  /** Имя процесса: веб, фоновый работник… У каждого свой файл очереди. */
  processName: string
  /** Папка очереди, например `.remontnik/` рядом с приложением. */
  dir: string
  doctor: { url: string; secret: string }
  telegram: {
    botToken: string
    /** Чат владельца: строка или функция приложения (например, из его базы); `null` — пока некому писать. */
    chatId: string | (() => Promise<string | null>)
    apiBaseUrl?: string
    proxyToken?: string
  }
  /** Корень приложения: от него считаются места в следах. По умолчанию — текущая папка. */
  appRoot?: string
  /** Путь к модели для чтения разговоров (DeepSeek, запасной — OpenRouter). */
  model?: ModelRouteOptions
  /** Чтение законченных разговоров. Нужны и `review`, и `model`. */
  review?: {
    /** Что бот должен делать и чего не должен: по этому описанию модель судит ответы. */
    botDescription: string
    /**
     * Пределы из `remontnik.config.ts` (`config.limits`): сторож тратит на модель не больше `watchModelUsdPerDay`
     * в сутки. Это свой потолок сторожа; у врача — свой (`doctorModelUsdPerDay`), общего счётчика нет.
     */
    limits: Pick<RemontnikConfig['limits'], 'watchModelUsdPerDay'>
    /** Отметки с меньшей уверенностью случаями не становятся; по умолчанию 0.7. */
    minConfidence?: number
    /** Пояс для границы суток бюджета; по умолчанию UTC. */
    timeZone?: string
    /** Через сколько после первого отложенного разговора слать сводку «отложено N»; по умолчанию 5 минут. */
    summaryDelayMs?: number
    /**
     * Места нарушений: правила и темы из описания бота. Модель выбирает место из этого набора; в отпечаток случая
     * попадает только оно. Без набора место у всех нарушений «общее».
     */
    places?: readonly string[]
    /** Сколько чтений в час и в сутки допускается на приложение (все процессы вместе); по умолчанию 100 и 1000. */
    maxReviewsPerHour?: number
    maxReviewsPerDay?: number
    /** Уровень рассуждения модели при чтении; по умолчанию `low`. */
    reasoningEffort?: 'low' | 'high' | 'max'
  }
  /** Дополнительная вычистка личных данных приложения, поверх встроенной. */
  redact?: (text: string) => string
  /** Текущая версия приложения для отметки в событии; функция вызывается один раз при старте. */
  release?: string | null | (() => Promise<string | null>)
  /** Потолок очереди на диске и в памяти; дальше повторы склеиваются, новые вытесняют старые. По умолчанию 1000. */
  maxQueue?: number
  fetch?: typeof fetch
  now?: () => number
}

export interface CaptureOptions {
  kind?: IncidentKind
  /** Место сбоя. По умолчанию — первая строка следа внутри кода приложения. */
  where?: string
  context?: IncidentContext
}

export interface WatchStats {
  queue: OutboxStats
  /** Сбои самого сторожа: Telegram, диск, врач ответил не так. */
  ownErrors: number
  /** Сколько разных отпечатков сторож помнит для склейки тревог. */
  fingerprints: number
  /** Чтение разговоров; `null` — не настроено. */
  review: ReviewQueueStats | null
}

/** Каталог моделей Agent Chat SDK в той мере, в какой он нужен сторожу. */
export interface ModelCatalogLike {
  readonly providers: readonly { readonly id: string; createLanguageModel(...args: never[]): unknown }[]
}

export interface Watch {
  /** Записывает сбой и возвращает номер события. Не бросает и не ходит в сеть. */
  capture(error: unknown, options?: CaptureOptions): string
  /** Записывает падения процесса; поведение процесса остаётся таким же, как без сторожа. */
  installProcessHandlers(): void
  /** Тот же каталог моделей, но ошибки обращений к моделям становятся случаями `model_error`. */
  wrapModelCatalog<C extends ModelCatalogLike>(catalog: C): C
  /**
   * Ставит законченный разговор в очередь чтения. Не ждёт сети и не бросает: модель вызывается в фоне,
   * в пределах суточного бюджета. Плохие ответы становятся случаями `bad_answer`.
   */
  conversationFinished(conversation: FinishedConversation): void
  /**
   * Нажатие кнопки «Остановить автовыкатку» (`callback_query` из Bot API) под отчётом врача. Нажатие в чате тревог
   * включает стоп-кран у врача. Возвращает текст для `answerCallbackQuery`; `null` — кнопка не сторожа. Не бросает.
   */
  handleStopButton(callbackQuery: unknown): Promise<string | null>
  /** Немедленно пробует доставить всё ожидающее. `true` — очередь пуста и тревоги отправлены. */
  flush(timeoutMs: number): Promise<boolean>
  stats(): WatchStats
  close(): void
}

const DOCTOR_TIMEOUT_MS = 10_000
const NO_RETHROW = Symbol('no-rethrow')
/** Пауза после неудачного прохода доставки, если очередь не назвала срок позже. */
const FAILED_PASS_PAUSE_MS = 5_000
const EMPTY_QUEUE_STATS: OutboxStats = {
  pending: 0,
  stored: 0,
  awaitingNotification: 0,
  failedAttempts: 0,
  lost: 0,
  oldestPendingAt: null,
  nextAttemptAt: null,
}

/** Отмена запроса (пользователь нажал «Стоп») — не сбой. */
function isCancellation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { name?: unknown }).name === 'AbortError'
}

function errorParts(error: unknown): { message: string; stack: string } {
  if (error instanceof Error) return { message: error.message, stack: error.stack ?? '' }
  if (typeof error === 'string') return { message: error, stack: '' }
  try {
    return { message: JSON.stringify(error) ?? String(error), stack: '' }
  } catch {
    return { message: String(error), stack: '' }
  }
}

/** Режим `--unhandled-rejections`: из флагов запуска или NODE_OPTIONS; по умолчанию `throw`. */
function unhandledRejectionsMode(): string {
  const flags = [...process.execArgv, ...(process.env.NODE_OPTIONS ?? '').split(/\s+/)]
  for (const flag of flags.reverse()) {
    const match = /^--unhandled-rejections=(.+)$/.exec(flag)
    if (match?.[1]) return match[1]
  }
  return 'throw'
}

/** Обязательные поля без значения — понятный TypeError с названием поля, а не отказ где-то внутри. */
function assertWatchOptions(options: WatchOptions): void {
  const required: [string, unknown][] = [
    ['dir', options.dir],
    ['doctor.url', options.doctor?.url],
    ['doctor.secret', options.doctor?.secret],
    ['telegram.botToken', options.telegram?.botToken],
    ['telegram.chatId', options.telegram?.chatId],
  ]
  const missing = required.filter(([, value]) => value === undefined || value === null || value === '').map(([name]) => name)
  if (missing.length > 0) {
    throw new TypeError(`createWatch: не заданы обязательные поля: ${missing.join(', ')} (обычно это пустая переменная окружения)`)
  }
}

export function createWatch(options: WatchOptions): Watch {
  assertWatchOptions(options)
  const now = options.now ?? Date.now
  const fetchImpl = options.fetch ?? ((...args: Parameters<typeof fetch>) => fetch(...args))
  const appRoot = options.appRoot ?? process.cwd()
  const doctorUrl = `${options.doctor.url.replace(/\/+$/, '')}/v1/events`
  const knownSecrets = [options.doctor.secret, options.telegram.botToken, options.telegram.proxyToken ?? ''].filter(Boolean)
  const notifier = createIncidentNotifier()
  const telegram: TelegramClient = createTelegramClient({
    botToken: options.telegram.botToken,
    ...(options.telegram.apiBaseUrl === undefined ? {} : { apiBaseUrl: options.telegram.apiBaseUrl }),
    ...(options.telegram.proxyToken === undefined ? {} : { proxyToken: options.telegram.proxyToken }),
    fetch: fetchImpl,
  })

  let ownErrors = 0
  let closed = false
  let deliveryTimer: ReturnType<typeof setTimeout> | null = null
  let delivering: Promise<void> | null = null
  let doctorFailing = false
  const notifications = new Set<Promise<void>>()
  const notifyingIds = new Set<string>()
  const removeProcessHandlers: (() => void)[] = []

  const ownError = (what: string, error?: unknown) => {
    ownErrors += 1
    const detail = error === undefined ? '' : `: ${errorParts(error).message}`
    try {
      console.error(`[remontnik] ${what}${detail}`)
    } catch {
      // Журнал недоступен — молчим, приложению это не мешает.
    }
  }

  let release: string | null | undefined = typeof options.release === 'function' ? undefined : options.release
  if (typeof options.release === 'function') {
    options.release().then(
      (value) => {
        release = value
      },
      (error: unknown) => ownError('версия приложения не получена', error),
    )
  }

  let outbox: Outbox | null = null
  try {
    outbox = openOutbox({
      dir: options.dir,
      processName: options.processName,
      now,
      ...(options.maxQueue === undefined ? {} : { maxEntries: options.maxQueue }),
    })
  } catch (error) {
    ownError(`очередь в ${options.dir} недоступна, случаи не сохраняются`, error)
  }

  async function resolveChatId(): Promise<string | null> {
    const { chatId } = options.telegram
    return typeof chatId === 'string' ? chatId : chatId()
  }

  const handleStopButton = createStopButtonHandler({
    doctor: options.doctor,
    alertChatId: resolveChatId,
    fetch: fetchImpl,
    now,
    onError: ownError,
  })

  /** Тревога о событии; `eventIds` — все записи очереди, которые она закрывает (склеенные остатки). */
  function sendAlert(
    event: IncidentEvent,
    counter: { count: number; firstSeenAt: number; lastSeenAt: number },
    eventIds: readonly string[] = [event.eventId],
  ): void {
    if (closed || notifyingIds.has(event.eventId)) return
    notifyingIds.add(event.eventId)
    const sending = (async () => {
      try {
        const chatId = await resolveChatId()
        if (chatId === null) return
        await telegram.sendMessage(chatId, formatIncidentAlert(event, counter))
        for (const eventId of eventIds) outbox?.markNotified(eventId)
      } catch (error) {
        ownError('тревога в Telegram не ушла', error)
      } finally {
        notifyingIds.delete(event.eventId)
      }
    })()
    notifications.add(sending)
    void sending.finally(() => notifications.delete(sending))
  }

  /** Событие для врача: склеенные повторы и потери очереди — в контексте. */
  function eventForDoctor(entry: OutboxEntry): IncidentEvent {
    if (entry.repeats === 0 && entry.lostBefore === 0) return entry.event
    return {
      ...entry.event,
      context: {
        ...entry.event.context,
        ...(entry.repeats > 0 ? { repeats: entry.repeats } : {}),
        ...(entry.lostBefore > 0 ? { lostBefore: entry.lostBefore } : {}),
      },
    }
  }

  /** Одна пачка врачу. `true` — врач ответил и принял всё. Не бросает. */
  async function postToDoctor(queue: Outbox, entries: OutboxEntry[]): Promise<boolean> {
    const ids = entries.map((entry) => entry.event.eventId)
    let accepted: Set<string>
    try {
      const body = JSON.stringify({ events: entries.map(eventForDoctor) })
      const response = await fetchImpl(doctorUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...signBody(body, options.doctor.secret, now()) },
        body,
        signal: AbortSignal.timeout(DOCTOR_TIMEOUT_MS),
      })
      if (!response.ok) throw new Error(`врач ответил ${response.status}`)
      const payload = (await response.json()) as { accepted?: unknown }
      accepted = new Set(Array.isArray(payload.accepted) ? payload.accepted.filter((id) => typeof id === 'string') : [])
      doctorFailing = false
    } catch (error) {
      // Одна строка на начало перебоя, а не на каждую попытку.
      if (!doctorFailing) ownError('врач недоступен, случаи ждут в очереди', error)
      doctorFailing = true
      try {
        queue.recordFailure(ids, now())
      } catch (writeError) {
        ownError('неудачная попытка не записана в очередь', writeError)
      }
      return false
    }
    const rest = ids.filter((id) => !accepted.has(id))
    try {
      queue.ack([...accepted])
      if (rest.length > 0) queue.recordFailure(rest, now())
    } catch (writeError) {
      ownError('подтверждение врача не записано в очередь', writeError)
      return false
    }
    return rest.length === 0
  }

  function scheduleDelivery(delayMs = 0): void {
    if (closed || !outbox) return
    try {
      if (deliveryTimer) clearTimeout(deliveryTimer)
      deliveryTimer = setTimeout(() => {
        deliveryTimer = null
        void startDelivery(false)
      }, Math.max(0, delayMs))
      deliveryTimer.unref?.()
    } catch (error) {
      ownError('доставка не запланирована', error)
    }
  }

  /**
   * Проход доставки; одновременно идёт не больше одного. `force` — не ждать сроков повторов (flush).
   * Промис никогда не отклоняется; `delivering` сбрасывается только когда проход и правда закончился.
   */
  function startDelivery(force: boolean): Promise<void> {
    if (delivering) return delivering
    const queue = outbox
    if (!queue || closed) return Promise.resolve()
    const pass = (async () => {
      let failed = false
      try {
        for (let batch = queue.due(force ? Number.POSITIVE_INFINITY : now()); batch.length > 0 && !closed; ) {
          if (!(await postToDoctor(queue, batch))) {
            failed = true
            break
          }
          batch = queue.due(force ? Number.POSITIVE_INFINITY : now())
        }
      } catch (error) {
        failed = true
        ownError('сбой доставки врачу', error)
      }
      try {
        const next = queue.nextAttemptAt()
        if (next !== null && !force) scheduleDelivery(Math.max(next - now(), failed ? FAILED_PASS_PAUSE_MS : 0))
      } catch (error) {
        ownError('доставка не запланирована', error)
        scheduleDelivery(FAILED_PASS_PAUSE_MS)
      }
    })()
    delivering = pass
    void pass.then(() => {
      if (delivering === pass) delivering = null
    })
    return pass
  }

  function pendingCount(): number {
    try {
      return outbox?.stats().pending ?? 0
    } catch (error) {
      ownError('очередь не читается', error)
      return 0
    }
  }

  /** Записывает событие в очередь и откладывает тревогу и доставку. Возвращает номер события; не бросает. */
  function recordIncident(input: {
    kind: IncidentKind
    where: string
    message: string
    stack?: string
    context?: IncidentContext
    badAnswer?: BadAnswer
  }): string {
    try {
      const context: IncidentContext = { processName: options.processName, ...input.context }
      if (release !== undefined) context.release = release
      const event = createIncidentEvent(
        {
          appName: options.appName,
          kind: input.kind,
          where: input.where,
          message: input.message,
          stack: input.stack ?? '',
          context,
          occurredAt: new Date(now()),
          ...(input.badAnswer ? { badAnswer: input.badAnswer } : {}),
        },
        { knownSecrets, ...(options.redact ? { redact: options.redact } : {}) },
      )
      const decision = notifier.observe(event, now())
      try {
        outbox?.append(event, { notify: decision.notify })
      } catch (writeError) {
        ownError('случай не записан в очередь', writeError)
      }
      if (!closed) {
        const deferred = setImmediate(() => {
          try {
            if (decision.notify) sendAlert(event, decision.state)
            scheduleDelivery()
          } catch (deferredError) {
            ownError('тревога или доставка не запущены', deferredError)
          }
        })
        deferred.unref?.()
      }
      return event.eventId
    } catch (captureError) {
      ownError('сбой не записан', captureError)
      return ''
    }
  }

  function capture(error: unknown, captureOptions: CaptureOptions = {}): string {
    try {
      const { message, stack } = errorParts(error)
      return recordIncident({
        kind: captureOptions.kind ?? 'manual',
        where: captureOptions.where ?? whereFromStack(stack, appRoot),
        message,
        stack,
        ...(captureOptions.context ? { context: captureOptions.context } : {}),
      })
    } catch (captureError) {
      ownError('сбой не записан', captureError)
      return ''
    }
  }

  /** Плохой ответ бота, найденный при чтении разговора. Отпечаток — вид нарушения и место в описании бота. */
  function recordBadAnswer({ conversationId, meta, finding }: ReviewedFinding): void {
    const chatId = typeof meta.chatId === 'string' ? meta.chatId : undefined
    recordIncident({
      kind: 'bad_answer',
      where: finding.place,
      message: `${BAD_ANSWER_LABELS[finding.category]}: ${finding.place}`,
      ...(chatId === undefined ? {} : { context: { chatId } }),
      badAnswer: {
        conversationId,
        messageIndex: finding.messageIndex,
        category: finding.category,
        excerpt: finding.excerpt,
        explanation: finding.explanation,
        confidence: finding.confidence,
      },
    })
  }

  /** Сообщение владельцу не про случай, а про работу сторожа (например, «отложено N»). */
  function notifyOwner(text: string): void {
    if (closed) return
    const sending = (async () => {
      try {
        const chatId = await resolveChatId()
        if (chatId !== null) await telegram.sendMessage(chatId, text)
      } catch (error) {
        ownError('сообщение владельцу не ушло', error)
      }
    })()
    notifications.add(sending)
    void sending.finally(() => notifications.delete(sending))
  }

  let reviewer: ConversationReviewer | null = null
  let reviewMisconfigured = false
  if (options.review) {
    if (!options.model) {
      reviewMisconfigured = true
    } else {
      try {
        const route: ModelRoute = createModelRoute({ ...options.model, ...(options.model.fetch ? {} : { fetch: fetchImpl }) })
        reviewer = createConversationReviewer({
          botDescription: options.review.botDescription,
          usdPerDay: options.review.limits.watchModelUsdPerDay,
          ...(options.review.minConfidence === undefined ? {} : { minConfidence: options.review.minConfidence }),
          ...(options.review.timeZone === undefined ? {} : { timeZone: options.review.timeZone }),
          ...(options.review.summaryDelayMs === undefined ? {} : { summaryDelayMs: options.review.summaryDelayMs }),
          ...(options.review.places === undefined ? {} : { places: options.review.places }),
          ...(options.review.maxReviewsPerHour === undefined ? {} : { maxReviewsPerHour: options.review.maxReviewsPerHour }),
          ...(options.review.maxReviewsPerDay === undefined ? {} : { maxReviewsPerDay: options.review.maxReviewsPerDay }),
          ...(options.review.reasoningEffort === undefined ? {} : { reasoningEffort: options.review.reasoningEffort }),
          model: route,
          // Расход и число чтений общие на приложение: веб и фоновый работник делят один бюджет.
          spendDir: options.dir,
          knownSecrets,
          now,
          ...(options.redact ? { redact: options.redact } : {}),
          onFinding: recordBadAnswer,
          onDeferredSummary: (summary) =>
            notifyOwner(
              `🟡 ${options.appName}: чтение разговоров, отложено ${summary.deferred}. Суточный бюджет (${summary.usdPerDay} $) на сегодня исчерпан, остальные разговоры прочитаю завтра.`,
            ),
          onError: ownError,
        })
      } catch (error) {
        ownError('чтение разговоров не запущено', error)
      }
    }
  }

  // Тревоги, которые прошлый процесс записал, но отправить не успел (обычно — его падение).
  // Одинаковые склеиваются по отпечатку: одна тревога со счётчиком, а не по сообщению на запись.
  if (outbox) {
    const groups = new Map<string, { event: IncidentEvent; eventIds: string[]; count: number; firstSeenAt: number; lastSeenAt: number }>()
    try {
      for (const entry of outbox.awaitingNotification()) {
        const seenAt = Date.parse(entry.event.occurredAt)
        const occurrences = 1 + entry.repeats
        const group = groups.get(entry.event.fingerprint)
        if (!group) {
          groups.set(entry.event.fingerprint, { event: entry.event, eventIds: [entry.event.eventId], count: occurrences, firstSeenAt: seenAt, lastSeenAt: seenAt })
          continue
        }
        group.eventIds.push(entry.event.eventId)
        group.count += occurrences
        group.firstSeenAt = Math.min(group.firstSeenAt, seenAt)
        group.lastSeenAt = Math.max(group.lastSeenAt, seenAt)
      }
    } catch (error) {
      ownError('остатки прошлого процесса не прочитаны', error)
    }
    const startup = setImmediate(() => {
      try {
        for (const group of groups.values()) {
          notifier.observe(group.event, now())
          sendAlert(group.event, group, group.eventIds)
        }
        scheduleDelivery()
      } catch (error) {
        ownError('тревога об остатках прошлого процесса не запущена', error)
      }
    })
    startup.unref?.()
  }

  function installProcessHandlers(): void {
    // Монитор не меняет поведения: Node сам напечатает след и завершит процесс или отдаст ошибку обработчику приложения.
    // Отказ промиса, который мы сами перебрасываем как ошибку, уже записан: пропустить ровно один раз.
    let rethrown: unknown = NO_RETHROW
    const onException = (error: unknown) => {
      if (rethrown !== NO_RETHROW && error === rethrown) {
        rethrown = NO_RETHROW
        return
      }
      capture(error, { kind: 'crash' })
    }
    const onRejection = (reason: unknown) => {
      capture(reason, { kind: 'crash' })
      // Если обработчик отказов только наш, повторяем то, что Node сделал бы без него.
      if (process.listenerCount('unhandledRejection') > 1) return
      const mode = unhandledRejectionsMode()
      const asError = (() => {
        if (reason instanceof Error) return reason
        return Object.assign(
          new Error(
            `This error originated either by throwing inside of an async function without a catch block, or by rejecting a promise which was not handled with .catch(). The promise rejected with the reason "${errorParts(reason).message}".`,
          ),
          { code: 'ERR_UNHANDLED_REJECTION' },
        )
      })()
      if (mode === 'throw' || mode === 'strict') {
        rethrown = asError
        process.nextTick(() => {
          throw asError
        })
      } else if (mode === 'warn' || mode === 'warn-with-error-code') {
        process.emitWarning(asError)
        if (mode === 'warn-with-error-code') process.exitCode = 1
      }
    }
    process.on('uncaughtExceptionMonitor', onException)
    process.on('unhandledRejection', onRejection)
    removeProcessHandlers.push(
      () => process.off('uncaughtExceptionMonitor', onException),
      () => process.off('unhandledRejection', onRejection),
    )
  }

  function wrapModel(model: unknown, place: { model: string; provider: string }): unknown {
    if (typeof model !== 'object' || model === null) return model
    const report = (error: unknown) => {
      if (isCancellation(error)) return
      capture(error, { kind: 'model_error', where: place.model, context: { model: place.model, provider: place.provider } })
    }
    return new Proxy(model, {
      get(target, property) {
        const value: unknown = Reflect.get(target, property, target)
        if (typeof value !== 'function') return value
        if (property === 'doGenerate') {
          return async (...args: unknown[]) => {
            try {
              return await (value as (...a: unknown[]) => Promise<unknown>).apply(target, args)
            } catch (error) {
              report(error)
              throw error
            }
          }
        }
        if (property === 'doStream') {
          return async (...args: unknown[]) => {
            let result: { stream?: unknown }
            try {
              result = (await (value as (...a: unknown[]) => Promise<{ stream?: unknown }>).apply(target, args)) ?? {}
            } catch (error) {
              report(error)
              throw error
            }
            if (!(result.stream instanceof ReadableStream)) return result
            const watched = result.stream.pipeThrough(
              new TransformStream<{ type?: string; error?: unknown }, { type?: string; error?: unknown }>({
                transform(part, controller) {
                  if (part?.type === 'error') report(part.error)
                  controller.enqueue(part)
                },
              }),
            )
            return { ...result, stream: watched }
          }
        }
        return (value as (...a: unknown[]) => unknown).bind(target)
      },
    })
  }

  return {
    capture,
    installProcessHandlers,
    handleStopButton,
    wrapModelCatalog<C extends ModelCatalogLike>(catalog: C): C {
      const wrapProvider = (provider: C['providers'][number]) =>
        new Proxy(provider, {
          get(target, property) {
            const value: unknown = Reflect.get(target, property, target)
            if (property !== 'createLanguageModel' || typeof value !== 'function') {
              return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value
            }
            return (modelId: string, ...rest: unknown[]) =>
              wrapModel((value as (...a: unknown[]) => unknown).call(target, modelId, ...rest), {
                model: modelId,
                provider: target.id,
              })
          },
        })
      // Каталог остаётся тем же объектом для приложения: прототип и методы на месте, подменяется только список поставщиков.
      let source: C['providers'] | null = null
      let wrapped: C['providers'] = []
      return new Proxy(catalog, {
        get(target, property) {
          const value: unknown = Reflect.get(target, property, target)
          if (property === 'providers') {
            if (value !== source) {
              source = value as C['providers']
              wrapped = Array.isArray(value) ? value.map(wrapProvider) : (value as C['providers'])
            }
            return wrapped
          }
          return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value
        },
      })
    },
    conversationFinished(conversation) {
      try {
        if (reviewer) reviewer.conversationFinished(conversation)
        else if (reviewMisconfigured) {
          reviewMisconfigured = false
          ownError('чтение разговоров не работает: в настройке есть review, но нет model')
        }
      } catch (error) {
        ownError('разговор не принят на чтение', error)
      }
    },
    async flush(timeoutMs) {
      try {
        const deadline = Date.now() + timeoutMs
        const timeLeft = () => deadline - Date.now()
        const withinDeadline = <T>(promise: Promise<T>) =>
          Promise.race([promise, new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), Math.max(0, timeLeft())).unref?.())])
        // Тревоги, отложенные в setImmediate, должны успеть начаться.
        await new Promise<void>((resolve) => setImmediate(resolve))
        while (pendingCount() > 0 && timeLeft() > 0 && !closed) {
          // По сроку перестаём ждать, но проход не бросаем: он закончится сам, и второй не начнётся раньше.
          if ((await withinDeadline(startDelivery(true))) === 'timeout') break
          if (pendingCount() > 0) await new Promise((resolve) => setTimeout(resolve, Math.min(100, Math.max(0, timeLeft()))))
        }
        while (notifications.size > 0 && timeLeft() > 0) {
          if ((await withinDeadline(Promise.allSettled([...notifications]))) === 'timeout') break
        }
        if (pendingCount() > 0 && outbox) scheduleDelivery(Math.max(0, (outbox.nextAttemptAt() ?? now()) - now()))
        return pendingCount() === 0 && notifications.size === 0
      } catch (error) {
        ownError('flush не удался', error)
        return false
      }
    },
    stats() {
      let queue = EMPTY_QUEUE_STATS
      try {
        if (outbox) queue = outbox.stats()
      } catch (error) {
        ownError('очередь не читается', error)
      }
      return { queue, ownErrors, fingerprints: notifier.size(), review: reviewer?.stats() ?? null }
    },
    close() {
      closed = true
      reviewer?.close()
      if (deliveryTimer) clearTimeout(deliveryTimer)
      deliveryTimer = null
      for (const remove of removeProcessHandlers.splice(0)) remove()
      try {
        outbox?.close()
      } catch (error) {
        ownError('замок очереди не снят', error)
      }
    },
  }
}
