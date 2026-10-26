import { randomUUID } from 'node:crypto'
import {
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Model,
  type Models,
} from '@earendil-works/pi-ai'
import type { RemontnikConfig } from '@ykurilov/remontnik-core/config'
import type { RecordStore } from '../records/index.js'
import { ConfigSourceError } from '../service/config-source.js'
import { mayHaveBeenPaid, maxRequestUsd, unknownPriceOf } from '../model/request-price.js'
import { caseLimitUsdOf, holdModelIn, settleModelHoldIn, spendDayKey, type ModelBlock } from './spend-ledger.js'

// Жёсткий потолок модели врача (FR-030), так же, как у прокси eval: перед каждым запросом к поставщику — бронь
// наибольшей цены одной транзакцией (`holdModelIn`), после ответа — настоящая цена. Денег на бронь нет — запрос
// не уходит, а разговор получает ошибку «out of budget»: pi-ai считает её неповторяемой, и ход разговора кончается.
// Хук pi-durable отказать в запросе не может (его ошибки только сообщаются), поэтому отказ — здесь, в моделях врача.
//
// Через бронь идёт любой путь к модели: `streamSimple` и `completeSimple` (генерация и сжатие разговора pi-durable),
// `stream` и `complete`. Отложенные ответы (`streamDeferred`, `fetchDeferred`) врач не использует: в них отказ.
// Запрос привязывается к случаю через сигнал исполнения: хук `beforeRequest` получает исполнение генерации с тем же
// `signal`, который затем уходит в запрос. Запрос без привязки (сжатие разговора) считается только в день.

export { maxRequestUsd } from '../model/request-price.js'

type ChatContext = Parameters<Models['streamSimple']>[1]
type ChatOptions = { signal?: AbortSignal; maxTokens?: number }

export interface ModelBudget {
  /** Модели врача: каждый запрос сначала бронирует наибольшую цену. */
  readonly models: Models
  /** Запрос этого исполнения генерации — от случая `caseId`. */
  bind(signal: AbortSignal, caseId: number): void
  /** Подключить учёт, когда записи врача открыты. До этого запросы не уходят. */
  attach(ledger: { records: RecordStore; loadConfig(): Promise<RemontnikConfig> }): void
}

function refusal(model: Model<Api>, why: string): AssistantMessage {
  return {
    role: 'assistant',
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: 'error',
    errorMessage: `Ремонтник: out of budget — ${why}; запрос к модели не отправлен`,
    timestamp: Date.now(),
  }
}

/**
 * Настоящая цена ушедшего запроса: ответ пришёл — счёт поставщика. Поставщик отклонил запрос (код HTTP от 400) —
 * тоже его счёт: такой запрос не оплачивается. Оборвался без кода — частичный счёт занижен (поставщик мог насчитать
 * больше, чем успел сообщить), поэтому в учёт идёт вся бронь.
 */
function actualUsdOf(answer: AssistantMessage | undefined, maxUsd: number): number {
  if (answer && answer.stopReason !== 'error' && answer.stopReason !== 'aborted') return answer.usage.cost.total
  if (answer && answer.stopReason === 'error' && !mayHaveBeenPaid(answer)) return answer.usage.cost.total
  return Math.max(answer?.usage.cost.total ?? 0, maxUsd)
}

