import { parseArgs } from 'node:util'
import { signRequest } from '@ykurilov/remontnik-core/signed-http'
import { UsageError, type DoctorCommandIo } from './command-io.js'

// `remontnik-doctor deploys stop|resume|confirm`: стоп-кран из консоли. Тот же подписанный `POST /v1/control/deploys`,
// что и у кнопки Telegram, адрес `REMONTNIK_DOCTOR_URL`. Пуск и подтверждение версии брошенной выкатки
// подписываются только секретом владельца `REMONTNIK_CONTROL_SECRET`; стоп — им же, а без него общим секретом
// `REMONTNIK_SHARED_SECRET`.

export const DEPLOYS_USAGE = `  remontnik-doctor deploys stop [--by <кто>]
  remontnik-doctor deploys resume [--by <кто>]
  remontnik-doctor deploys confirm <версия> [--by <кто>]
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
  if (action !== 'stop' && action !== 'resume' && action !== 'confirm') throw new UsageError(`неизвестная команда «deploys ${action ?? ''}»`.trimEnd())
  const {
    values: { by = 'console' },
    positionals,
  } = parseArgs({ args: rest, options: { by: { type: 'string' } }, allowPositionals: action === 'confirm' })
  const version = positionals[0]
  if (action === 'confirm' && (version === undefined || positionals.length > 1)) throw new UsageError('нужна одна версия: deploys confirm <версия>')
  const base = requiredEnv(io, 'REMONTNIK_DOCTOR_URL').replace(/\/+$/, '')
  const secret =
    action === 'stop' ? io.env.REMONTNIK_CONTROL_SECRET || io.env.REMONTNIK_SHARED_SECRET : requiredEnv(io, 'REMONTNIK_CONTROL_SECRET')
  if (!secret) throw new Error('не задана переменная REMONTNIK_CONTROL_SECRET или REMONTNIK_SHARED_SECRET')
  const body = JSON.stringify(action === 'confirm' ? { action: 'confirm_version', version, by } : { action, by })
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
