import type { ReplayGuard } from '@ykurilov/remontnik-core/signed-http'
import { releaseFingerprint } from '../ledgers/fingerprint-ledger.js'
import type { RecordStore } from '../records/index.js'
import type { IntakeHandler } from './http-kit.js'
import { createOwnerCommandHandler, parseBy } from './owner-command.js'

// Снятие «нужен человек» по HTTP (contracts/doctor-api.md): `POST /v1/control/fingerprints`
// `{ fingerprint, action: "release", by }` → `{ fingerprint, needsHuman }`. Снятие снова пускает автовыкатки по отпечатку,
// поэтому подписывается только секретом владельца `REMONTNIK_CONTROL_SECRET`: общий секрет есть у приложения.

/** Отпечаток сбоя (`fingerprint()` ядра) — 16 шестнадцатеричных знаков; запас под другие длины. */
export const FINGERPRINT_FORMAT = /^[0-9a-f]{8,64}$/

export interface FingerprintReleaseOptions {
  records: RecordStore
  /** Общий секрет: им подписанный запрос узнаётся, но не исполняется. */
  secret: string
  /** Секрет владельца; не задан — снять пометку по HTTP нельзя. */
  controlSecret?: string
  replayGuard?: ReplayGuard
  bodyTimeoutMs?: number
  now?: () => number
}

export function createFingerprintReleaseHandler(options: FingerprintReleaseOptions): IntakeHandler {
  const now = options.now ?? Date.now
  return createOwnerCommandHandler({
    ...options,
    parse(body) {
      const { fingerprint, action, by } = (body ?? {}) as { fingerprint?: unknown; action?: unknown; by?: unknown }
      const who = parseBy(by)
      if (action !== 'release' || typeof fingerprint !== 'string' || !FINGERPRINT_FORMAT.test(fingerprint) || !who) return undefined
      return { fingerprint, by: who }
    },
    async run({ fingerprint, by }) {
      const released = await releaseFingerprint(options.records, { fingerprint, by, at: now() })
      if (!released.found) return { status: 404, body: { error: 'unknown_fingerprint' } }
      return { status: 200, body: { fingerprint, needsHuman: released.needsHuman } }
    },
  })
}