export function createModelBudget(options: { models: Models; boot: string; now(): number; report?(error: unknown): void; log?(line: string): void }): ModelBudget {
  const cases = new WeakMap<AbortSignal, number>()
  const report = options.report ?? (() => {})
  const log = options.log ?? (() => {})
  let ledger: { records: RecordStore; loadConfig(): Promise<RemontnikConfig> } | undefined

  async function hold(caseId: number | undefined, maxUsd: number): Promise<{ held: true; dayKey: string; holdId: string } | { held: false; why: string }> {
    if (!ledger) return { held: false, why: 'учёт расходов ещё не открыт' }
    // Без настройки нет ни потолков, ни часового пояса дня: запрос не уходит, а причина — та, что у настройки
    // (например, «настройку нельзя прочитать: Docker недоступен»), а не «учёт расходов не отвечает».
    const config = await ledger.loadConfig().catch((error: unknown) => {
      report(error)
      return { why: error instanceof ConfigSourceError ? error.message : 'настройка не читается' }
    })
    if ('why' in config) return { held: false, why: config.why }
    const dayKey = spendDayKey(options.now(), config.app.timeZone)
    const holdId = randomUUID()
    const answer = await ledger.records.transaction((tx) =>
      holdModelIn(tx, {
        dayKey,
        holdId,
        maxUsd,
        boot: options.boot,
        now: options.now(),
        caseLimitUsd: caseLimitUsdOf(config.limits),
        limits: config.limits,
        ...(caseId === undefined ? {} : { caseKey: String(caseId) }),
      }),
    )
    return answer.held ? { held: true, dayKey, holdId } : { held: false, why: BLOCK_TEXT[answer.block] }
  }

  /** Поток-отказ: запрос к поставщику не уходит, разговор получает ошибку с причиной. */
  function refused(model: Model<Api>, why: string, caseId?: number): AssistantMessageEventStream {
    log(`запрос к модели не отправлен${caseId === undefined ? '' : ` (случай ${caseId})`}: ${why}`)
    const out = createAssistantMessageEventStream()
    const message = refusal(model, why)
    out.push({ type: 'error', reason: 'error', error: message })
    out.end(message)
    return out
  }

  function guarded(model: Model<Api>, context: ChatContext, streamOptions: ChatOptions | undefined, send: () => AssistantMessageEventStream): AssistantMessageEventStream {
    const signal = streamOptions?.signal
    const caseId = signal ? cases.get(signal) : undefined
    const unknownPrice = unknownPriceOf(model)
    if (unknownPrice) return refused(model, unknownPrice, caseId)
    const out = createAssistantMessageEventStream()
    const fail = (message: AssistantMessage) => {
      out.push({ type: 'error', reason: 'error', error: message })
      out.end(message)
    }
    void (async () => {
      const maxUsd = maxRequestUsd(model, context, streamOptions?.maxTokens)
      const held = await hold(caseId, maxUsd).catch((error: unknown) => {
        report(error)
        return { held: false, why: 'учёт расходов не отвечает' } as const
      })
      if (!held.held) {
        log(`запрос к модели не отправлен${caseId === undefined ? '' : ` (случай ${caseId})`}: ${held.why}`)
        fail(refusal(model, held.why))
        return
      }
      const settle = (answer: AssistantMessage | undefined) =>
        ledger!.records
          .transaction((tx) => settleModelHoldIn(tx, { dayKey: held.dayKey, holdId: held.holdId, actualUsd: actualUsdOf(answer, maxUsd), ...(answer?.provider ? { provider: answer.provider } : {}) }))
          // Итог не записался — бронь остаётся и закрывается целиком по возрасту (`holdModelIn`).
          .catch((error: unknown) => report(error))
      try {
        for await (const event of send()) {
          if (event.type === 'done' || event.type === 'error') {
            // Итог в учёт — раньше, чем разговор узнает об ответе: следующий запрос видит уже настоящую цену.
            await settle(event.type === 'done' ? event.message : event.error)
            out.push(event)
            out.end()
            return
          }
          out.push(event)
        }
        await settle(undefined)
        out.end()
      } catch (error) {
        await settle(undefined)
        fail({ ...refusal(model, 'поставщик оборвал поток'), errorMessage: error instanceof Error ? error.message : String(error) })
      }
    })().catch((error: unknown) => {
      // Сбой самой обёртки: поток всё равно закрывается ошибкой, а не виснет.
      report(error)
      fail({ ...refusal(model, 'сбой учёта расходов'), errorMessage: `Ремонтник: out of budget — сбой учёта расходов: ${error instanceof Error ? error.message : String(error)}` })
    })
    return out
  }

  const target = options.models
  const deferredRefusal = 'отложенные ответы врач не использует'
  const chat: Pick<Models, 'streamSimple' | 'completeSimple' | 'stream' | 'complete' | 'streamDeferred' | 'fetchDeferred'> = {
    streamSimple: (model, context, streamOptions) => guarded(model, context, streamOptions, () => target.streamSimple(model, context, streamOptions)),
    completeSimple: async (model, context, streamOptions) => chat.streamSimple(model, context, streamOptions).result(),
    stream: (model, context, streamOptions) => guarded(model, context, streamOptions, () => target.stream(model, context, streamOptions)),
    complete: async (model, context, streamOptions) => chat.stream(model, context, streamOptions).result(),
    streamDeferred: (model) => refused(model, deferredRefusal),
    fetchDeferred: async (model) => refused(model, deferredRefusal).result(),
  }
  const models = new Proxy(target, {
    get(inner, property) {
      if (Object.hasOwn(chat, property)) return chat[property as keyof typeof chat]
      const value: unknown = Reflect.get(inner, property, inner)
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(inner) : value
    },
  })

  return {
    models,
    bind(signal, caseId) {
      cases.set(signal, caseId)
    },
    attach(next) {
      ledger = next
    },
  }
}

const BLOCK_TEXT: Record<ModelBlock, string> = {
  day_budget: 'дневной потолок модели врача',
  budget: 'потолок расходов на случай',
}
