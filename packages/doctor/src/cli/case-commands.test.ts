import { signRequest } from '@ykurilov/remontnik-core/signed-http'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createCaseRetryHandler, type CaseRetryAnswer } from '../intake/case-retry.js'
import { createIntakeHandler, startIntakeServer, type IntakeServer } from '../intake/index.js'
import { runDoctorCommand } from './run-doctor-command.js'

// `remontnik-doctor case <номер> retry`: снова поставить в работу случай, чьё лечение упало. Повтор тратит модель
// и может кончиться выкаткой, поэтому подписывается только секретом владельца.

const SHARED = 'shared-secret-for-tests'
const OWNER = 'owner-secret-for-tests'
let server: IntakeServer
let asked: { caseId: number; by: string }[]
let answer: CaseRetryAnswer

beforeEach(async () => {
  asked = []
  answer = { retried: 'restarted', attempt: 2 }
  server = await startIntakeServer({
    handler: createIntakeHandler({
      secret: SHARED,
      receiveEvents: async () => ({ accepted: [] }),
      health: () => ({ ok: true }),
      caseRetry: createCaseRetryHandler({
        secret: SHARED,
        controlSecret: OWNER,
        async retryCase(caseId, by) {
          asked.push({ caseId, by })
          return answer
        },
      }),
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

describe('case <номер> retry', () => {
  it('секрет владельца → врач ставит случай в работу и отвечает, какая это попытка', async () => {
    const { code, out } = await run(['case', '7', 'retry', '--by', 'owner'])

    expect(code).toBe(0)
    expect(JSON.parse(out)).toEqual({ caseId: 7, retried: 'restarted', attempt: 2 })
    expect(asked).toEqual([{ caseId: 7, by: 'owner' }])
  })

  it('незнакомый случай → 404, законченный или ещё идущий → 409 с причиной', async () => {
    answer = { error: 'unknown_case' }
    expect((await run(['case', '9', 'retry'])).err).toContain('404 unknown_case')
    answer = { error: 'case_finished', state: 'healed' }
    const finished = await run(['case', '1', 'retry'])
    expect(finished.code).toBe(1)
    expect(finished.err).toContain('409 case_finished')
  })

  it('без секрета владельца команда не идёт', async () => {
    const { code, err } = await run(['case', '1', 'retry'], { REMONTNIK_DOCTOR_URL: server.url, REMONTNIK_SHARED_SECRET: SHARED })

    expect(code).toBe(1)
    expect(err).toContain('REMONTNIK_CONTROL_SECRET')
    expect(asked).toEqual([])
  })

  it('неверный вид команды → справка и код 2', async () => {
    expect((await run(['case', '1'])).code).toBe(2)
    expect((await run(['case', 'первый', 'retry'])).code).toBe(2)
    expect((await run(['case', '0', 'retry'])).code).toBe(2)
  })
})

describe('POST /v1/control/cases', () => {
  async function post(body: unknown, secret: string) {
    const text = JSON.stringify(body)
    const headers = signRequest({ method: 'POST', target: '/v1/control/cases', body: text, secret })
    const response = await fetch(`${server.url}/v1/control/cases`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: text })
    return { status: response.status, body: (await response.json()) as unknown }
  }

  it('подпись общим секретом приложения → 403: повторить лечение может только владелец', async () => {
    expect(await post({ caseId: 1, action: 'retry', by: 'app' }, SHARED)).toMatchObject({ status: 403, body: { error: 'control_secret_required' } })
    expect(asked).toEqual([])
  })

  it('тело не по контракту → 400', async () => {
    expect((await post({ caseId: 1, action: 'forget', by: 'owner' }, OWNER)).status).toBe(400)
    expect((await post({ caseId: '1', action: 'retry', by: 'owner' }, OWNER)).status).toBe(400)
    expect((await post({ caseId: 0, action: 'retry', by: 'owner' }, OWNER)).status).toBe(400)
    expect(asked).toEqual([])
  })
})
