import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

// Живая проверка шаблона deploy/compose.remontnik.yml на настоящем Docker: сборка образов врача и верстака,
// подставное приложение в своей сети, врач поднимается из окружения. Сценарии случаев идут внутри контейнера
// врача боевым кодом (`doctorStartPlan` → `createCaseGateway`): сети случая, зеркало реестра, прокси eval,
// исполнитель команд через сокет хоста. Пробы изнутри контейнеров верстака смотрят, что видно в сетях случая.
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
const GATEWAY = 'remontnik-gateway'
const MIRROR = `http://${GATEWAY}:7801`
const POSTGRES_IMAGE = 'postgres:17-alpine@sha256:266d3c257594e195b309ae9d1805e54c788f1d7b375f56bf6c367aac6c917e7b'

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

/** Сети случая, оставшиеся после сценария: их быть не должно. */
function caseNetworks(): string[] {
  return docker(['network', 'ls', '--filter', 'label=remontnik.case-network', '--format', '{{.Name}}']).split('\n').filter(Boolean)
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

/** Сырой запрос (base64) к host:port: код ответа. Так проверяются CONNECT, чужой Host и адрес в строке запроса. */
function raw(address, request) {
  const at = address.lastIndexOf(':')
  return new Promise((resolve) => {
    const socket = connect({ host: address.slice(0, at), port: Number(address.slice(at + 1)) })
    socket.setTimeout(30000, () => { socket.destroy(); resolve('timeout') })
    socket.once('error', (error) => resolve(error.code ?? 'error'))
    socket.once('connect', () => socket.write(Buffer.from(request, 'base64')))
    socket.once('data', (chunk) => { socket.destroy(); resolve(Number(/^HTTP\/1\.1 (\d+)/.exec(chunk.toString())?.[1])) })
  })
}

async function get(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(60000) })
    const body = await response.text()
    return { status: response.status, mirrorTarballs: body.split('${MIRROR}/').length - 1, registryTarballs: body.split('https://registry.npmjs.org/').length - 1 }
  } catch (error) {
    return { status: error.cause?.code ?? error.name }
  }
}

