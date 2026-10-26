import { randomBytes } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { DEMO_LOGIN, DEMO_PASSWORD } from '../../../../apps/patient/src/auth/sessions.ts'
import { startBrowserService } from '../../src/service/start.js'
import { loginVaultPath, openLoginVault } from '../../src/vault/index.js'

export { DEMO_LOGIN, DEMO_PASSWORD }

export const PROFILE = 'remontnik'
export const OWNER_TOKEN = `owner-${randomBytes(12).toString('hex')}`
export const VIEWPORT = { width: 1280, height: 800 }

export interface BrowserResult {
  ok: boolean
  code?: string
  message?: string
  url?: string
  title?: string
  snapshot?: string
  path?: string
  state?: string
  logins?: Array<{ id: number; site: string; login: string; profile: string }>
}

/** Своя служба браузера на тест: свои данные, свой профиль, сохранённый вход «Пациента». */
export async function startTestBrowser(options: { live?: boolean } = {}) {
  const patientUrl = process.env.PATIENT_URL
  if (!patientUrl) throw new Error('PATIENT_URL не задан: «Пациент» не запущен')
  const dataDir = mkdtempSync(join(tmpdir(), 'remontnik-browser-e2e-'))
  const vaultKey = randomBytes(32)
  const vault = openLoginVault({ file: loginVaultPath(dataDir), key: vaultKey })
  const entry = await vault.add({ site: patientUrl, login: DEMO_LOGIN, profile: PROFILE }, Readable.from([Buffer.from(DEMO_PASSWORD)]))
  const foreignEntry = await vault.add({ site: 'https://elsewhere.invalid', login: DEMO_LOGIN, profile: PROFILE }, Readable.from([Buffer.from('foreign-site-password')]))

  const logs: string[] = []
  const outputs: string[] = []
  const token = randomBytes(24).toString('hex')
  const service = await startBrowserService({
    token,
    vaultKey,
    dataDir,
    policy: {
      allowedOrigins: [patientUrl],
      allowedMutations: [
        { method: 'POST', pathPattern: '/login' },
        { method: 'POST', pathPattern: '/api/chat' },
      ],
      profiles: [{ name: PROFILE, viewport: VIEWPORT }],
    },
    listen: { host: '127.0.0.1', port: 0 },
    live: options.live ? { listen: { host: '127.0.0.1', port: 0 }, ownerToken: OWNER_TOKEN } : null,
    log: (line) => logs.push(line),
  })

  async function call(command: string, body: Record<string, unknown> = {}): Promise<BrowserResult> {
    const response = await fetch(`${service.url}/v1/${command}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(command === 'logins' ? body : { profile: PROFILE, ...body }),
    })
    const text = await response.text()
    outputs.push(text)
    return JSON.parse(text) as BrowserResult
  }

  return { patientUrl, dataDir, entryId: entry.id, foreignEntryId: foreignEntry.id, call, logs, outputs, service, close: () => service.close() }
}

/** Номер элемента по роли и имени из снимка; пустое имя — элемент без подписи. */
export function refOf(snapshot: string | undefined, role: string, name: string): string {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const label = name === '' ? '' : ` "${escaped}"`
  const match = new RegExp(`- ${role}${label} [^\\n]*?\\[ref=(\\w+)\\]`).exec(snapshot ?? '')
  if (!match?.[1]) throw new Error(`нет ${role} «${name}» в снимке:\n${snapshot}`)
  return match[1]
}

export function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1
}
