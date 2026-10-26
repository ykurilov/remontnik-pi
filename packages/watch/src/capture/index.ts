import {
  createIncidentEvent,
  whereFromStack,
  type IncidentContext,
  type IncidentEvent,
  type IncidentKind,
} from '@ykurilov/remontnik-core/incident'
import { signBody } from '@ykurilov/remontnik-core/signed-http'
import { createTelegramClient, type TelegramClient } from '@ykurilov/remontnik-core/telegram'
import { createIncidentNotifier, formatIncidentAlert } from '../notify/index.js'
import { OUTBOX_BATCH_LIMIT, openOutbox, type Outbox, type OutboxEntry, type OutboxStats } from '../outbox/index.js'

// Сторож внутри приложения. Горячий путь — только синхронная запись в очередь на диске;
// доставка врачу и тревога в Telegram идут позже, в фоне. Ошибки сторожа не роняют приложение:
// они уходят строкой `[remontnik] …` в журнал и в счётчик ownErrors, но случаем не становятся.

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
  /** Дополнительная вычистка личных данных приложения, поверх встроенной. */
  redact?: (text: string) => string
  /** Текущая версия приложения для отметки в событии; функция вызывается один раз при старте. */
  release?: string | null | (() => Promise<string | null>)
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
  /** Немедленно пробует доставить всё ожидающее. `true` — очередь пуста и тревоги отправлены. */
  flush(timeoutMs: number): Promise<boolean>
  stats(): WatchStats
  close(): void
}

const DOCTOR_TIMEOUT_MS = 10_000

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

