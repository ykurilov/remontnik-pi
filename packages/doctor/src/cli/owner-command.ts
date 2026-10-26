import { signRequest } from '@ykurilov/remontnik-core/signed-http'
import type { DoctorCommandIo } from './command-io.js'

// Команда владельца врачу: подписанный `POST` на `REMONTNIK_DOCTOR_URL`, только секретом владельца
// `REMONTNIK_CONTROL_SECRET`. Ответ врача — в вывод; отказ — кодом ошибки, без тела.

const REQUEST_TIMEOUT_MS = 30_000

function requiredEnv(io: DoctorCommandIo, name: string): string {
  const value = io.env[name]
  if (!value) throw new Error(`не задана переменная ${name}`)
  return value
}

export async function postOwnerCommand(io: DoctorCommandIo, path: string, command: Record<string, unknown>): Promise<number> {
  const base = requiredEnv(io, 'REMONTNIK_DOCTOR_URL').replace(/\/+$/, '')
  const secret = requiredEnv(io, 'REMONTNIK_CONTROL_SECRET')
  const body = JSON.stringify(command)
  let response: Response
  try {
    response = await (io.fetch ?? fetch)(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...signRequest({ method: 'POST', target: path, body, secret }) },
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
