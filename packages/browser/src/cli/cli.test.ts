import { randomBytes } from 'node:crypto'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { runBrowserCli } from './index.js'

const PASSWORD = 'cli-test-password-31'

function cliEnvironment() {
  const dataDir = mkdtempSync(join(tmpdir(), 'remontnik-browser-cli-'))
  return {
    dataDir,
    env: { REMONTNIK_BROWSER_DATA_DIR: dataDir, REMONTNIK_BROWSER_VAULT_KEY: randomBytes(32).toString('base64') },
  }
}

async function run(argv: string[], env: Record<string, string>, stdinText = '', fetchImpl?: typeof fetch) {
  let stdout = ''
  let stderr = ''
  const code = await runBrowserCli(argv, {
    env,
    stdin: Readable.from([Buffer.from(stdinText)]),
    stdout: (text) => (stdout += text),
    stderr: (text) => (stderr += text),
    ...(fetchImpl ? { fetch: fetchImpl } : {}),
  })
  return { code, stdout, stderr }
}

describe('консольная remontnik-browser', () => {
  it('logins add читает пароль только из стандартного ввода', async () => {
    const { env, dataDir } = cliEnvironment()
    const added = await run(
      ['logins', 'add', '--site', 'https://app.example.com', '--login', 'bot@example.com', '--profile', 'remontnik', '--password-stdin'],
      env,
      `${PASSWORD}\n`,
    )
    expect(added.code).toBe(0)
    expect(added.stdout + added.stderr).not.toContain(PASSWORD)
    expect(readFileSync(join(dataDir, 'logins.json'), 'utf8')).not.toContain(PASSWORD)

    const listed = await run(['logins', 'list'], env)
    expect(JSON.parse(listed.stdout)).toEqual({ logins: [{ id: 1, site: 'https://app.example.com', login: 'bot@example.com', profile: 'remontnik' }] })
  })

  it('пароль в аргументах не принимается', async () => {
    const { env } = cliEnvironment()
    const withArgument = await run(
      ['logins', 'add', '--site', 'https://app.example.com', '--login', 'bot@example.com', '--profile', 'remontnik', '--password', PASSWORD],
      env,
    )
    expect(withArgument.code).not.toBe(0)
    expect(withArgument.stderr).toMatch(/--password-stdin/)
    expect(withArgument.stderr).not.toContain(PASSWORD)

    const withoutFlag = await run(['logins', 'add', '--site', 'https://app.example.com', '--login', 'bot@example.com', '--profile', 'remontnik'], env, PASSWORD)
    expect(withoutFlag.code).not.toBe(0)
    expect((await run(['logins', 'list'], env)).stdout).toContain('"logins":[]')
  })

  it('logins remove удаляет вход по номеру', async () => {
    const { env } = cliEnvironment()
    await run(['logins', 'add', '--site', 'https://app.example.com', '--login', 'a@example.com', '--profile', 'remontnik', '--password-stdin'], env, PASSWORD)
    expect((await run(['logins', 'remove', '1'], env)).code).toBe(0)
    expect((await run(['logins', 'remove', '1'], env)).code).not.toBe(0)
  })

  it('команды страницы идут в службу с ключом врача; профиль обязателен', async () => {
    const { env } = cliEnvironment()
    const requests: Array<{ url: string; body: unknown; authorization: string | null }> = []
    const fakeFetch = (async (url: string, init: RequestInit) => {
      requests.push({ url, body: JSON.parse(String(init.body)), authorization: new Headers(init.headers).get('authorization') })
      return new Response(JSON.stringify({ ok: true, url: 'https://app.example.com/', title: 'x', snapshot: '- generic' }))
    }) as typeof fetch
    const serviceEnv = { ...env, REMONTNIK_BROWSER_TOKEN: 'doctor-test-0123', REMONTNIK_BROWSER_URL: 'http://127.0.0.1:7700' }

    expect((await run(['read'], serviceEnv, '', fakeFetch)).code).not.toBe(0)
    const read = await run(['read', '-p', 'remontnik'], serviceEnv, '', fakeFetch)
    expect(read.code).toBe(0)
    await run(['click', '-p', 'remontnik', '--ref', 'e5', '--danger', 'submit'], serviceEnv, '', fakeFetch)
    await run(['url', '-p', 'remontnik', 'https://app.example.com/chat'], serviceEnv, '', fakeFetch)
    expect(requests).toEqual([
      { url: 'http://127.0.0.1:7700/v1/read', body: { profile: 'remontnik' }, authorization: 'Bearer doctor-test-0123' },
      { url: 'http://127.0.0.1:7700/v1/click', body: { profile: 'remontnik', ref: 'e5', danger: 'submit' }, authorization: 'Bearer doctor-test-0123' },
      { url: 'http://127.0.0.1:7700/v1/url', body: { profile: 'remontnik', url: 'https://app.example.com/chat' }, authorization: 'Bearer doctor-test-0123' },
    ])
  })
})
