import type { Api, AssistantMessage, Model } from '@earendil-works/pi-ai'

// Наибольшая цена одного запроса к модели — из неё складывается бронь до запроса (FR-030).
// Оценка нарочно с запасом: токен на каждые 2 байта разговора (обычно их 3–4), самая дорогая ставка входа
// и выхода с учётом ступеней цены, выход — весь предел длины ответа (нет предела или он 0 — предел модели).
// Здесь же — оплачен ли запрос, который кончился ошибкой: от этого зависит, сколько списать.

const BYTES_PER_TOKEN = 2
const TOKENS_PER_MTOK = 1_000_000

/** Почему по цене модели бронь не посчитать; `undefined` — цена известна. */
export function unknownPriceOf(model: Model<Api>): string | undefined {
  const rates = model.cost ? [model.cost, ...(model.cost.tiers ?? [])] : []
  const valid = rates.length > 0 && rates.every((rate) => [rate.input, rate.output, rate.cacheRead, rate.cacheWrite].every((value) => Number.isFinite(value) && value >= 0))
  if (!valid) return 'цена модели неизвестна'
  if (rates.every((rate) => rate.input === 0 && rate.output === 0)) return 'цена модели неизвестна (в описании модели нули)'
  return undefined
}

/** Наибольшая цена запроса в долларах. Цену модели проверяет `unknownPriceOf`: без неё здесь ошибка. */
export function maxRequestUsd(model: Model<Api>, context: unknown, maxTokens: number | undefined): number {
  const why = unknownPriceOf(model)
  if (why) throw new Error(why)
  const rates = [model.cost, ...(model.cost.tiers ?? [])]
  const inputRate = Math.max(...rates.map((rate) => Math.max(rate.input, rate.cacheWrite, rate.cacheRead)))
  const outputRate = Math.max(...rates.map((rate) => rate.output))
  const inputTokens = Buffer.byteLength(JSON.stringify(context)) / BYTES_PER_TOKEN
  return (inputTokens * inputRate + (maxTokens || model.maxTokens) * outputRate) / TOKENS_PER_MTOK
}

/** Код HTTP из текста ошибки поставщика: «503 …» или «status code: 503». */
export function statusFromMessage(text: string | undefined): number | undefined {
  const match = text?.match(/^\s*(\d{3})\b/) ?? text?.match(/\bstatus(?: code)?:? (\d{3})\b/i)
  return match ? Number(match[1]) : undefined
}

/** Ошибка с кодом HTTP от 400 — запрос отклонён и не оплачен; без кода (обрыв, тайм-аут) или ниже 400 — мог быть оплачен. */
export function mayHaveBeenPaid(message: AssistantMessage, status?: number): boolean {
  const code = status ?? statusFromMessage(message.errorMessage)
  return code === undefined || code < 400
}
