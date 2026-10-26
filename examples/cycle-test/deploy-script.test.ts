import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// Повторы команд выкатки образца: врач может повторить `promote` и `rollback` после своего перезапуска.

const appRoot = fileURLToPath(new URL('../mini-app', import.meta.url))
const A = 'a'.repeat(40)
const B = 'b'.repeat(40)

const FAKE_APP = `import { createServer } from 'node:http'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
const version = process.env.REMONTNIK_VERSION
if (existsSync(join(process.env.APP_DEPLOY_DIR, 'fail-' + version))) process.exit(1)
createServer((request, response) => {
  response.writeHead(200, { 'content-type': 'application/json' })
  response.end(request.url === '/version' ? JSON.stringify({ version }) : '{}')
}).listen(Number(process.env.PORT), process.env.HOST)
`

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer()
    probe.listen(0, '127.0.0.1', () => {
      const port = (probe.address() as { port: number }).port
      probe.close(() => resolve(port))
    })
    probe.on('error', reject)
  })
}

async function stand(onTestFinished: (callback: () => void) => void) {
  const root = mkdtempSync(join(tmpdir(), 'example-deploy-'))
  const deployDir = join(root, 'deploy-state')
  mkdirSync(deployDir)
  const fakeApp = join(root, 'fake-app.mjs')
  writeFileSync(fakeApp, FAKE_APP)
  writeFileSync(join(deployDir, 'settings.json'), JSON.stringify({ healthUrl: `http://127.0.0.1:${await freePort()}`, entry: fakeApp, startupTimeoutMs: 3000 }))
  const env = { ...process.env, APP_DEPLOY_DIR: deployDir }
  const script = join(appRoot, 'deploy/remontnik-deploy.mjs')
  const run = (command: string, version?: string) =>
    spawnSync('node', [script, command], { cwd: appRoot, env: { ...env, ...(version ? { REMONTNIK_VERSION: version } : {}) }, encoding: 'utf8' })
  const ok = (command: string, version?: string) => {
    const result = run(command, version)
    if (result.status !== 0) throw new Error(`${command}: ${result.stderr}`)
    return result.stdout
  }
  const state = () => JSON.parse(readFileSync(join(deployDir, 'state.json'), 'utf8')) as { version: string; previous: string | null; pid: number | null }
  onTestFinished(() => {
    try {
      const { pid } = state()
      if (pid) process.kill(pid, 'SIGKILL')
    } catch {}
    rmSync(root, { recursive: true, force: true })
  })
  return { deployDir, run, ok, state }
}

describe('команды выкатки образца', () => {
  it('повторный promote той же версии не затирает прежнюю', async ({ onTestFinished }) => {
    const s = await stand(onTestFinished)
    s.ok('build', A)
    s.ok('promote')
    s.ok('build', B)
    s.ok('promote')
    expect(s.state().previous).toBe(A)
    s.ok('promote')
    expect(s.state()).toMatchObject({ version: B, previous: A })
  })

  it('rollback, который не удался, можно повторить', async ({ onTestFinished }) => {
    const s = await stand(onTestFinished)
    s.ok('build', A)
    s.ok('promote')
    s.ok('build', B)
    s.ok('promote')
    writeFileSync(join(s.deployDir, `fail-${A}`), '')
    expect(s.run('rollback').status).not.toBe(0)
    rmSync(join(s.deployDir, `fail-${A}`))
    s.ok('rollback')
    expect(JSON.parse(s.ok('current'))).toMatchObject({ version: A })
    expect(s.state().previous).toBeNull()
  })

  it('без APP_DEPLOY_DIR отказывает понятной ошибкой', () => {
    const env = { ...process.env }
    delete env.APP_DEPLOY_DIR
    const result = spawnSync('node', [join(appRoot, 'deploy/remontnik-deploy.mjs'), 'current'], { cwd: appRoot, env, encoding: 'utf8' })
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('APP_DEPLOY_DIR')
  })

  it('ручная выкатка берёт общий замок и отказывает, если он занят', async ({ onTestFinished }) => {
    const s = await stand(onTestFinished)
    const lock = join(s.deployDir, 'deploy.lock')
    writeFileSync(join(s.deployDir, 'settings.json'), JSON.stringify({ ...JSON.parse(readFileSync(join(s.deployDir, 'settings.json'), 'utf8')), lockFile: lock }))
    writeFileSync(lock, 'чужой замок')
    const busy = spawnSync('node', [join(appRoot, 'deploy/remontnik-deploy.mjs'), 'deploy', A], { cwd: appRoot, env: { ...process.env, APP_DEPLOY_DIR: s.deployDir }, encoding: 'utf8' })
    expect(busy.status).not.toBe(0)
    expect(readFileSync(lock, 'utf8')).toBe('чужой замок')
    rmSync(lock)
    execFileSync('node', [join(appRoot, 'deploy/remontnik-deploy.mjs'), 'deploy', A], { cwd: appRoot, env: { ...process.env, APP_DEPLOY_DIR: s.deployDir } })
    expect(existsSync(lock)).toBe(false)
    expect(JSON.parse(s.ok('current'))).toMatchObject({ version: A })
  })
})
