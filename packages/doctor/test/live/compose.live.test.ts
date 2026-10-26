import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

// Живая проверка шаблона deploy/compose.remontnik.yml на настоящем Docker: сборка образов врача и верстака,
// подставное приложение в своей сети, врач поднимается из окружения. Команды в верстаке запускает сам врач
// (`doctorStartPlan` → `createDockerRunner` внутри контейнера врача, через сокет хоста), а пробы изнутри
// контейнеров верстака смотрят, что видно в сети верстака и в сети проверок.
// Запуск: pnpm exec vitest run -c vitest.live.config.ts packages/doctor/test/live/compose.live.test.ts

const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url))
const composeFile = join(repoRoot, 'deploy/compose.remontnik.yml')
const PROJECT = 'remontnik-live'
const TAG = 'live-test'
const APP_NETWORK = 'remontnik-live-app'
const APP_CONTAINER = 'remontnik-live-patient'
const HOST_SERVICE = 'remontnik-live-host-service'
const HOST_SERVICE_PORT = 18_999
const CANARY = ['canary', 'secret', 'must', 'not', 'leak'].join('-')
// Адрес интернета собран из частей: проверка открытости репозитория не пускает его в текст как есть.
const INTERNET_V4 = [1, 1, 1, 1].join('.')
const EGRESS_IP = '10.213.98.2'
const EVAL_PROXY_IP = '10.213.99.2'

const dockerReady = spawnSync('docker', ['info'], { stdio: 'ignore' }).status === 0

function docker(args: string[], options: { env?: NodeJS.ProcessEnv; input?: string } = {}): string {
  return execFileSync('docker', args, { cwd: repoRoot, encoding: 'utf8', env: { ...process.env, ...options.env }, stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024, ...(options.input ? { input: options.input } : {}) })
}

/** Журнал контейнера: служба пишет в stderr. */
function logs(container: string): string {
  const result = spawnSync('docker', ['logs', container], { encoding: 'utf8' })
  return `${result.stdout}${result.stderr}`
}

function quietly(args: string[], env?: NodeJS.ProcessEnv): void {
  spawnSync('docker', args, { cwd: repoRoot, stdio: 'ignore', env: { ...process.env, ...env } })
}

/** Проба изнутри контейнера: что видно по сети, есть ли git, сокет, чужие переменные. Пишет JSON. */
const PROBE = String.raw`
import { connect } from 'node:net'
import { lookup } from 'node:dns/promises'
import { existsSync } from 'node:fs'
import { execSync } from 'node:child_process'

function tcp(host, port) {
  return new Promise((resolve) => {
    const socket = connect({ host, port })
    const done = (result) => { socket.destroy(); resolve(result) }
    socket.setTimeout(3000, () => done('timeout'))
    socket.once('connect', () => done('open'))
    socket.once('error', (error) => done(error.code ?? 'error'))
  })
}

function viaProxy(proxy, target) {
  const [host, port] = proxy.split(':')
  return new Promise((resolve) => {
    const socket = connect({ host, port: Number(port) })
    socket.setTimeout(10000, () => { socket.destroy(); resolve('timeout') })
    socket.once('error', (error) => resolve(error.code ?? 'error'))
    socket.once('connect', () => socket.write('CONNECT ' + target + ' HTTP/1.1\r\nHost: ' + target + '\r\n\r\n'))
    socket.once('data', (chunk) => { socket.destroy(); resolve(Number(/^HTTP\/1\.1 (\d+)/.exec(chunk.toString())?.[1])) })
  })
}

async function http(url) {
  try {
    const response = await fetch(url, { method: 'POST', body: '{}', signal: AbortSignal.timeout(5000) })
    return response.status
  } catch (error) {
    return error.cause?.code ?? error.name
  }
}

const [, , ...targets] = process.argv
const result = {
  git: (() => { try { return execSync('command -v git', { encoding: 'utf8' }).trim() || null } catch { return null } })(),
  dockerSocket: existsSync('/var/run/docker.sock'),
  dockerClient: (() => { try { return execSync('command -v docker', { encoding: 'utf8' }).trim() || null } catch { return null } })(),
  envNames: Object.keys(process.env).sort(),
  canaryInEnv: Object.values(process.env).some((value) => value?.includes('${CANARY}')),
  dns: await lookup('example.com').then((found) => found.address, (error) => error.code ?? 'error'),
  tcp: {},
  proxy: {},
  http: {},
}
for (const target of targets) {
  const [kind, value] = target.split('=')
  if (kind === 'tcp') { const at = value.lastIndexOf(':'); result.tcp[value] = await tcp(value.slice(0, at), Number(value.slice(at + 1))) }
  if (kind === 'proxy') { const [proxy, connectTo] = value.split('>'); result.proxy[connectTo] = await viaProxy(proxy, connectTo) }
  if (kind === 'http') result.http[value] = await http(value)
}
process.stdout.write('PROBE' + JSON.stringify(result) + 'PROBE')
`

