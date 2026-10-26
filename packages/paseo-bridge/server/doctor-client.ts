import { signBody } from '@ykurilov/remontnik-core/signed-http'
import type { BridgeApp } from './bridge-config.js'

// Подписанные запросы моста к врачу. Тело POST подписывается как есть, у GET — строка `GET <путь с запросом>`.

export const DOCTOR_TIMEOUT_MS = 10_000

export interface DoctorAnswer {
  status: number
  body: unknown
}

export type FetchLike = typeof fetch

export function signedTarget(method: 'GET', pathWithQuery: string): string {
  return `${method} ${pathWithQuery}`
}

export class DoctorClient {
  constructor(
    private readonly target: BridgeApp,
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  get(pathWithQuery: string): Promise<DoctorAnswer> {
    return this.request('GET', pathWithQuery, undefined)
  }

  post(path: string, payload: unknown): Promise<DoctorAnswer> {
    return this.request('POST', path, JSON.stringify(payload))
  }

  private async request(method: 'GET' | 'POST', path: string, body: string | undefined): Promise<DoctorAnswer> {
    const signed = body ?? signedTarget('GET', path)
    const response = await this.fetchImpl(`${this.target.doctorUrl}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...signBody(signed, this.target.secret) },
      ...(body === undefined ? {} : { body }),
      signal: AbortSignal.timeout(DOCTOR_TIMEOUT_MS),
    })
    const text = await response.text()
    let parsed: unknown = null
    try {
      parsed = text === '' ? null : JSON.parse(text)
    } catch {
      parsed = { error: 'doctor_bad_json' }
    }
    return { status: response.status, body: parsed }
  }
}
