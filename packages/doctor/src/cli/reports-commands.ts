import { parseArgs } from 'node:util'
import { UsageError, type DoctorCommandIo } from './command-io.js'

// `remontnik-doctor reports pull|ack`: то же, что HTTP-адреса ленты отчётов, для забора по SSH, когда моста нет.
// Ходят на основной адрес врача по ключу владельца (`REMONTNIK_REPORTS_TOKEN`); сам ключ в вывод не попадает.

export const REPORTS_USAGE = `  remontnik-doctor reports pull [--after <номер отчёта>] [--limit <сколько>]
  remontnik-doctor reports ack <номер отчёта>
`

const REQUEST_TIMEOUT_MS = 30_000

function requiredEnv(io: DoctorCommandIo, name: string): string {
  const value = io.env[name]
  if (!value) throw new Error(`не задана переменная ${name}`)
  return value
}

function wholeNumber(text: string | undefined, what: string): number {
  if (text === undefined || !/^\d{1,15}$/.test(text)) throw new UsageError(`${what} — целое число, ноль или больше`)
  return Number(text)
}

async function call(io: DoctorCommandIo, method: 'GET' | 'POST', path: string, payload?: unknown): Promise<number> {
  const base = requiredEnv(io, 'REMONTNIK_DOCTOR_URL').replace(/\/+$/, '')
  const token = requiredEnv(io, 'REMONTNIK_REPORTS_TOKEN')
  let response: Response
  try {
    response = await (io.fetch ?? fetch)(`${base}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(payload === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
      redirect: 'manual',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
  } catch {
    throw new Error(`врач не отвечает по адресу из REMONTNIK_DOCTOR_URL`)
  }
  const text = await response.text()
  if (!response.ok) {
    let code = `HTTP ${response.status}`
    try {
      code = String((JSON.parse(text) as { error?: unknown }).error ?? code)
    } catch {}
    io.stderr(`remontnik-doctor: отказ (${response.status} ${code})\n`)
    return 1
  }
  io.stdout(`${text}\n`)
  return 0
}

export async function reportsCommand(args: string[], io: DoctorCommandIo): Promise<number> {
  const [action, ...rest] = args
  if (action === 'pull') {
    const { values } = parseArgs({ args: rest, options: { after: { type: 'string' }, limit: { type: 'string' } } })
    const after = values.after === undefined ? 0 : wholeNumber(values.after, '--after')
    const query = new URLSearchParams({ after: String(after) })
    if (values.limit !== undefined) query.set('limit', String(wholeNumber(values.limit, '--limit')))
    return call(io, 'GET', `/v1/reports?${query}`)
  }
  if (action === 'ack') {
    const { positionals } = parseArgs({ args: rest, allowPositionals: true, options: {} })
    return call(io, 'POST', '/v1/reports/ack', { upTo: wholeNumber(positionals[0], 'номер отчёта') })
  }
  throw new UsageError(`неизвестная команда «reports ${action ?? ''}»`.trimEnd())
}
