import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createWatch, type Watch } from '../../src/capture/index.js'

// Горячий путь сторожа: то, что приложение вызывает прямо в своём потоке, — ошибка, ответ модели, конец разговора.
// Бюджет: не больше 1 мс на событие в среднем. Сеть подменена: отправка врачу, Telegram и модель отвечают отказом,
// а асинхронные продолжения (`setImmediate`, таймеры) в замер не попадают — цикл событий в нём не крутится.

const BUDGET_MS = 1
const WARMUP = 200
const EVENTS = 2000

let dir: string
let watch: Watch

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'remontnik-perf-'))
  const offlineFetch = (async () => new Response('{}', { status: 503 })) as typeof fetch
  watch = createWatch({
    appName: 'perf',
    processName: 'web',
    dir,
    doctor: { url: 'http://doctor.invalid', secret: 'perf-secret' },
    telegram: { botToken: '123456:perf-bot-token', chatId: 'owner-chat', apiBaseUrl: 'http://telegram.invalid' },
    model: {
      primary: { baseUrl: 'http://model.invalid', apiKey: 'perf-primary-key', model: 'primary' },
      fallback: { baseUrl: 'http://model.invalid', apiKey: 'perf-fallback-key', model: 'fallback' },
    },
    review: { botDescription: 'Бот магазина: отвечает про заказы и тарифы.', limits: { watchModelUsdPerDay: 1 } },
    fetch: offlineFetch,
  })
})

afterEach(() => {
  watch.close()
  rmSync(dir, { recursive: true, force: true })
})

interface Timing {
  mean: number
  p99: number
  max: number
}

/** Время одного вызова в миллисекундах: среднее, 99-й процентиль и худший случай. */
function measure(call: (index: number) => void): Timing {
  for (let index = 0; index < WARMUP; index += 1) call(-1 - index)
  const durations: number[] = []
  for (let index = 0; index < EVENTS; index += 1) {
    const start = performance.now()
    call(index)
    durations.push(performance.now() - start)
  }
  durations.sort((a, b) => a - b)
  const mean = durations.reduce((sum, value) => sum + value, 0) / durations.length
  return { mean, p99: durations[Math.floor(durations.length * 0.99)]!, max: durations.at(-1)! }
}

function report(name: string, timing: Timing): void {
  console.log(`[perf] ${name}: среднее ${timing.mean.toFixed(3)} мс, p99 ${timing.p99.toFixed(3)} мс, худший ${timing.max.toFixed(3)} мс`)
}

describe('горячий путь сторожа: не больше 1 мс на событие', () => {
  it('capture: ошибка с настоящим следом, каждая новая', () => {
    const timing = measure((index) => {
      watch.capture(new Error(`order ${index} not found`), { kind: 'tool_error', where: 'lookupOrder', context: { chatId: `chat-${index}` } })
    })
    report('capture, новые ошибки', timing)
    expect(timing.mean).toBeLessThanOrEqual(BUDGET_MS)
  })

  it('capture: одна и та же ошибка снова и снова (склейка повторов)', () => {
    const error = new Error('model overloaded')
    const timing = measure(() => void watch.capture(error, { kind: 'model_error', where: 'chat' }))
    report('capture, повторы', timing)
    expect(timing.mean).toBeLessThanOrEqual(BUDGET_MS)
  })

  it('ответ модели: вызов через обёртку каталога и сбой модели', async () => {
    class FakeModel {
      readonly modelId = 'fake-model'
      async doGenerate(): Promise<{ text: string }> {
        throw new Error('503 overloaded')
      }
    }
    const catalog = watch.wrapModelCatalog({
      providers: [{ id: 'fake', createLanguageModel: (_id: string) => new FakeModel() }],
    })
    // В горячем пути приложения: достать модель из обёрнутого каталога и вызвать её. Ошибка идёт дальше как была.
    const durations: number[] = []
    for (let index = -WARMUP; index < EVENTS; index += 1) {
      const start = performance.now()
      const promise = catalog.providers[0]!.createLanguageModel('fake-model').doGenerate()
      const rejected = promise.catch(() => undefined)
      // Обёртка ловит ошибку после микрозадачи: ждём её, но замеряем только синхронную часть и саму запись.
      await rejected
      if (index >= 0) durations.push(performance.now() - start)
    }
    durations.sort((a, b) => a - b)
    const timing = {
      mean: durations.reduce((sum, value) => sum + value, 0) / durations.length,
      p99: durations[Math.floor(durations.length * 0.99)]!,
      max: durations.at(-1)!,
    }
    report('ответ модели с ошибкой', timing)
    expect(timing.mean).toBeLessThanOrEqual(BUDGET_MS)
  })

  it('ответ модели: успешный вызов через обёртку каталога', async () => {
    class FakeModel {
      readonly modelId = 'fake-model'
      async doGenerate(): Promise<{ text: string }> {
        return { text: 'ok' }
      }
    }
    const catalog = watch.wrapModelCatalog({
      providers: [{ id: 'fake', createLanguageModel: (_id: string) => new FakeModel() }],
    })
    const durations: number[] = []
    for (let index = -WARMUP; index < EVENTS; index += 1) {
      const start = performance.now()
      await catalog.providers[0]!.createLanguageModel('fake-model').doGenerate()
      if (index >= 0) durations.push(performance.now() - start)
    }
    durations.sort((a, b) => a - b)
    const mean = durations.reduce((sum, value) => sum + value, 0) / durations.length
    console.log(`[perf] ответ модели без ошибки: среднее ${mean.toFixed(3)} мс`)
    expect(mean).toBeLessThanOrEqual(BUDGET_MS)
  })

  it('conversationFinished: разговор из 20 сообщений, каждый новый', () => {
    const timing = measure((index) => {
      watch.conversationFinished({
        id: `talk-${index}`,
        messages: Array.from({ length: 20 }, (_, position) => ({
          role: position % 2 === 0 ? 'user' : 'assistant',
          content: `Сообщение ${position} разговора ${index}: сколько стоит тариф «Макс» и когда придёт заказ?`,
        })),
        meta: { chatId: `chat-${index}` },
      })
    })
    report('conversationFinished, 20 сообщений', timing)
    expect(timing.mean).toBeLessThanOrEqual(BUDGET_MS)
  })
})
