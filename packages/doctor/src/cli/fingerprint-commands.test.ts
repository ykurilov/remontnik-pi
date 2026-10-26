import { signRequest } from '@ykurilov/remontnik-core/signed-http'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createFingerprintReleaseHandler } from '../intake/fingerprint-release.js'
import { createIntakeHandler, startIntakeServer, type IntakeServer } from '../intake/index.js'
import { admitAutoDeployIn, readDeployAttempts, recordRollbackIn } from '../ledgers/fingerprint-ledger.js'
import { createMemoryRecordStore, type RecordStore } from '../records/index.js'
import { runDoctorCommand } from './run-doctor-command.js'

// `remontnik-doctor fingerprint <fp> release`: снять «нужен человек» после отката (FR-032). Снятие снова пускает
// автовыкатки по отпечатку, поэтому подписывается только секретом владельца, а не общим секретом приложения.

const SHARED = 'shared-secret-for-tests'
const OWNER = 'owner-secret-for-tests'
const FP = '0123456789abcdef'
const limits = { autoDeploysPerFingerprintPerDay: 2, autoDeploysPerDay: 5 }
let store: RecordStore
let server: IntakeServer

beforeEach(async () => {
  store = createMemoryRecordStore()
  await store.transaction(async (tx) => {
    await admitAutoDeployIn(tx, { fingerprint: FP, deploymentId: 1, at: Date.now() - 60_000, timeZone: 'UTC', limits })
    await recordRollbackIn(tx, { fingerprint: FP, deploymentId: 1, at: Date.now() })
  })
  server = await startIntakeServer({
    handler: createIntakeHandler({
      secret: SHARED,
      receiveEvents: async () => ({ accepted: [] }),
      health: () => ({ ok: true }),
      fingerprintRelease: createFingerprintReleaseHandler({ records: store, secret: SHARED, controlSecret: OWNER }),
    }),
    host: '127.0.0.1',
    port: 0,
  })
})

afterEach(async () => {
  await server.close()
})

async function run(argv: string[], env: Record<string, string | undefined> = { REMONTNIK_DOCTOR_URL: server.url, REMONTNIK_CONTROL_SECRET: OWNER }) {
  let out = ''
  let err = ''
  const code = await runDoctorCommand(argv, { env, stdout: (text) => (out += text), stderr: (text) => (err += text) })
  return { code, out, err }
}

const needsHuman = async () => (await readDeployAttempts(store, { fingerprint: FP, now: Date.now(), timeZone: 'UTC', limits })).needsHumanAfterRollback

describe('fingerprint <fp> release', () => {
  it('секрет владельца → пометка снята, кто снял — записано', async () => {
    expect(await needsHuman()).toBe(true)
    const { code, out } = await run(['fingerprint', FP, 'release', '--by', 'owner'])

    expect(code).toBe(0)
    expect(JSON.parse(out)).toEqual({ fingerprint: FP, needsHuman: false })
    expect(await needsHuman()).toBe(false)
    const ledger = await store.read<{ fingerprints: Record<string, { releasedBy?: string }> }>('ledger', 'main')
    expect(ledger?.fingerprints[FP]?.releasedBy).toBe('owner')
  })

  it('незнакомый отпечаток → отказ 404, учёт не тронут', async () => {
    const { code, err } = await run(['fingerprint', 'ffffffffffffffff', 'release'])

    expect(code).toBe(1)
    expect(err).toContain('404 unknown_fingerprint')
    expect(await needsHuman()).toBe(true)
  })

  it('без секрета владельца команда не идёт', async () => {
    const { code, err } = await run(['fingerprint', FP, 'release'], { REMONTNIK_DOCTOR_URL: server.url, REMONTNIK_SHARED_SECRET: SHARED })

    expect(code).toBe(1)
    expect(err).toContain('REMONTNIK_CONTROL_SECRET')
    expect(await needsHuman()).toBe(true)
  })

  it('неверный вид команды → справка и код 2', async () => {
    expect((await run(['fingerprint', FP])).code).toBe(2)
    expect((await run(['fingerprint', 'не отпечаток', 'release'])).code).toBe(2)
  })
})

describe('POST /v1/control/fingerprints', () => {
  async function post(body: unknown, secret: string, nonceHeaders?: Record<string, string>) {
    const text = JSON.stringify(body)
    const headers = nonceHeaders ?? signRequest({ method: 'POST', target: '/v1/control/fingerprints', body: text, secret })
    const response = await fetch(`${server.url}/v1/control/fingerprints`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: text })
    return { status: response.status, body: (await response.json()) as unknown, headers }
  }

  it('подпись общим секретом приложения → 403: снять пометку может только владелец', async () => {
    const answer = await post({ fingerprint: FP, action: 'release', by: 'app' }, SHARED)

    expect(answer).toMatchObject({ status: 403, body: { error: 'control_secret_required' } })
    expect(await needsHuman()).toBe(true)
  })

  it('чужая подпись → 401; повтор той же разовой метки → 401 replayed', async () => {
    expect((await post({ fingerprint: FP, action: 'release', by: 'x' }, 'wrong-secret')).status).toBe(401)
    const first = await post({ fingerprint: FP, action: 'release', by: 'owner' }, OWNER)
    expect(first.status).toBe(200)
    const again = await post({ fingerprint: FP, action: 'release', by: 'owner' }, OWNER, first.headers)
    expect(again).toMatchObject({ status: 401, body: { error: 'replayed' } })
  })

  it('секрет владельца совпадает с общим → обработчик не создаётся', () => {
    expect(() => createFingerprintReleaseHandler({ records: store, secret: SHARED, controlSecret: SHARED })).toThrow(/совпадает с общим/)
  })

  it('тело не по контракту → 400', async () => {
    expect((await post({ fingerprint: FP, action: 'forget', by: 'owner' }, OWNER)).status).toBe(400)
    expect((await post({ fingerprint: '', action: 'release', by: 'owner' }, OWNER)).status).toBe(400)
  })
})