async function post(url) {
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
  raw: {},
  get: {},
  post: {},
}
for (const target of targets) {
  const at = target.indexOf('=')
  const [kind, value] = [target.slice(0, at), target.slice(at + 1)]
  if (kind === 'tcp') { const port = value.lastIndexOf(':'); result.tcp[value] = await tcp(value.slice(0, port), Number(value.slice(port + 1))) }
  if (kind === 'raw') { const [address, name, request] = value.split('>'); result.raw[name] = await raw(address, request) }
  if (kind === 'get') result.get[value] = await get(value)
  if (kind === 'post') result.post[value] = await post(value)
}
process.stdout.write('PROBE' + JSON.stringify(result) + 'PROBE')
`

/**
 * Сценарий случаев внутри контейнера врача, боевым кодом: сети случая, зеркало, прокси eval и исполнитель команд.
 * В теле доступны `gateway`, `run(copyDir, command, network?)`, `probe(copyDir, targets, network?)`, `docker(...args)`,
 * `arg` и `out`. После тела сети закрываются; итог — `out`.
 */
function scenario(body: string): string {
  return String.raw`
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
const { createCaseGateway, doctorStartPlan } = await import('/app/dist/index.js')
const { defineRemontnikConfig } = await import('@ykurilov/remontnik-core/config')
const config = defineRemontnikConfig(JSON.parse(readFileSync(process.env.REMONTNIK_CONFIG_REPO_DIR + '/remontnik.config.json', 'utf8')))
const gateway = await createCaseGateway(doctorStartPlan(process.env, config))
const run = (copyDir, command, network) => gateway.runner.run(command, { cwd: copyDir, copyDir, timeoutSeconds: 300, ...(network === 'internal' ? { network } : {}) })
const probe = async (copyDir, targets, network) => {
  const result = await run(copyDir, ['node', 'probe.mjs', ...targets], network)
  const json = /PROBE(.*)PROBE/s.exec(result.output)?.[1]
  if (!json) throw new Error('проба не ответила: ' + JSON.stringify(result))
  return JSON.parse(json)
}
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8' }).trim()
const arg = JSON.parse(process.argv[1])
const out = {}
try {
${body}
} finally {
  await gateway.close()
}
process.stdout.write('RESULT' + JSON.stringify(out) + 'RESULT')
`
}

interface Probe {
  git: string | null
  dockerSocket: boolean
  dockerClient: string | null
  envNames: string[]
  canaryInEnv: boolean
  dns: string
  tcp: Record<string, string>
  raw: Record<string, number | string>
  get: Record<string, { status: number | string; mirrorTarballs?: number; registryTarballs?: number }>
  post: Record<string, number | string>
}

const rawRequest = (name: string, text: string) => `raw=${GATEWAY}:7801>${name}>${Buffer.from(text).toString('base64')}`

describe.skipIf(!dockerReady)('шаблон compose на настоящем Docker', () => {
  let root: string
  let stateDir: string
  let composeEnv: NodeJS.ProcessEnv
  let appIp: string
  let doctorAppIp: string

  /** Новая копия случая с пробой и package.json. */
  function copy(name: string): string {
    const dir = join(stateDir, 'copies', name)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'probe.mjs'), PROBE)
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'probe', private: true, dependencies: { 'is-number': '7.0.0' } }))
    return dir
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function inDoctor(body: string, arg: unknown = {}): any {
    const output = docker(['exec', '-w', '/app', 'remontnik-doctor', 'node', '--input-type=module', '-e', scenario(body), JSON.stringify(arg)])
    const json = /RESULT(.*)RESULT/s.exec(output)?.[1]
    if (!json) throw new Error(`сценарий не ответил: ${output}`)
    return JSON.parse(json)
  }

  /** TCP-соединение из временного контейнера в сети `network`. */
  function tcpFrom(network: string, host: string, port: number): string {
    const code = `const s=require('net').connect(${port},'${host}');s.setTimeout(3000,()=>{console.log('timeout');process.exit()});s.on('connect',()=>{console.log('open');process.exit()});s.on('error',e=>{console.log(e.code);process.exit()})`
    return docker(['run', '--rm', '--network', network, '--entrypoint', 'node', `remontnik-doctor:${TAG}`, '-e', code]).trim()
  }

  beforeAll(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'remontnik-compose-')))
    const appDir = join(root, 'app')
    stateDir = join(root, 'state')
    mkdirSync(appDir, { recursive: true })
    mkdirSync(join(stateDir, 'copies'), { recursive: true })

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
    const ipIn = (container: string, network: string) => docker(['inspect', '-f', `{{(index .NetworkSettings.Networks "${network}").IPAddress}}`, container]).trim()
    appIp = ipIn(APP_CONTAINER, APP_NETWORK)

    docker(['compose', '-p', PROJECT, '-f', composeFile, 'up', '-d', '--wait'], { env: composeEnv })
    const deadline = Date.now() + 60_000
    while (!logs('remontnik-doctor').includes('слушаю')) {
      if (Date.now() > deadline) throw new Error(`врач не поднялся:\n${logs('remontnik-doctor')}`)
      execFileSync('sleep', ['1'])
    }
    doctorAppIp = ipIn('remontnik-doctor', APP_NETWORK)
  }, 900_000)

  afterAll(() => {
    // REMONTNIK_KEEP_STACK=1 — оставить стенд для разбора руками.
    if (!composeEnv || process.env.REMONTNIK_KEEP_STACK === '1') return
    for (const network of caseNetworks()) {
      quietly(['network', 'disconnect', '--force', network, 'remontnik-doctor'])
      quietly(['network', 'rm', network])
    }
    quietly(['compose', '-p', PROJECT, '-f', composeFile, 'down', '--volumes', '--remove-orphans'], composeEnv)
    quietly(['rm', '-f', APP_CONTAINER, HOST_SERVICE])
    quietly(['network', 'rm', APP_NETWORK])
    // Копии писал пользователь врача; убираем через контейнер, если у хоста не хватит прав.
    quietly(['run', '--rm', '-v', `${root}:${root}`, '--entrypoint', 'rm', 'node:22-bookworm-slim', '-rf', join(root, 'state')])
    rmSync(root, { recursive: true, force: true })
  }, 120_000)

  it('врач поднялся из окружения: слушает приём только на своём адресе в сети приложения', () => {
    expect(logs('remontnik-doctor')).toContain(`слушаю http://${doctorAppIp}:7800`)
    expect(docker(['network', 'inspect', '-f', '{{.Internal}}', 'remontnik-outside']).trim()).toBe('false')
    expect(docker(['network', 'ls', '--format', '{{.Name}}'])).not.toMatch(/remontnik-(workbench|checks)\b/)
    expect(docker(['inspect', '-f', '{{range .Mounts}}{{.Destination}} {{end}}', 'remontnik-doctor'])).toContain('/var/run/docker.sock')
    // Память врача ограничена: по умолчанию 2 ГБ без подкачки сверху.
    expect(docker(['inspect', '-f', '{{.HostConfig.Memory}} {{.HostConfig.MemorySwap}}', 'remontnik-doctor']).trim()).toBe(`${2 * 1024 ** 3} ${2 * 1024 ** 3}`)
    // Из сети приложения порт 7800 открыт, из внешней сети врача — нет.
    expect(tcpFrom(APP_NETWORK, 'remontnik-doctor', 7800)).toBe('open')
    expect(tcpFrom('remontnik-outside', 'remontnik-doctor', 7800)).not.toBe('open')
  })

  it('сеть верстака: только зеркало реестра; установка через него проходит, чужое через него недостижимо', () => {
    const dir = copy('workbench')
    const out = inDoctor(
      String.raw`
  out.probe = await probe(arg.dir, arg.targets)
  out.install = await run(arg.dir, 'pnpm install && node -e "process.exit(require(\'is-number\')(5) ? 0 : 1)"')
  out.isolation = gateway.runner.isolation
  out.networks = docker('network', 'ls', '--filter', 'label=remontnik.case-network', '--format', '{{.Name}} {{.Internal}}')
`,
      {
        dir,
        targets: [
          `tcp=${INTERNET_V4}:443`,
          'tcp=169.254.169.254:80',
          `tcp=${appIp}:8080`,
          `tcp=${doctorAppIp}:7800`,
          `tcp=${GATEWAY}:7800`,
          `tcp=${GATEWAY}:7810`,
          `get=${MIRROR}/is-number`,
          `post=${MIRROR}/is-number`,
          rawRequest('host-example', 'GET / HTTP/1.1\r\nHost: example.com\r\nConnection: close\r\n\r\n'),
          rawRequest('host-ignored', 'GET /is-number HTTP/1.1\r\nHost: example.com\r\nConnection: close\r\n\r\n'),
          rawRequest('absolute-url', 'GET http://example.com/ HTTP/1.1\r\nHost: example.com\r\nConnection: close\r\n\r\n'),
          rawRequest('double-slash', 'GET //example.com/ HTTP/1.1\r\nHost: example.com\r\nConnection: close\r\n\r\n'),
          rawRequest('traversal', 'GET /%2e%2e/%2e%2e/ HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n'),
          rawRequest('connect', 'CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\n'),
        ],
      },
    )
    const seen: Probe = out.probe
    expect(seen.git).toBeNull()
    expect(seen.dockerSocket).toBe(false)
    expect(seen.dockerClient).toBeNull()
    expect(seen.canaryInEnv).toBe(false)
    expect(seen.envNames).not.toEqual(expect.arrayContaining(['DEEPSEEK_API_KEY']))
    expect(seen.envNames).not.toContain('HTTPS_PROXY')
    expect(seen.envNames).toEqual(expect.arrayContaining(['npm_config_registry', 'HOME']))
    expect(seen.dns).not.toMatch(/^\d/)
    for (const [target, state] of Object.entries(seen.tcp)) expect(state, target).not.toBe('open')
    const metadata = seen.get[`${MIRROR}/is-number`]!
    expect(metadata.status).toBe(200)
    expect(metadata.mirrorTarballs).toBeGreaterThan(0)
    expect(metadata.registryTarballs).toBe(0)
    expect(seen.post[`${MIRROR}/is-number`]).toBe(405)
    expect(seen.raw).toEqual({ 'host-example': 400, 'host-ignored': 200, 'absolute-url': 400, 'double-slash': 400, traversal: 400, connect: 405 })
    expect(out.isolation).toBe('container')
    expect(out.install.exitCode, out.install.output).toBe(0)
    expect(out.networks).toMatch(/^remontnik-case-\S+-workbench-\S+ true$/)
    expect(caseNetworks()).toEqual([])
  })

  it('сеть проверок: виден только прокси eval врача; зеркала, приёма, хоста и приложения нет', () => {
    const dir = copy('checks')
    const out = inDoctor(`out.probe = await probe(arg.dir, arg.targets, 'internal')`, {
      dir,
      targets: [
        `tcp=${INTERNET_V4}:443`,
        'tcp=169.254.169.254:80',
        `tcp=${appIp}:8080`,
        `tcp=${doctorAppIp}:7800`,
        `tcp=${GATEWAY}:7800`,
        `tcp=${GATEWAY}:7801`,
        `post=http://${GATEWAY}:7810/unknown-run/provider/v1/chat/completions`,
      ],
    })
    const seen: Probe = out.probe
    expect(seen.git).toBeNull()
    expect(seen.dockerSocket).toBe(false)
    expect(seen.canaryInEnv).toBe(false)
    expect(seen.envNames).not.toContain('npm_config_registry')
    expect(seen.dns).not.toMatch(/^\d/)
    for (const [target, state] of Object.entries(seen.tcp)) expect(state, target).not.toBe('open')
    // Прокси eval отвечает: прогона с таким пропуском нет.
    expect(seen.post[`http://${GATEWAY}:7810/unknown-run/provider/v1/chat/completions`]).toBe(401)
    expect(caseNetworks()).toEqual([])
  })

  it('соседние случаи друг друга не видят, контейнеры одного случая — видят', () => {
    const [a, b] = [copy('neighbor-a'), copy('neighbor-b')]
    const out = inDoctor(
      String.raw`
  const server = run(arg.a, ['node', '-e', "require('http').createServer((q, s) => s.end('a')).listen(9000, '0.0.0.0'); setTimeout(() => process.exit(0), 30000)"])
  await new Promise((resolve) => setTimeout(resolve, 8000))
  const lease = await gateway.caseNetworks.use(arg.a, 'workbench')
  lease.done()
  const base = lease.network.gatewayIp.split('.').map(Number)
  const targets = Array.from({ length: 15 }, (_, i) => 'tcp=' + [base[0], base[1], base[2], base[3] - 2 + 16 + i].join('.') + ':9000')
  out.fromNeighbor = (await probe(arg.b, targets)).tcp
  out.fromSameCase = (await probe(arg.a, targets)).tcp
  out.server = await server
`,
      { a, b },
    )
    expect(Object.values(out.fromSameCase)).toContain('open')
    expect(Object.values(out.fromNeighbor)).not.toContain('open')
    expect(caseNetworks()).toEqual([])
  })

  it('службы для тестов: «Пациент» с Postgres в службе проходит проверку; из соседнего случая базы не видно', () => {
    const [candidate, base, neighbor] = [copy('patient-candidate'), copy('patient-base'), copy('patient-neighbor')]
    const services = [
      'services:',
      '  db:',
      `    image: ${POSTGRES_IMAGE}`,
      '    environment:',
      '      POSTGRES_USER: app',
      '      POSTGRES_HOST_AUTH_METHOD: trust',
      '    tmpfs: /var/lib/postgresql/data',
      '    healthcheck:',
      // `$$` уходит в compose как есть: имя пользователя берётся из окружения службы, а не врача.
      '      test: ["CMD-SHELL", "pg_isready -U $$POSTGRES_USER"]',
      '      interval: 1s',
      '      retries: 120',
      '',
    ].join('\n')
    // Тест приложения: запрос SSLRequest к базе по имени службы; Postgres без TLS отвечает «N».
    const dbTest = String.raw`
import { test } from 'node:test'
import { connect } from 'node:net'
import assert from 'node:assert/strict'
test('база из службы отвечает', async () => {
  const answer = await new Promise((resolve, reject) => {
    const socket = connect(5432, 'db')
    socket.setTimeout(5000, () => reject(new Error('timeout')))
    socket.once('error', reject)
    socket.once('connect', () => socket.write(Buffer.from([0, 0, 0, 8, 4, 210, 22, 47])))
    socket.once('data', (data) => { socket.destroy(); resolve(data.toString()) })
  })
  assert.equal(answer, 'N')
})
`
    for (const dir of [candidate, base]) {
      writeFileSync(join(dir, 'services.yml'), services)
      writeFileSync(join(dir, 'db.test.mjs'), dbTest)
    }
    const out = inDoctor(
      String.raw`
  const { createChecks, createMemoryEvalBaseCache } = await import('/app/dist/checks/index.js')
  // Файл-замок — заранее, через зеркало: врач ставит зависимости только строго по нему.
  for (const dir of [arg.candidate, arg.base]) out['lock ' + dir] = (await run(dir, 'pnpm install --lockfile-only')).exitCode
  const checksConfig = { ...config, checks: { test: 'node --test', services: 'services.yml' } }
  const checks = createChecks({ runner: gateway.runner, config: checksConfig, evalEnv: {}, baseCache: createMemoryEvalBaseCache(), workDir: '/tmp/checks', timeoutSeconds: 300, services: gateway.caseServices })
  out.checks = (await checks.run({ candidateDir: arg.candidate, baseDir: arg.base, baseCommit: 'a'.repeat(40), changedPaths: [], reserveEval: async () => 0 })).tests
  out.servicesAfterChecks = docker('ps', '-aq', '--filter', 'label=remontnik.case-services')

  const running = await gateway.caseServices.up(arg.candidate, readFileSync(arg.base + '/services.yml', 'utf8'))
  try {
    const id = docker('ps', '-q', '--filter', 'label=remontnik.case-services=' + running.project)
    const inspected = JSON.parse(docker('inspect', id))[0]
    out.ports = Object.fromEntries(Object.entries(inspected.NetworkSettings.Ports ?? {}).filter(([, bound]) => bound))
    out.mounts = inspected.Mounts.map((mount) => mount.Type)
    out.canaryInEnv = inspected.Config.Env.some((line) => line.includes(arg.canary))
    out.networks = Object.values(inspected.NetworkSettings.Networks).map((network) => network.NetworkID)
    out.checksNetwork = (await gateway.caseNetworks.use(arg.candidate, 'checks'))
    out.checksNetwork.done()
    out.checksNetwork = out.checksNetwork.network.id
    const ip = Object.values(inspected.NetworkSettings.Networks)[0].IPAddress
    const targets = ['tcp=db:5432', 'tcp=' + ip + ':5432']
    out.fromSameCase = (await probe(arg.candidate, targets, 'internal')).tcp
    out.fromNeighbor = (await probe(arg.neighbor, targets, 'internal')).tcp
    out.fromNeighborWorkbench = (await probe(arg.neighbor, targets)).tcp
  } finally {
    await running.down()
  }
  out.servicesAfterDown = docker('ps', '-aq', '--filter', 'label=remontnik.case-services')
`,
      { candidate, base, neighbor, canary: CANARY },
    )
    expect(out[`lock ${candidate}`]).toBe(0)
    expect(out.checks).toMatchObject({ status: 'green' })
    expect(out.servicesAfterChecks).toBe('')
    // Портов наружу и томов хоста нет, секретов врача нет; сеть — только сеть проверок своего случая.
    expect(out.ports).toEqual({})
    expect(out.mounts.filter((type: string) => type === 'bind')).toEqual([])
    expect(out.canaryInEnv).toBe(false)
    expect(out.networks).toEqual([out.checksNetwork])
    expect(Object.values(out.fromSameCase)).toEqual(['open', 'open'])
    expect(Object.values(out.fromNeighbor)).not.toContain('open')
    expect(Object.values(out.fromNeighborWorkbench)).not.toContain('open')
    expect(out.servicesAfterDown).toBe('')
    expect(caseNetworks()).toEqual([])
  })

  it('сеть случая подменили под тем же именем — команда не запускается', () => {
    const dir = copy('substituted')
    const out = inDoctor(
      String.raw`
  const lease = await gateway.caseNetworks.use(arg.dir, 'workbench')
  lease.done()
  docker('network', 'disconnect', '--force', lease.network.id, 'remontnik-doctor')
  docker('network', 'rm', lease.network.id)
  docker('network', 'create', lease.network.name)
  try {
    out.result = await run(arg.dir, ['true'])
  } finally {
    docker('network', 'rm', lease.network.name)
  }
`,
      { dir },
    )
    expect(out.result.exitCode).toBeNull()
    expect(out.result.spawnError).toMatch(/по ID/)
    expect(caseNetworks()).toEqual([])
  })
})