export function createWatch(options: WatchOptions): Watch {
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
    outbox = openOutbox({ dir: options.dir, processName: options.processName, now })
  } catch (error) {
    ownError(`очередь в ${options.dir} недоступна, случаи не сохраняются`, error)
  }

  async function resolveChatId(): Promise<string | null> {
    const { chatId } = options.telegram
    return typeof chatId === 'string' ? chatId : chatId()
  }

  function sendAlert(event: IncidentEvent, counter: { count: number; firstSeenAt: number; lastSeenAt: number }): void {
    if (closed || notifyingIds.has(event.eventId)) return
    notifyingIds.add(event.eventId)
    const sending = (async () => {
      try {
        const chatId = await resolveChatId()
        if (chatId === null) return
        await telegram.sendMessage(chatId, formatIncidentAlert(event, counter))
        outbox?.markNotified(event.eventId)
      } catch (error) {
        ownError('тревога в Telegram не ушла', error)
      } finally {
        notifyingIds.delete(event.eventId)
      }
    })()
    notifications.add(sending)
    void sending.finally(() => notifications.delete(sending))
  }

  async function postToDoctor(entries: OutboxEntry[]): Promise<void> {
    if (!outbox || entries.length === 0) return
    const ids = entries.map((entry) => entry.event.eventId)
    try {
      const body = JSON.stringify({ events: entries.map((entry) => entry.event) })
      const response = await fetchImpl(doctorUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...signBody(body, options.doctor.secret, now()) },
        body,
        signal: AbortSignal.timeout(DOCTOR_TIMEOUT_MS),
      })
      if (!response.ok) throw new Error(`врач ответил ${response.status}`)
      const payload = (await response.json()) as { accepted?: unknown }
      const accepted = new Set(Array.isArray(payload.accepted) ? payload.accepted.filter((id) => typeof id === 'string') : [])
      outbox.ack([...accepted])
      const rest = ids.filter((id) => !accepted.has(id))
      if (rest.length > 0) outbox.recordFailure(rest, now())
      doctorFailing = false
    } catch (error) {
      outbox.recordFailure(ids, now())
      // Одна строка на начало перебоя, а не на каждую попытку.
      if (!doctorFailing) ownError('врач недоступен, случаи ждут в очереди', error)
      doctorFailing = true
    }
  }

  function scheduleDelivery(delayMs = 0): void {
    if (closed || !outbox) return
    if (deliveryTimer) clearTimeout(deliveryTimer)
    deliveryTimer = setTimeout(() => {
      deliveryTimer = null
      void deliverDue()
    }, Math.max(0, delayMs))
    deliveryTimer.unref?.()
  }

  async function deliverDue(): Promise<void> {
    if (!outbox || closed) return
    if (delivering) return
    delivering = (async () => {
      for (let batch = outbox.due(now()); batch.length > 0 && !closed; batch = outbox.due(now())) {
        await postToDoctor(batch)
      }
    })()
    try {
      await delivering
    } finally {
      delivering = null
    }
    const next = outbox.nextAttemptAt()
    if (next !== null) scheduleDelivery(next - now())
  }

  function capture(error: unknown, captureOptions: CaptureOptions = {}): string {
    try {
      const { message, stack } = errorParts(error)
      const context: IncidentContext = { processName: options.processName, ...captureOptions.context }
      if (release !== undefined) context.release = release
      const event = createIncidentEvent(
        {
          appName: options.appName,
          kind: captureOptions.kind ?? 'manual',
          where: captureOptions.where ?? whereFromStack(stack, appRoot),
          message,
          stack,
          context,
          occurredAt: new Date(now()),
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
          if (decision.notify) sendAlert(event, decision.state)
          scheduleDelivery()
        })
        deferred.unref?.()
      }
      return event.eventId
    } catch (captureError) {
      ownError('сбой не записан', captureError)
      return ''
    }
  }

  // Тревоги, которые прошлый процесс записал, но отправить не успел (обычно — его падение).
  if (outbox) {
    const leftovers = outbox.awaitingNotification()
    const startup = setImmediate(() => {
      for (const entry of leftovers) {
        const seenAt = Date.parse(entry.event.occurredAt)
        notifier.observe(entry.event, now())
        sendAlert(entry.event, { count: 1, firstSeenAt: seenAt, lastSeenAt: seenAt })
      }
      scheduleDelivery()
    })
    startup.unref?.()
  }

  function installProcessHandlers(): void {
    // Монитор не меняет поведения: Node сам напечатает след и завершит процесс или отдаст ошибку обработчику приложения.
    const recorded = new WeakSet<object>()
    const onException = (error: unknown) => {
      if (typeof error === 'object' && error !== null) {
        if (recorded.has(error)) return
        recorded.add(error)
      }
      capture(error, { kind: 'crash' })
    }
    const onRejection = (reason: unknown) => {
      if (typeof reason === 'object' && reason !== null) recorded.add(reason)
      capture(reason, { kind: 'crash' })
      // Если обработчик отказов только наш, повторяем то, что Node сделал бы без него.
      if (process.listenerCount('unhandledRejection') > 1) return
      const mode = unhandledRejectionsMode()
      const asError = (() => {
        if (reason instanceof Error) return reason
        const wrapped = Object.assign(
          new Error(
            `This error originated either by throwing inside of an async function without a catch block, or by rejecting a promise which was not handled with .catch(). The promise rejected with the reason "${errorParts(reason).message}".`,
          ),
          { code: 'ERR_UNHANDLED_REJECTION' },
        )
        recorded.add(wrapped)
        return wrapped
      })()
      if (mode === 'throw' || mode === 'strict') {
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
    const report = (error: unknown) =>
      capture(error, { kind: 'model_error', where: place.model, context: { model: place.model, provider: place.provider } })
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
    wrapModelCatalog<C extends ModelCatalogLike>(catalog: C): C {
      const providers = catalog.providers.map(
        (provider) =>
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
          }),
      )
      return { ...catalog, providers } as C
    },
    async flush(timeoutMs) {
      const deadline = Date.now() + timeoutMs
      const timeLeft = () => deadline - Date.now()
      const withinDeadline = <T>(promise: Promise<T>) =>
        Promise.race([promise, new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), Math.max(0, timeLeft())).unref?.())])
      // Тревоги, отложенные в setImmediate, должны успеть начаться.
      await new Promise<void>((resolve) => setImmediate(resolve))
      while (outbox && outbox.stats().pending > 0 && timeLeft() > 0 && !closed) {
        if (delivering) {
          await withinDeadline(delivering)
          continue
        }
        const batch = outbox.pending().slice(0, OUTBOX_BATCH_LIMIT)
        delivering = postToDoctor(batch)
        try {
          if ((await withinDeadline(delivering)) === 'timeout') break
        } finally {
          delivering = null
        }
        if (outbox.stats().pending > 0) await new Promise((resolve) => setTimeout(resolve, Math.min(100, Math.max(0, timeLeft()))))
      }
      while (notifications.size > 0 && timeLeft() > 0) {
        if ((await withinDeadline(Promise.allSettled([...notifications]))) === 'timeout') break
      }
      if (outbox && outbox.stats().pending > 0) scheduleDelivery(Math.max(0, (outbox.nextAttemptAt() ?? now()) - now()))
      return (outbox?.stats().pending ?? 0) === 0 && notifications.size === 0
    },
    stats() {
      const queue: OutboxStats = outbox?.stats() ?? { pending: 0, delivered: 0, failedAttempts: 0, oldestPendingAt: null, nextAttemptAt: null }
      return { queue, ownErrors, fingerprints: notifier.size() }
    },
    close() {
      closed = true
      if (deliveryTimer) clearTimeout(deliveryTimer)
      deliveryTimer = null
      for (const remove of removeProcessHandlers.splice(0)) remove()
    },
  }
}
