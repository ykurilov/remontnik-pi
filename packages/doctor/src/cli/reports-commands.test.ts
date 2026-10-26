import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createIntakeHandler, startIntakeServer, type IntakeServer } from '../intake/index.js'
import { createReportsFeedHandler } from '../intake/reports-feed.js'
import { createMemoryRecordStore } from '../records/index.js'
import { createReports, type Reports } from '../reports/index.js'
import { runDoctorCommand } from './run-doctor-command.js'

// Команды `remontnik-doctor reports pull|ack`: то же, что HTTP, для забора по SSH.

const TOKEN = 'reports-token-for-tests'
let reports: Reports
let server: IntakeServer

beforeEach(async () => {
  reports = createReports({ store: createMemoryRecordStore() })
  server = await startIntakeServer({
    handler: createIntakeHandler({
      secret: 'watch-secret',
      receiveEvents: async () => ({ accepted: [] }),
      health: () => ({ ok: true }),
      reportsFeed: createReportsFeedHandler({ reports, access: { kind: 'token', token: TOKEN } }),
    }),
    host: '127.0.0.1',
    port: 0,
  })
  for (const short of ['первый', 'второй', 'третий']) await reports.add({ type: 'doctor_problem', short, telegram: 'not_needed' })
})

afterEach(async () => {
  await server.close()
})

async function run(argv: string[], env: Record<string, string | undefined> = { REMONTNIK_DOCTOR_URL: server.url, REMONTNIK_REPORTS_TOKEN: TOKEN }) {
  let out = ''
  let err = ''
  const code = await runDoctorCommand(argv, { env, stdout: (text) => (out += text), stderr: (text) => (err += text) })
  return { code, out, err }
}

describe('reports pull', () => {
  it('печатает отчёты после курсора одним JSON', async () => {
    const { code, out } = await run(['reports', 'pull', '--after', '1'])

    expect(code).toBe(0)
    const answer = JSON.parse(out)
    expect(answer.reports.map((report: { reportId: number }) => report.reportId)).toEqual([2, 3])
    expect(answer).toMatchObject({ last: 3, acked: 0 })
  })

  it('без --after берёт ленту с начала; --limit ограничивает страницу', async () => {
    const { out } = await run(['reports', 'pull', '--limit', '2'])

    expect(JSON.parse(out).reports.map((report: { reportId: number }) => report.reportId)).toEqual([1, 2])
  })

  it('кривой --after — ошибка использования, код 2, врачу запрос не уходит', async () => {
    const { code, err } = await run(['reports', 'pull', '--after', 'abc'])

    expect(code).toBe(2)
    expect(err).toContain('--after')
  })
})

describe('reports ack', () => {
  it('подтверждает номер и печатает итог', async () => {
    const { code, out } = await run(['reports', 'ack', '2'])

    expect(code).toBe(0)
    expect(JSON.parse(out)).toEqual({ ok: true, acked: 2 })
    expect(await reports.paseoAcked()).toBe(2)
  })

  it('номера дальше последнего отчёта врач не принимает — код 1 и причина', async () => {
    const { code, err } = await run(['reports', 'ack', '9'])

    expect(code).toBe(1)
    expect(err).toContain('400')
    expect(await reports.paseoAcked()).toBe(0)
  })

  it('не число — ошибка использования', async () => {
    expect((await run(['reports', 'ack', 'x'])).code).toBe(2)
    expect((await run(['reports', 'ack'])).code).toBe(2)
  })
})

describe('настройка и отказы', () => {
  it('чужой ключ — отказ 401, код 1, ключ в вывод не попадает', async () => {
    const { code, err, out } = await run(['reports', 'pull'], { REMONTNIK_DOCTOR_URL: server.url, REMONTNIK_REPORTS_TOKEN: 'wrong-token-value' })

    expect(code).toBe(1)
    expect(err).toContain('401')
    expect(err + out).not.toContain('wrong-token-value')
  })

  it('нет ключа или адреса — понятная ошибка с именем переменной', async () => {
    const noToken = await run(['reports', 'pull'], { REMONTNIK_DOCTOR_URL: server.url })
    const noUrl = await run(['reports', 'pull'], { REMONTNIK_REPORTS_TOKEN: TOKEN })

    expect([noToken.code, noUrl.code]).toEqual([1, 1])
    expect(noToken.err).toContain('REMONTNIK_REPORTS_TOKEN')
    expect(noUrl.err).toContain('REMONTNIK_DOCTOR_URL')
  })

  it('врач не отвечает — код 1 с сообщением', async () => {
    const { code, err } = await run(['reports', 'pull'], { REMONTNIK_DOCTOR_URL: 'http://127.0.0.1:1', REMONTNIK_REPORTS_TOKEN: TOKEN })

    expect(code).toBe(1)
    expect(err).toContain('remontnik-doctor')
  })

  it('неизвестная команда — код 2 и подсказка', async () => {
    const { code, err } = await run(['reports', 'wipe'])

    expect(code).toBe(2)
    expect(err).toContain('reports pull')
  })
})
