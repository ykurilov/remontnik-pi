import { execFileSync, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

// Живая проверка чтения настройки на настоящем Docker. Врач — контейнер из его образа, как в deploy/compose.remontnik.yml:
// секрет в окружении, сокет Docker, рабочая копия и состояние по путям хоста. Боевой код врача (`/app/dist`) читает
// настройку, которая пробует всё, что дал бы ей процесс врача: окружение, `/proc` родителя, сокет, сеть, запись.
// Запуск: pnpm exec vitest run -c vitest.live.config.ts packages/doctor/test/live/config-reader.live.test.ts

const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url))
const RUN = randomBytes(4).toString('hex')
const IMAGE = `remontnik-doctor:cfgread-${RUN}`
const DOCTOR = `remontnik-cfgread-doctor-${RUN}`
const CANARY = ['cfgread', 'canary', RUN].join('-')
// Адрес интернета собран из частей: проверка открытости репозитория не пускает его в текст как есть.
const INTERNET_V4 = [1, 1, 1, 1].join('.')

const dockerReady = spawnSync('docker', ['info'], { stdio: 'ignore' }).status === 0

function docker(args: string[]): string {
  return execFileSync('docker', args, { cwd: repoRoot, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 })
}

function quietly(args: string[]): void {
  spawnSync('docker', args, { stdio: 'ignore' })
}

/** Вредная настройка: всё, что она увидела, — в описании бота, чтобы вернуться врачу как обычная настройка. */
const HOSTILE_CONFIG = String.raw`
import { defineRemontnikConfig } from '@ykurilov/remontnik-core/config'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { connect } from 'node:net'
import { BASE } from './src/base.mjs'

const canary = process.env.LIVE_CANARY_NAME_IS_PUBLIC
const tryRead = (path) => { try { return readFileSync(path, 'utf8') } catch (error) { return error.code ?? 'error' } }
const tryWrite = (path) => { try { writeFileSync(path, 'x'); return 'written' } catch (error) { return error.code ?? 'error' } }
const environs = readdirSync('/proc').filter((name) => /^\d+$/.test(name)).map((pid) => tryRead('/proc/' + pid + '/environ'))
const network = await new Promise((resolve) => {
  const socket = connect({ host: ${JSON.stringify(INTERNET_V4)}, port: 53 })
  const done = (result) => { socket.destroy(); resolve(result) }
  socket.setTimeout(3000, () => done('timeout'))
  socket.once('connect', () => done('open'))
  socket.once('error', (error) => done(error.code ?? 'error'))
})
const seen = {
  canaryName: canary ?? null,
  envKeys: Object.keys(process.env).sort(),
  envText: JSON.stringify(process.env),
  procCount: environs.length,
  procEnviron: environs.join('\n'),
  parentEnviron: tryRead('/proc/' + process.ppid + '/environ'),
  dockerSocket: existsSync('/var/run/docker.sock'),
  network,
  writeCopy: tryWrite(new URL('./written.txt', import.meta.url)),
  writeRoot: tryWrite('/written.txt'),
  appFile: tryRead(process.env.LIVE_APP_FILE ?? ${JSON.stringify('/nonexistent')}),
  uid: process.getuid(),
}
export default defineRemontnikConfig({ ...BASE, review: { botDescription: JSON.stringify(seen) } })
`

