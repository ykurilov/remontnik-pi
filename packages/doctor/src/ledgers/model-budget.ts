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
import { caseLimitUsdOf, holdModelIn, settleModelHoldIn, spendDayKey, type ModelBlock } from './spend-ledger.js'

// Жёсткий потолок модели врача (FR-030), так же, как у прокси eval: перед каждым запросом к поставщику — бронь
// наибольшей цены одной транзакцией (`holdModelIn`), после ответа — настоящая цена. Денег на бронь нет — запрос
// не уходит, а разговор получает ошибку «out of budget»: pi-ai считает её неповторяемой, и ход разговора кончается.
// Хук pi-durable отказать в запросе не может (его ошибки только сообщаются), поэтому отказ — здесь, в моделях врача.
//
// Запрос привязывается к случаю через сигнал исполнения: хук `beforeRequest` получает исполнение генерации с тем же
// `signal`, который затем уходит в `streamSimple`. Запрос без привязки (сжатие разговора) считается только в день.
// Обёрнут только `streamSimple`: его зовёт генерация pi-durable; другие пути к модели врач не использует.

const RESERVE_BYTES_PER_TOKEN = 3
const TOKENS_PER_MTOK = 1_000_000

export interface ModelBudget {
  /** Модели врача: каждый запрос сначала бронирует наибольшую цену. */
  readonly models: Models
  /** Запрос этого исполнения генерации — от случая `caseId`. */
  bind(signal: AbortSignal, caseId: number): void
  /** Подключить учёт, когда записи врача открыты. До этого запросы не уходят. */
  attach(ledger: { records: RecordStore; loadConfig(): Promise<RemontnikConfig> }): void
}

/**
 * Наибольшая цена запроса: вход — по байтам разговора (не меньше 1 токена на 3 байта) по самой дорогой ставке входа,
 * выход — предел длины ответа по самой дорогой ставке выхода, с учётом ступеней цены.
 */
export function maxRequestUsd(model: Model<Api>, context: unknown, maxTokens: number | undefined): number {
  const rates = [model.cost, ...(model.cost.tiers ?? [])]
  const inputRate = Math.max(...rates.map((rate) => Math.max(rate.input, rate.cacheWrite, rate.cacheRead)))
  const outputRate = Math.max(...rates.map((rate) => rate.output))
  const inputTokens = Buffer.byteLength(JSON.stringify(context)) / RESERVE_BYTES_PER_TOKEN
  return (inputTokens * inputRate + (maxTokens ?? model.maxTokens) * outputRate) / TOKENS_PER_MTOK
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

/** Настоящая цена: что насчитал поставщик; ответ оборвался без счёта, но уже шёл — вся бронь; не начался — ноль. */
function actualUsdOf(message: AssistantMessage | undefined, started: boolean, maxUsd: number): number {
  if (message && (message.usage.totalTokens > 0 || message.usage.cost.total > 0)) return message.usage.cost.total
  return started ? maxUsd : 0
}

export function createModelBudget(options: { models: Models; boot: string; now(): number; report?(error: unknown): void; log?(line: string): void }): ModelBudget {
  const cases = new WeakMap<AbortSignal, number>()
  const report = options.report ?? (() => {})
  const log = options.log ?? (() => {})
  let ledger: { records: RecordStore; loadConfig(): Promise<RemontnikConfig> } | undefined

  async function hold(caseId: number | undefined, maxUsd: number): Promise<{ held: true; dayKey: string; holdId: string } | { held: false; why: string }> {
    if (!ledger) return { held: false, why: 'учёт расходов ещё не открыт' }
    const config = await ledger.loadConfig()
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

  function guarded(inner: Models, model: Model<Api>, context: Parameters<Models['streamSimple']>[1], streamOptions?: Parameters<Models['streamSimple']>[2]) {
    const out: AssistantMessageEventStream = createAssistantMessageEventStream()
    void (async () => {
      const signal = streamOptions?.signal
      const caseId = signal ? cases.get(signal) : undefined
      const maxUsd = maxRequestUsd(model, context, streamOptions?.maxTokens)
      const held = await hold(caseId, maxUsd).catch((error: unknown) => {
        report(error)
        return { held: false, why: 'учёт расходов не отвечает' } as const
      })
      if (!held.held) {
        log(`запрос к модели не отправлен${caseId === undefined ? '' : ` (случай ${caseId})`}: ${held.why}`)
        const message = refusal(model, held.why)
        out.push({ type: 'error', reason: 'error', error: message })
        out.end(message)
        return
      }
      let started = false
      const settle = (message: AssistantMessage | undefined) =>
        ledger!.records
          .transaction((tx) => settleModelHoldIn(tx, { dayKey: held.dayKey, holdId: held.holdId, actualUsd: actualUsdOf(message, started, maxUsd) }))
          .catch((error: unknown) => report(error))
      try {
        for await (const event of inner.streamSimple(model, context, streamOptions)) {
          if (event.type === 'done' || event.type === 'error') {
            // Итог в учёт — раньше, чем разговор узнает об ответе: следующий запрос видит уже настоящую цену.
            await settle(event.type === 'done' ? event.message : event.error)
            out.push(event)
            out.end()
            return
          }
          if (event.type !== 'start') started = true
          out.push(event)
        }
        await settle(undefined)
        out.end()
      } catch (error) {
        await settle(undefined)
        const message = { ...refusal(model, 'поставщик оборвал поток'), errorMessage: error instanceof Error ? error.message : String(error) }
        out.push({ type: 'error', reason: 'error', error: message })
        out.end(message)
      }
    })()
    return out
  }

  const models = new Proxy(options.models, {
    get(target, property) {
      if (property === 'streamSimple') return (model: Model<Api>, context: Parameters<Models['streamSimple']>[1], streamOptions?: Parameters<Models['streamSimple']>[2]) => guarded(target, model, context, streamOptions)
      const value: unknown = Reflect.get(target, property, target)
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value
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
