import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { dockerCreateArgs } from '../../src/workbench/runner.js'

// Срок жизни контейнера верстака без врача: контейнер запущен, а `docker start --attach` (врач) не ждёт его.
// Обёртка сама убивает всё внутри по сроку, даже если команда прячется в фоне и убивает сторожевые `sleep`.

const IMAGE = 'node:22-bookworm-slim@sha256:de170b39439eb0e5a3444ad7d60b015614a381e10fecae2e30ec9e735122f38d'
const dockerReady = spawnSync('docker', ['info'], { stdio: 'ignore' }).status === 0
const root = realpathSync(mkdtempSync(join(tmpdir(), 'remontnik-lifetime-')))
const names: string[] = []

afterAll(() => {
  for (const name of names) spawnSync('docker', ['rm', '-f', name], { stdio: 'ignore' })
  rmSync(root, { recursive: true, force: true })
})

function container(command: string, lifetimeSeconds: number): string {
  const name = `remontnik-lifetime-${names.length}-${process.pid}`
  names.push(name)
  const copyDir = join(root, `copy-${names.length}`)
  const home = join(root, `home-${names.length}`)
  mkdirSync(copyDir)
  mkdirSync(home)
  const envFile = join(root, `env-${names.length}`)
  writeFileSync(envFile, '')
  const args = dockerCreateArgs({ name, image: IMAGE, copyDir, home, workdir: copyDir, writableDirs: [], network: 'none', envFile, memory: '256m', cpus: '0.5', command, lifetimeSeconds, user: `${process.getuid!()}:${process.getgid!()}` })
  const created = spawnSync('docker', args.filter((arg) => arg !== '--rm'), { encoding: 'utf8' })
  expect(created.status, created.stderr).toBe(0)
  expect(spawnSync('docker', ['start', name]).status).toBe(0)
  return name
}

function state(name: string): { running: boolean; exitCode: number } {
  const answer = spawnSync('docker', ['inspect', '--format', '{{.State.Running}} {{.State.ExitCode}}', name], { encoding: 'utf8' }).stdout.trim().split(' ')
  return { running: answer[0] === 'true', exitCode: Number(answer[1]) }
}

async function until(check: () => boolean, ms: number): Promise<void> {
  const deadline = Date.now() + ms
  while (!check()) {
    if (Date.now() > deadline) throw new Error('не дождались')
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
}

describe.skipIf(!dockerReady)('срок жизни контейнера верстака', () => {
  it('врача нет: по сроку всё внутри убито, контейнер кончился', async () => {
    const started = Date.now()
    const name = container('(sleep 300) & sleep 300 & for p in /proc/[0-9]*; do [ "$(cat $p/comm)" = sleep ] && kill -9 ${p#/proc/} 2>/dev/null; done; kill -9 1; sleep 300', 3)
    await until(() => !state(name).running, 30_000)
    expect(state(name).exitCode).toBe(137)
    expect(Date.now() - started).toBeLessThan(15_000)
  })

  it('команда кончилась раньше срока — её код выхода', async () => {
    const name = container('echo готово; exit 3', 60)
    await until(() => !state(name).running, 30_000)
    expect(state(name).exitCode).toBe(3)
  })
})
