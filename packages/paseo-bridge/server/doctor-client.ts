import { NONCE_HEADER, signRequest, verifySignedResponse } from '@ykurilov/remontnik-core/signed-http'
import type { BridgeApp } from './bridge-config.js'

// Подписанные запросы моста к врачу (contracts/paseo-bridge.md, «Подпись»). Подпись запроса покрывает метод,
// путь с запросом и тело; ответ врача подписан и привязан к разовой метке запроса — без верной подписи ответа нет.
// По перенаправлениям мост не ходит: иначе подпись ушла бы на чужой адрес.

export const DOCTOR_TIMEOUT_MS = 10_000
export const DOCTOR_MAX_ANSWER_BYTES = 256 * 1024

export interface DoctorAnswer {
  status: number
  body: unknown
}

/** Ответ врача длиннее предела: подпись по нему проверить нельзя, но можно попросить меньше. */
export class DoctorAnswerTooLarge extends Error {
  constructor() {
    super('ответ врача слишком большой')
  }
}

export type FetchLike = typeof fetch

export class DoctorClient {
  constructor(
    private readonly target: BridgeApp,
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  get(pathWithQuery: string): Promise<DoctorAnswer> {
    return this.request('GET', pathWithQuery, '')
  }

  post(path: string, payload: unknown): Promise<DoctorAnswer> {
    return this.request('POST', path, JSON.stringify(payload))
  }

  private async request(method: 'GET' | 'POST', path: string, body: string): Promise<DoctorAnswer> {
    const signature = signRequest({ method, target: path, body, secret: this.target.secret })
    const response = await this.fetchImpl(`${this.target.doctorUrl}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...signature },
      ...(method === 'POST' ? { body } : {}),
      redirect: 'manual',
      signal: AbortSignal.timeout(DOCTOR_TIMEOUT_MS),
    })
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel()
      throw new Error(`врач ответил перенаправлением ${response.status}`)
    }
    const text = await readLimited(response)
    const check = verifySignedResponse({
      request: { method, target: path, nonce: signature[NONCE_HEADER] },
      status: response.status,
      body: text,
      headers: response.headers,
      secret: this.target.secret,
    })
    if (!check.ok) throw new Error(`подпись ответа врача не прошла проверку (${check.reason})`)
    let parsed: unknown = null
    try {
      parsed = text === '' ? null : JSON.parse(text)
    } catch {
      parsed = { error: 'doctor_bad_json' }
    }
    return { status: response.status, body: parsed }
  }
}

async function readLimited(response: Response): Promise<string> {
  if (!response.body) return ''
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > DOCTOR_MAX_ANSWER_BYTES) {
      await reader.cancel()
      throw new DoctorAnswerTooLarge()
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks).toString('utf8')
}
