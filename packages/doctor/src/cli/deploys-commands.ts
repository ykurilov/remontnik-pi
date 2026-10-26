import { parseArgs } from 'node:util'
import { signRequest } from '@ykurilov/remontnik-core/signed-http'
import { UsageError, type DoctorCommandIo } from './command-io.js'

// `remontnik-doctor deploys stop|resume`: стоп-кран из консоли. Тот же подписанный `POST /v1/control/deploys`,
// что и у кнопки Telegram: общий секрет `REMONTNIK_SHARED_SECRET`, адрес `REMONTNIK_DOCTOR_URL`.

export const DEPLOYS_USAGE = `  remontnik-doctor deploys stop [--by <кто>]
  remontnik-doctor deploys resume [--by <кто>]
`

const REQUEST_TIMEOUT_MS = 30_000
const PATH = '/v1/control/deploys'

function requiredEnv(io: DoctorCommandIo, name: string): string {
  const value = io.env[name]
  if (!value) throw new Error(`не задана переменная ${name}`)
  return value
}

export async function deploysCommand(args: string[], io: DoctorCommandIo): Promise<number> {
  const [action, ...rest] = args
  if (action !== 'stop' && action !== 'resume') throw new UsageError(`неизвестная команда «deploys ${action ?? ''}»`.trimEnd())
  const {
    values: { by = 'console' },
  } = parseArgs({ args: rest, options: { by: { type: 'string' } } })
  const base = requiredEnv(io, 'REMONTNIK_DOCTOR_URL').replace(/\/+$/, '')
  const secret = requiredEnv(io, 'REMONTNIK_SHARED_SECRET')
  const body = JSON.stringify({ action, by })
  let response: Response
  try {
    response = await (io.fetch ?? fetch)(`${base}${PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...signRequest({ method: 'POST', target: PATH, body, secret }) },
      body,
      redirect: 'manual',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
  } catch {
    throw new Error('врач не отвечает по адресу из REMONTNIK_DOCTOR_URL')
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
