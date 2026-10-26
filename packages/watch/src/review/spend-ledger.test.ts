import { appendFileSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { createSpendLedger, type SpendLedger } from './spend-ledger.js'

const HOUR = 3_600_000
let dir: string
let clock: number
let errors: string[]

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'remontnik-ledger-'))
  clock = Date.parse('2026-10-26T10:00:00Z')
  errors = []
})

function open(options: { dir?: string | null; usdPerDay?: number; perHour?: number; perDay?: number; timeZone?: string } = {}): SpendLedger {
  return createSpendLedger({
    usdPerDay: options.usdPerDay ?? 1,
    maxReviewsPerHour: options.perHour ?? 100,
    maxReviewsPerDay: options.perDay ?? 1000,
    timeZone: options.timeZone ?? 'UTC',
    now: () => clock,
    ...(options.dir === null ? {} : { dir: options.dir ?? dir }),
    onError: (what) => errors.push(what),
  })
}

function reserved(ledger: SpendLedger, estimate: number): string {
  const result = ledger.reserve(estimate)
  if (!result.ok) throw new Error(`отказ: ${result.reason}`)
  return result.id
}

describe('общий учёт расхода: бюджет', () => {
  it('резерв по оценке занимает бюджет сразу, после ответа заменяется настоящим расходом', () => {
    const ledger = open({ usdPerDay: 1 })

    const id = reserved(ledger, 0.4)
    expect(ledger.spentToday()).toBeCloseTo(0.4, 9)

    ledger.settle(id, 0.05)
    expect(ledger.spentToday()).toBeCloseTo(0.05, 9)
  })

  it('резерв, который не влезает в остаток, отклоняется, а бюджет не превышается', () => {
    const ledger = open({ usdPerDay: 1 })
    reserved(ledger, 0.7)

    expect(ledger.reserve(0.4)).toEqual({ ok: false, reason: 'budget' })
    expect(ledger.spentToday()).toBeCloseTo(0.7, 9)
  })

  it('нулевой бюджет: резервов нет', () => {
    expect(open({ usdPerDay: 0 }).reserve(0.0001)).toEqual({ ok: false, reason: 'budget' })
  })

  it('два процесса одного приложения делят один бюджет, а не получают по полному', () => {
    const web = open({ usdPerDay: 1 })
    const worker = open({ usdPerDay: 1 })

    reserved(web, 0.6)

    expect(worker.spentToday()).toBeCloseTo(0.6, 9)
    expect(worker.reserve(0.6)).toEqual({ ok: false, reason: 'budget' })
    expect(worker.reserve(0.3)).toMatchObject({ ok: true })
    expect(web.spentToday()).toBeCloseTo(0.9, 9)
  })

  it('процесс упал посреди запроса: его резерв остаётся в расходе по оценке', () => {
    const crashed = open({ usdPerDay: 1 })
    reserved(crashed, 0.8)

    const restarted = open({ usdPerDay: 1 })

    expect(restarted.spentToday()).toBeCloseTo(0.8, 9)
    expect(restarted.reserve(0.3)).toEqual({ ok: false, reason: 'budget' })
  })

  it('процессы с одним именем не затирают учёт друг друга', () => {
    const first = open({ usdPerDay: 1 })
    const second = open({ usdPerDay: 1 })

    reserved(first, 0.2)
    reserved(second, 0.2)
    reserved(first, 0.2)

    expect(open().spentToday()).toBeCloseTo(0.6, 9)
  })

  it('новые сутки по поясу из настройки: расход с нуля, прошлые сутки не мешают', () => {
    clock = Date.parse('2026-10-26T20:00:00Z') // в Москве уже 23:00 тех же суток
    const ledger = open({ usdPerDay: 1, timeZone: 'Europe/Moscow' })
    reserved(ledger, 0.9)

    clock = Date.parse('2026-10-26T21:30:00Z') // в Москве 00:30 следующих суток
    expect(ledger.spentToday()).toBe(0)
    expect(ledger.reserve(0.9)).toMatchObject({ ok: true })
  })

  it('в памяти, без папки: учёт работает в пределах процесса', () => {
    const ledger = open({ dir: null, usdPerDay: 1 })

    reserved(ledger, 0.6)

    expect(ledger.reserve(0.6)).toEqual({ ok: false, reason: 'budget' })
    expect(readdirSync(dir)).toEqual([])
  })

  it('старые файлы учёта удаляются, файлы последних двух суток остаются', () => {
    for (const day of ['2026-10-20', '2026-10-24', '2026-10-25']) writeFileSync(join(dir, `review-spend-${day}.jsonl`), '')
    const ledger = open()

    reserved(ledger, 0.1)

    expect(readdirSync(dir).sort()).toEqual(['review-spend-2026-10-25.jsonl', 'review-spend-2026-10-26.jsonl'])
  })

  it('испорченная строка пропускается, остальной учёт цел, ошибка сообщается один раз', () => {
    const ledger = open({ usdPerDay: 1 })
    reserved(ledger, 0.3)
    appendFileSync(join(dir, 'review-spend-2026-10-26.jsonl'), 'не json\n{"t":"reserve"}\n')

    expect(ledger.spentToday()).toBeCloseTo(0.3, 9)
    expect(ledger.spentToday()).toBeCloseTo(0.3, 9)
    expect(errors).toHaveLength(1)
  })

  it('недоступная папка не роняет учёт: ошибка в журнал, дальше счёт в памяти', () => {
    writeFileSync(join(dir, 'файл'), '')
    const ledger = open({ dir: join(dir, 'файл', 'внутри') })

    expect(ledger.reserve(0.1)).toMatchObject({ ok: true })
    expect(errors.length).toBeGreaterThan(0)
  })
})

describe('общий учёт расхода: число чтений', () => {
  it('в час — не больше лимита; следующий срок называется по самому раннему чтению часа', () => {
    const ledger = open({ perHour: 3 })
    const start = clock
    for (let index = 0; index < 3; index += 1) {
      reserved(ledger, 0.01)
      clock += 60_000
    }

    expect(ledger.reserve(0.01)).toEqual({ ok: false, reason: 'hourly_limit', retryAt: start + HOUR })

    clock = start + HOUR
    expect(ledger.reserve(0.01)).toMatchObject({ ok: true })
  })

  it('в сутки — не больше лимита, до новых суток', () => {
    const ledger = open({ perHour: 100, perDay: 4 })
    for (let index = 0; index < 4; index += 1) {
      reserved(ledger, 0.001)
      clock += 2 * HOUR
    }

    expect(ledger.reserve(0.001)).toEqual({ ok: false, reason: 'daily_limit' })
  })

  it('лимиты общие для процессов приложения', () => {
    const web = open({ perHour: 2 })
    const worker = open({ perHour: 2 })

    reserved(web, 0.001)
    reserved(worker, 0.001)

    expect(web.reserve(0.001)).toMatchObject({ ok: false, reason: 'hourly_limit' })
  })

  it('отклонённый резерв чтением не считается', () => {
    const ledger = open({ usdPerDay: 0.05, perHour: 2 })
    reserved(ledger, 0.04)
    expect(ledger.reserve(0.04)).toEqual({ ok: false, reason: 'budget' })
    expect(ledger.reserve(0.04)).toEqual({ ok: false, reason: 'budget' })

    expect(ledger.readsToday()).toBe(1)
  })
})