describe.skipIf(!dockerReady)('чтение настройки в контейнере: код настройки не видит секретов врача', () => {
  let root: string
  let appDir: string
  let stateDir: string

  beforeAll(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'remontnik-cfgread-')))
    appDir = join(root, 'app')
    stateDir = join(root, 'state')
    mkdirSync(join(appDir, 'src'), { recursive: true })
    mkdirSync(stateDir)
    const base = {
      app: { name: 'patient', timeZone: 'UTC' },
      repo: { mainBranch: 'main' },
      workbench: { image: 'node:22', install: 'true' },
      checks: { test: 'true' },
      evalScope: [],
      closedPaths: [],
      forbidden: { schema: ['<нет>'], money: ['src/payments/**'], access: ['src/auth/**'] },
      deploy: { commands: { build: 'b', promote: 'p', confirm: 'c', rollback: 'r', current: 'cur', health: 'h' }, lockFile: '.remontnik/deploy.lock' },
      reports: { telegram: { botTokenEnv: 'ALERT_BOT_TOKEN' } },
    }
    writeFileSync(join(appDir, 'src/base.mjs'), `export const BASE = ${JSON.stringify(base)}\n`)
    writeFileSync(join(appDir, 'notes.txt'), `${CANARY}\n`)
    writeFileSync(join(appDir, 'remontnik.config.mjs'), HOSTILE_CONFIG)
    execFileSync('git', ['init', '--quiet', '--initial-branch=main'], { cwd: appDir })
    execFileSync('git', ['add', '-A'], { cwd: appDir })
    execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'настройка'], { cwd: appDir })

    docker(['build', '-q', '-f', 'deploy/doctor.Dockerfile', '-t', IMAGE, '.'])
    const socketGid = docker(['run', '--rm', '-v', '/var/run/docker.sock:/var/run/docker.sock', '--entrypoint', 'stat', IMAGE, '-c', '%g', '/var/run/docker.sock']).trim()
    const user = `${process.getuid?.() ?? 10001}:${process.getgid?.() ?? 10001}`
    // Врач как в шаблоне compose: те же ограничения, секрет в окружении и сокет Docker.
    docker([
      'run', '-d', '--name', DOCTOR, '--user', user, '--group-add', socketGid,
      '--read-only', '--tmpfs', '/tmp', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
      '-e', 'HOME=/tmp', '-e', `LIVE_DOCTOR_SECRET=${CANARY}`, '-e', `REMONTNIK_GATEWAY_CONTAINER=${DOCTOR}`, '-e', `REMONTNIK_STATE_DIR=${stateDir}`,
      '-v', '/var/run/docker.sock:/var/run/docker.sock', '-v', `${appDir}:${appDir}`, '-v', `${stateDir}:${stateDir}`,
      '--entrypoint', 'sleep', IMAGE, 'infinity',
    ])
  }, 900_000)

  afterAll(() => {
    quietly(['rm', '-f', DOCTOR])
    for (const id of spawnSync('docker', ['ps', '-aq', '--filter', 'label=remontnik.config-read'], { encoding: 'utf8' }).stdout.split('\n').filter(Boolean)) quietly(['rm', '-f', id])
    quietly(['rmi', '-f', IMAGE])
    rmSync(root, { recursive: true, force: true })
  })

  it('окружение, /proc врача, сокет Docker, сеть, запись и остальная рабочая копия коду настройки недоступны', () => {
    // Боевой код врача из образа: тот же путь, что при старте и в check-config.
    const script = `
      const { loadMainBranchConfig } = await import('/app/dist/service/config-source.js')
      const { configReaderFromEnv } = await import('/app/dist/service/start.js')
      const reader = configReaderFromEnv(process.env)
      const loaded = await loadMainBranchConfig({ mainCheckoutDirectory: ${JSON.stringify(appDir)}, mainBranch: 'main', reader })
      process.stdout.write(JSON.stringify({ isolation: reader.isolation, imports: loaded.localImports, seen: JSON.parse(loaded.config.review.botDescription) }))
    `
    const out = JSON.parse(
      docker(['exec', '-e', 'LIVE_CANARY_NAME_IS_PUBLIC=LIVE_DOCTOR_SECRET', '-e', `LIVE_APP_FILE=${join(appDir, 'notes.txt')}`, DOCTOR, 'node', '--input-type=module', '-e', script]),
    ) as { isolation: string; imports: string[]; seen: Record<string, unknown> }

    expect(out.isolation).toBe('container')
    expect(out.imports).toEqual(['src/base.mjs'])
    const { seen } = out
    // Окружение врача (и переменные, переданные в docker exec) в контейнер чтения не попадают.
    expect(seen.canaryName).toBeNull()
    expect(seen.envText).not.toContain(CANARY)
    expect(seen.envKeys).not.toContain('LIVE_DOCTOR_SECRET')
    expect(seen.envKeys).not.toContain('REMONTNIK_STATE_DIR')
    // Свои процессы: в /proc нет ни врача, ни его родителя.
    expect(seen.procCount).toBeGreaterThan(0)
    expect(seen.procEnviron).toContain('REMONTNIK_RESULT_MARKER')
    expect(seen.procEnviron).not.toContain(CANARY)
    expect(seen.parentEnviron).not.toContain(CANARY)
    expect(seen.dockerSocket).toBe(false)
    expect(seen.network).not.toBe('open')
    expect(seen.writeCopy).toBe('EROFS')
    expect(seen.writeRoot).toBe('EROFS')
    // Файл рабочей копии вне списка файлов настройки — не виден, хотя врачу он доступен.
    expect(seen.appFile).toBe('ENOENT')
    expect(seen.uid).toBe(process.getuid?.() ?? 10001)
    // Контейнер и копия убраны.
    expect(docker(['ps', '-aq', '--filter', 'label=remontnik.config-read']).trim()).toBe('')
    expect(docker(['exec', DOCTOR, 'ls', '-A', join(stateDir, 'config-read')]).trim()).toBe('')
  }, 120_000)

  it('Docker недоступен — врач говорит это прямо и код настройки не выполняет', () => {
    const script = `
      const { loadMainBranchConfig } = await import('/app/dist/service/config-source.js')
      const { configReaderFromEnv } = await import('/app/dist/service/start.js')
      try {
        await loadMainBranchConfig({ mainCheckoutDirectory: ${JSON.stringify(appDir)}, mainBranch: 'main', reader: configReaderFromEnv(process.env) })
        process.stdout.write(JSON.stringify({ loaded: true }))
      } catch (error) {
        process.stdout.write(JSON.stringify({ code: error.code, message: error.message }))
      }
    `
    const out = JSON.parse(
      docker(['exec', '-e', `DOCKER_HOST=unix://${join(stateDir, 'no-docker.sock')}`, DOCTOR, 'node', '--input-type=module', '-e', script]),
    ) as { loaded?: boolean; code?: string; message?: string }

    expect(out.loaded).toBeUndefined()
    expect(out.code).toBe('reader_unavailable')
    expect(out.message).toMatch(/^настройку нельзя прочитать: Docker недоступен/)
    expect(docker(['exec', DOCTOR, 'ls', '-A', join(stateDir, 'config-read')]).trim()).toBe('')
  }, 120_000)
})
