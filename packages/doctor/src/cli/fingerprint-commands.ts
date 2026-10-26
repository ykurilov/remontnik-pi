import { parseArgs } from 'node:util'
import { FINGERPRINT_FORMAT } from '../intake/fingerprint-release.js'
import { UsageError, type DoctorCommandIo } from './command-io.js'
import { postOwnerCommand } from './owner-command.js'

// `remontnik-doctor fingerprint <fp> release`: снять «нужен человек» после отката (FR-032). Подписанный
// `POST /v1/control/fingerprints` на `REMONTNIK_DOCTOR_URL`, только секретом владельца `REMONTNIK_CONTROL_SECRET`.

export const FINGERPRINT_USAGE = `  remontnik-doctor fingerprint <отпечаток> release [--by <кто>]
`

export async function fingerprintCommand(args: string[], io: DoctorCommandIo): Promise<number> {
  const [fingerprint, action, ...rest] = args
  if (action !== 'release') throw new UsageError(`неизвестная команда «fingerprint ${fingerprint ?? ''} ${action ?? ''}»`.trimEnd())
  if (fingerprint === undefined || !FINGERPRINT_FORMAT.test(fingerprint)) throw new UsageError('отпечаток — строчные шестнадцатеричные знаки, как в отчёте')
  const {
    values: { by = 'console' },
  } = parseArgs({ args: rest, options: { by: { type: 'string' } } })
  return postOwnerCommand(io, '/v1/control/fingerprints', { fingerprint, action, by })
}