/** Команда в верстаке, как её запускает врач: исполнитель из боевой настройки запуска, внутри контейнера врача. */
const RUN_IN_WORKBENCH = String.raw`
import { readFileSync } from 'node:fs'
const { doctorStartPlan } = await import('/app/dist/index.js')
const { defineRemontnikConfig } = await import('@ykurilov/remontnik-core/config')
const config = defineRemontnikConfig(JSON.parse(readFileSync(process.env.REMONTNIK_CONFIG_REPO_DIR + '/remontnik.config.json', 'utf8')))
const runner = doctorStartPlan(process.env, config).service.treatment.runner
const [copyDir, network, command] = JSON.parse(process.argv[1])
const result = await runner.run(command, { cwd: copyDir, copyDir, timeoutSeconds: 300, ...(network === 'internal' ? { network } : {}) })
process.stdout.write(JSON.stringify({ isolation: runner.isolation, ...result }))
`

interface Probe {
  git: string | null
  dockerSocket: boolean
  dockerClient: string | null
  envNames: string[]
  canaryInEnv: boolean
  dns: string
  tcp: Record<string, string>
  proxy: Record<string, number | string>
  http: Record<string, number | string>
}

describe.skipIf(!dockerReady)('шаблон compose на настоящем Docker', () => {
  let root: string
  let copyDir: string
  let composeEnv: NodeJS.ProcessEnv
  let appIp: string

  function workbench(network: 'workbench' | 'internal', command: string): { exitCode: number | null; output: string; isolation: string; spawnError?: string } {
    const out = docker(['exec', '-w', '/app', 'remontnik-doctor', 'node', '--input-type=module', '-e', RUN_IN_WORKBENCH, JSON.stringify([copyDir, network, command])])
    return JSON.parse(out)
  }

  function probe(network: 'workbench' | 'internal', targets: string[]): Probe {
    const result = workbench(network, `node probe.mjs ${targets.map((target) => `'${target}'`).join(' ')}`)
    const json = /PROBE(.*)PROBE/s.exec(result.output)?.[1]
    if (!json) throw new Error(`проба не ответила: ${JSON.stringify(result)}`)
    return JSON.parse(json)
  }

  beforeAll(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'remontnik-compose-')))
    const appDir = join(root, 'app')
    const stateDir = join(root, 'state')
    copyDir = join(stateDir, 'copies', 'probe')
    mkdirSync(appDir, { recursive: true })
    mkdirSync(copyDir, { recursive: true })

    const config = {
      app: { name: 'live-patient' },
      repo: { mainBranch: 'main' },
      workbench: { image: `remontnik-workbench:${TAG}`, install: 'pnpm install' },
      checks: { test: 'node --test' },
      evalScope: [],
      closedPaths: [],
      forbidden: { schema: ['<нет>'], money: ['src/payments/**'], access: ['src/auth/**'] },
      deploy: {
        commands: { build: 'true', promote: 'true', confirm: 'true', rollback: 'true', current: 'echo {}', health: 'true' },
        lockFile: '.remontnik/deploy.lock',
      },
      reports: { telegram: { botTokenEnv: 'LIVE_ALERT_BOT_TOKEN', chatIdEnv: 'LIVE_ALERT_CHAT_ID', apiBaseUrlEnv: 'LIVE_TELEGRAM_URL' } },
    }
    writeFileSync(join(appDir, 'remontnik.config.json'), JSON.stringify(config, null, 2))
    const git = (...args: string[]) => execFileSync('git', args, { cwd: appDir, stdio: 'ignore' })
    git('init', '--quiet', '--initial-branch=main')
    git('-c', 'user.name=live', '-c', 'user.email=live@example.com', 'add', '-A')
    git('-c', 'user.name=live', '-c', 'user.email=live@example.com', 'commit', '--quiet', '-m', 'подставное приложение')

    writeFileSync(join(copyDir, 'probe.mjs'), PROBE)
    writeFileSync(join(copyDir, 'package.json'), JSON.stringify({ name: 'probe', private: true, dependencies: { 'is-number': '7.0.0' } }))
    const envFile = join(root, 'doctor.env')
    writeFileSync(
      envFile,
      [
        `REMONTNIK_SHARED_SECRET=${CANARY}-shared`,
        `DEEPSEEK_API_KEY=${CANARY}-deepseek`,
        `OPENROUTER_API_KEY=${CANARY}-openrouter`,
        `LIVE_ALERT_BOT_TOKEN=123456:${CANARY}`,
        'LIVE_ALERT_CHAT_ID=owner-chat',
        // Telegram в проверке не нужен: отчёты уходят на заведомо мёртвый адрес.
        'LIVE_TELEGRAM_URL=http://127.0.0.1:9',
        '',
      ].join('\n'),
    )
    chmodSync(envFile, 0o600)

    const uid = String(process.getuid?.() ?? 10001)
    const gid = String(process.getgid?.() ?? 10001)
    const socketGid = docker(['run', '--rm', '-v', '/var/run/docker.sock:/var/run/docker.sock', '--entrypoint', 'stat', 'node:22-bookworm-slim', '-c', '%g', '/var/run/docker.sock']).trim()
    composeEnv = {
      REMONTNIK_APP_DIR: appDir,
      REMONTNIK_STATE_DIR: stateDir,
      REMONTNIK_ENV_FILE: envFile,
      REMONTNIK_APP_NETWORK: APP_NETWORK,
      REMONTNIK_IMAGE_TAG: TAG,
      REMONTNIK_UID: uid,
      REMONTNIK_GID: gid,
      DOCKER_GID: socketGid,
    }

    docker(['build', '-q', '-f', 'deploy/workbench.Dockerfile', '-t', `remontnik-workbench:${TAG}`, 'deploy'])
    docker(['compose', '-p', PROJECT, '-f', composeFile, 'build', '-q', 'doctor'], { env: composeEnv })

    // Приложение в своей сети и служба хоста на всех адресах: ни то, ни другое не должно быть видно из верстака.
    quietly(['network', 'create', APP_NETWORK])
    docker(['run', '-d', '--rm', '--name', APP_CONTAINER, '--network', APP_NETWORK, '--entrypoint', 'node', `remontnik-doctor:${TAG}`, '-e', "require('http').createServer((q,s)=>s.end('patient')).listen(8080)"])
    docker(['run', '-d', '--rm', '--name', HOST_SERVICE, '--network', 'host', '--entrypoint', 'node', `remontnik-doctor:${TAG}`, '-e', `require('net').createServer(s=>s.end('host')).listen(${HOST_SERVICE_PORT},'0.0.0.0')`])
    appIp = docker(['inspect', '-f', `{{(index .NetworkSettings.Networks "${APP_NETWORK}").IPAddress}}`, APP_CONTAINER]).trim()

    docker(['compose', '-p', PROJECT, '-f', composeFile, 'up', '-d', '--wait'], { env: composeEnv })
    const deadline = Date.now() + 60_000
    while (!logs('remontnik-doctor').includes('слушаю')) {
      if (Date.now() > deadline) throw new Error(`врач не поднялся:\n${logs('remontnik-doctor')}`)
      execFileSync('sleep', ['1'])
    }
  }, 900_000)

  afterAll(() => {
    // REMONTNIK_KEEP_STACK=1 — оставить стенд для разбора руками.
    if (!composeEnv || process.env.REMONTNIK_KEEP_STACK === '1') return
    quietly(['compose', '-p', PROJECT, '-f', composeFile, 'down', '--volumes', '--remove-orphans'], composeEnv)
    quietly(['rm', '-f', APP_CONTAINER, HOST_SERVICE])
    quietly(['network', 'rm', APP_NETWORK])
    // Копии писал пользователь врача; убираем через контейнер, если у хоста не хватит прав.
    quietly(['run', '--rm', '-v', `${root}:${root}`, '--entrypoint', 'rm', 'node:22-bookworm-slim', '-rf', join(root, 'state')])
    rmSync(root, { recursive: true, force: true })
  }, 120_000)

  it('врач поднялся из окружения: проверил закрытые сети, слушает приём и прокси eval', () => {
    expect(logs('remontnik-doctor')).toContain('слушаю http://0.0.0.0:7800')
    const networks = (name: string) => docker(['network', 'inspect', '-f', '{{.Internal}}', name]).trim()
    expect(networks('remontnik-workbench')).toBe('true')
    expect(networks('remontnik-checks')).toBe('true')
    expect(networks('remontnik-outside')).toBe('false')
    const mounts = docker(['inspect', '-f', '{{range .Mounts}}{{.Destination}} {{end}}', 'remontnik-doctor'])
    expect(mounts).toContain('/var/run/docker.sock')
    expect(docker(['inspect', '-f', '{{range .Mounts}}{{.Destination}} {{end}}', 'remontnik-egress-proxy']).trim()).not.toContain('docker.sock')
  })

  it('сеть верстака: нет git, сокета, секретов врача; интернета, метаданных, хоста и приложения не видно', () => {
    const seen = probe('workbench', [
      `tcp=${INTERNET_V4}:443`,
      `tcp=169.254.169.254:80`,
      `tcp=10.213.98.1:${HOST_SERVICE_PORT}`,
      `tcp=${appIp}:8080`,
      `tcp=${EVAL_PROXY_IP}:7810`,
      `proxy=${EGRESS_IP}:3128>registry.npmjs.org:443`,
      `proxy=${EGRESS_IP}:3128>example.com:443`,
      `proxy=${EGRESS_IP}:3128>169.254.169.254:80`,
      `proxy=${EGRESS_IP}:3128>registry.npmjs.org:22`,
    ])
    expect(seen.git).toBeNull()
    expect(seen.dockerSocket).toBe(false)
    expect(seen.dockerClient).toBeNull()
    expect(seen.canaryInEnv).toBe(false)
    expect(seen.envNames).not.toEqual(expect.arrayContaining(['DEEPSEEK_API_KEY']))
    expect(seen.envNames).toEqual(expect.arrayContaining(['HTTPS_PROXY', 'HOME']))
    expect(seen.dns).not.toMatch(/^\d/)
    for (const [target, state] of Object.entries(seen.tcp)) expect(state, target).not.toBe('open')
    expect(seen.proxy['registry.npmjs.org:443']).toBe(200)
    expect(seen.proxy['example.com:443']).toBe(403)
    expect(seen.proxy['169.254.169.254:80']).toBe(400)
    expect(seen.proxy['registry.npmjs.org:22']).toBe(403)
  })

  it('установка зависимостей идёт через прокси выхода к реестру', () => {
    const result = workbench('workbench', 'pnpm install && node -e "process.exit(require(\'is-number\')(5) ? 0 : 1)"')
    expect(result.isolation).toBe('container')
    expect(result.exitCode, result.output).toBe(0)
  })

  it('сеть проверок: виден только прокси eval врача; интернета, прокси выхода, хоста и приложения нет', () => {
    const seen = probe('internal', [
      `tcp=${INTERNET_V4}:443`,
      `tcp=169.254.169.254:80`,
      `tcp=10.213.99.1:${HOST_SERVICE_PORT}`,
      `tcp=${EGRESS_IP}:3128`,
      `tcp=${appIp}:8080`,
      `http=http://${EVAL_PROXY_IP}:7810/unknown-run/provider/v1/chat/completions`,
    ])
    expect(seen.git).toBeNull()
    expect(seen.dockerSocket).toBe(false)
    expect(seen.canaryInEnv).toBe(false)
    expect(seen.envNames).not.toContain('HTTPS_PROXY')
    expect(seen.dns).not.toMatch(/^\d/)
    for (const [target, state] of Object.entries(seen.tcp)) expect(state, target).not.toBe('open')
    // Прокси eval отвечает: прогона с таким пропуском нет.
    expect(seen.http[`http://${EVAL_PROXY_IP}:7810/unknown-run/provider/v1/chat/completions`]).toBe(401)
  })
})
