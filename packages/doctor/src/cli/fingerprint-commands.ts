import { parseArgs } from 'node:util'
import { signRequest } from '@ykurilov/remontnik-core/signed-http'
import { FINGERPRINT_FORMAT } from '../intake/fingerprint-release.js'
import { UsageError, type DoctorCommandIo } from './command-io.js'

// `remontnik-doctor fingerprint <fp> release`: снять «нужен человек» после отката (FR-032). Подписанный
// `POST /v1/control/fingerprints` на `REMONTNIK_DOCTOR_URL`, только секретом владельца `REMONTNIK_CONTROL_SECRET`.

export const FINGERPRINT_USAGE = `  remontnik-doctor fingerprint <отпечаток> release [--by <кто>]
`

const REQUEST_TIMEOUT_MS = 30_000
const PATH = '/v1/control/fingerprints'

function requiredEnv(io: DoctorCommandIo, name: string): string {
  const value = io.env[name]
  if (!value) throw new Error(`не задана переменная ${name}`)
  return value
}

export async function fingerprintCommand(args: string[], io: DoctorCommandIo): Promise<number> {
  const [fingerprint, action, ...rest] = args
  if (action !== 'release') throw new UsageError(`неизвестная команда «fingerprint ${fingerprint ?? ''} ${action ?? ''}»`.trimEnd())
  if (fingerprint === undefined || !FINGERPRINT_FORMAT.test(fingerprint)) throw new UsageError('отпечаток — строчные шестнадцатеричные знаки, как в отчёте')
  const {
    values: { by = 'console' },
  } = parseArgs({ args: rest, options: { by: { type: 'string' } } })
  const base = requiredEnv(io, 'REMONTNIK_DOCTOR_URL').replace(/\/+$/, '')
  const secret = requiredEnv(io, 'REMONTNIK_CONTROL_SECRET')
  const body = JSON.stringify({ fingerprint, action, by })
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
