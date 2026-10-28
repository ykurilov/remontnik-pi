import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { asRoot, fakeSsh, removeGitStorageFixtures, storage, TEST_SSH_KEY, type FakeSsh, type StorageOptions } from '../../test/git-storage-fixtures.js'
import { localConfigReaderForTests, type ConfigCodeReader } from '../service/config-reader.js'
import { testRemontnikConfig } from '../testing/config.js'
import { checkDoctorConfig, formatFindings, type Finding } from './check-config.js'
import { runDoctorCommand } from './run-doctor-command.js'

// `remontnik-doctor check-config`: настройка, окружение, Docker и правила GitHub — до старта врача. Ответ — список
// «что не так и как исправить» без секретов и адресов; есть ошибки — код выхода не нулевой.

// Каждая проверка запускает десяток подставных docker, gh и git: под нагрузкой это дольше 5 секунд по умолчанию.
vi.setConfig({ testTimeout: 30_000 })

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  removeGitStorageFixtures()
})

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'remontnik-check-config-'))
  dirs.push(dir)
  return dir
}

const PIN = `@sha256:${'a'.repeat(64)}`
const SHARED = 'shared-secret-for-check-config-tests'
const OWNER = 'owner-secret-for-check-config-tests'
const BOT = 'check-config-bot-token-for-tests-only'

function git(dir: string, ...args: string[]): void {
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd: dir, stdio: 'pipe' })
}

/** Репозиторий приложения на основной ветке: настройка и, по желанию, файл служб. */
function appRepo(options: { config?: object; services?: string; deployFiles?: Record<string, { content: string; executable?: boolean } | null>; packageJson?: object } = {}): string {
  const repoDir = join(tempDir(), 'app')
  mkdirSync(repoDir)
  git(repoDir, 'init', '--quiet', '--initial-branch=main')
  git(repoDir, 'remote', 'add', 'origin', 'https://github.com/example-owner/example-app.git')
  const config = testRemontnikConfig()
  const raw = options.config ?? { ...config, forbidden: { schema: config.forbidden.schema, money: config.forbidden.money, access: config.forbidden.access } }
  writeFileSync(join(repoDir, 'remontnik.config.json'), JSON.stringify(raw))
  const deployFiles = options.deployFiles ?? { 'deploy.ts': { content: '// команды выкатки\n' } }
  for (const [name, file] of Object.entries(deployFiles)) {
    if (!file) continue
    mkdirSync(dirname(join(repoDir, name)), { recursive: true })
    writeFileSync(join(repoDir, name), file.content)
    if (file.executable) chmodSync(join(repoDir, name), 0o755)
  }
  if (options.packageJson) writeFileSync(join(repoDir, 'package.json'), JSON.stringify(options.packageJson))
  if (options.services !== undefined) {
    mkdirSync(join(repoDir, 'ci'))
    writeFileSync(join(repoDir, 'ci/services.yml'), options.services)
  }
  git(repoDir, 'add', '-A')
  git(repoDir, 'commit', '--quiet', '-m', 'настройка')
  return repoDir
}

function configWithServices(): object {
  const config = testRemontnikConfig()
  return {
    ...config,
    checks: { ...config.checks, services: 'ci/services.yml' },
    forbidden: { schema: config.forbidden.schema, money: config.forbidden.money, access: config.forbidden.access },
  }
}

interface DockerScenario {
  down?: boolean
  /** Сети, к которым подключён контейнер врача. */
  gatewayNetworks?: Record<string, string>
  /** gw_priority врача в его сетях: по умолчанию 0. */
  gwPriority?: Record<string, number>
  /** Опубликованные порты врача (`HostConfig.PortBindings`): у приложения в сети хоста. */
  portBindings?: Record<string, { HostIp: string; HostPort: string }[]>
  /** Сети случая: закрыта ли и без адреса моста. */
  caseNetworks?: { id: string; internal: boolean; inhibit: boolean }[]
  /** Все сети Docker с подсетями. */
  networks?: { name: string; subnet: string; caseNetwork?: boolean }[]
  /** Что docker пишет в stderr при отказе. */
  errorText?: string
  /** Как у врача смонтирована папка состояния: по умолчанию — тем же путём, что на хосте. */
  stateMount?: 'same' | 'volume'
  /** Контейнер службы браузера `remontnik-browser`: запущен ли и что отвечает `remontnik-browser check-policy`. */
  browser?: { running: boolean; problems?: string[]; oldImage?: boolean; noPolicy?: boolean }
  /** Образ верстака: скачан ли на сервер и какие из pnpm, yarn, corepack в нём есть. */
  workbench?: { pulled?: boolean; tools: string[] }
}

const HEALTHY_DOCKER: DockerScenario = {
  gatewayNetworks: { 'remontnik-app': '10.5.0.3' },
  caseNetworks: [{ id: 'case-net-1', internal: true, inhibit: true }],
  networks: [
    { name: 'bridge', subnet: '172.17.0.0/16' },
    { name: 'remontnik-app', subnet: '10.5.0.0/24' },
    { name: 'remontnik-case-1', subnet: '10.213.0.0/27', caseNetwork: true },
  ],
  // Как официальный образ Node 22: pnpm нет, corepack есть.
  workbench: { tools: ['corepack'] },
}

/** Подставной docker: node-скрипт отвечает по сценарию из соседнего JSON. */
function fakeDocker(scenario: DockerScenario): string {
  const dir = tempDir()
  writeFileSync(join(dir, 'scenario.json'), JSON.stringify(scenario))
  const file = join(dir, 'docker')
  writeFileSync(
    file,
    `#!/usr/bin/env node
const s = require(${JSON.stringify(join(dir, 'scenario.json'))})
const a = process.argv.slice(2)
const out = (text) => { process.stdout.write(text + '\\n'); process.exit(0) }
const fail = () => { process.stderr.write(s.errorText || 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock'); process.exit(1) }
if (s.down) fail()
if (a[0] === 'version') out('27.3.1')
if (a[0] === 'image' && a[1] === 'inspect') { if (!s.workbench || s.workbench.pulled === false) { process.stderr.write('Error: No such image: ' + a.at(-1)); process.exit(1) } out('sha256:' + 'b'.repeat(64)) }
if (a[0] === 'run' && a.includes('--network') && a[a.indexOf('--network') + 1] === 'none') out((s.workbench ? s.workbench.tools : []).join('\\n'))
if (a[0] === 'inspect' && a[2].includes('Mounts')) {
  const state = process.env.REMONTNIK_STATE_DIR
  out(JSON.stringify([{ Type: 'bind', Source: '/var/run/docker.sock', Destination: '/var/run/docker.sock' }, s.stateMount === 'volume' ? { Type: 'volume', Source: '/var/lib/docker/volumes/state/_data', Destination: state } : { Type: 'bind', Source: state, Destination: state }]))
}
if (a[0] === 'inspect' && a[2].includes('PortBindings')) out(JSON.stringify(s.portBindings || {}))
if (a[0] === 'inspect' && a.at(-1) === 'remontnik-browser') { if (!s.browser) { process.stderr.write('No such object: remontnik-browser'); process.exit(1) } out(String(s.browser.running)) }
if (a[0] === 'exec' && a[1] === 'remontnik-browser' && a[2] === 'remontnik-browser' && a[3] === 'check-policy') {
  if (!s.browser || !s.browser.running) fail()
  if (s.browser.oldImage) { process.stderr.write('remontnik-browser: нет команды check-policy\\n'); process.exit(2) }
  if (s.browser.noPolicy) { process.stderr.write('remontnik-browser: нужен путь к настройке или REMONTNIK_BROWSER_POLICY\\n\\nremontnik-browser check-policy [путь]\\n'); process.exit(2) }
  const problems = s.browser.problems || []
  process.stdout.write(JSON.stringify({ ok: problems.length === 0, problems }) + '\\n')
  process.exit(problems.length === 0 ? 0 : 1)
}
if (a[0] === 'inspect') { const name = a.at(-1); if (name !== 'remontnik-doctor') { process.stderr.write('No such object: ' + name); process.exit(1) } out(JSON.stringify(Object.fromEntries(Object.entries(s.gatewayNetworks || {}).map(([n, ip]) => [n, { IPAddress: ip, GwPriority: (s.gwPriority || {})[n] || 0 }])))) }
if (a[0] === 'network' && a[1] === 'ls') {
  if (a.includes('label=remontnik.case-network')) out((s.caseNetworks || []).map((n) => n.id).join('\\n'))
  out((s.networks || []).map((n) => n.name).join('\\n'))
}
if (a[0] === 'network' && a[1] === 'inspect') {
  const format = a[a.indexOf('--format') + 1]
  const targets = a.slice(a.indexOf('--format') + 2)
  if (format.includes('Internal')) { const n = (s.caseNetworks || []).find((c) => c.id === targets[0]); if (!n) fail(); out(n.id + ' ' + n.internal + ' ' + n.inhibit) }
  out(targets.map((t) => { const n = (s.networks || []).find((c) => c.name === t); return n.name + '|' + n.subnet + '|' + (n.caseNetwork ? 'checks' : '') }).join('\\n'))
}
fail()
`,
    { mode: 0o755 },
  )
  return file
}

interface Ruleset {
  id: number
  name: string
  target: 'branch' | 'tag'
  enforcement: string
  bypass_actors: unknown[]
  conditions: { ref_name: { include: string[]; exclude: string[] } }
  rules: { type: string }[]
}

const GOOD_RULESETS: Ruleset[] = [
  { id: 1, name: 'ветка', target: 'branch', enforcement: 'active', bypass_actors: [], conditions: { ref_name: { include: ['~DEFAULT_BRANCH'], exclude: [] } }, rules: [{ type: 'non_fast_forward' }, { type: 'deletion' }] },
  { id: 2, name: 'метки', target: 'tag', enforcement: 'active', bypass_actors: [], conditions: { ref_name: { include: ['refs/tags/remontnik/**'], exclude: [] } }, rules: [{ type: 'update' }, { type: 'deletion' }] },
]

/** Подставной gh: `api /repos/<o>/<r>/rulesets` и `.../rulesets/<id>`. */
function fakeGh(rulesets: Ruleset[]): string {
  const dir = tempDir()
  writeFileSync(join(dir, 'rulesets.json'), JSON.stringify(rulesets))
  const file = join(dir, 'gh')
  writeFileSync(
    file,
    `#!/usr/bin/env node
const rulesets = require(${JSON.stringify(join(dir, 'rulesets.json'))})
const path = process.argv.slice(2).find((arg) => arg.includes('/rulesets'))
if (!path || !path.startsWith('/repos/example-owner/example-app/')) { process.stderr.write('HTTP 404'); process.exit(1) }
const id = path.match(/rulesets\\/(\\d+)$/)
if (id) { process.stdout.write(JSON.stringify(rulesets.find((r) => r.id === Number(id[1])))); process.exit(0) }
process.stdout.write(JSON.stringify(rulesets.map(({ id, name, target, enforcement }) => ({ id, name, target, enforcement }))))
`,
    { mode: 0o755 },
  )
  return file
}

function serverEnv(repoDir: string, overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    REMONTNIK_CONFIG_REPO_DIR: repoDir,
    REMONTNIK_STATE_DIR: join(repoDir, '..', 'state'),
    REMONTNIK_SHARED_SECRET: SHARED,
    REMONTNIK_CONTROL_SECRET: OWNER,
    REMONTNIK_GATEWAY_CONTAINER: 'remontnik-doctor',
    REMONTNIK_LISTEN_NETWORK: 'remontnik-app',
    DEEPSEEK_API_KEY: 'deepseek-check-config-test-key',
    OPENROUTER_API_KEY: 'openrouter-check-config-test-key',
    TEST_ALERT_BOT_TOKEN: BOT,
    TEST_ALERT_CHAT_ID: '-1001234567890',
    ...overrides,
  }
}

/** PATH, где docker и gh — подставные, а git — настоящий. */
const pathWith = (...binaries: string[]) => [...binaries.map((binary) => dirname(binary)), process.env.PATH].join(':')

const errors = (findings: { level: string; problem: string }[]) => findings.filter((finding) => finding.level === 'error').map((finding) => finding.problem)
const warnings = (findings: { level: string; problem: string }[]) => findings.filter((finding) => finding.level === 'warning').map((finding) => finding.problem)

describe('check-config: всё в порядке', () => {
  it('настройка, окружение, Docker и правила GitHub — без ошибок и предупреждений', async () => {
    const repoDir = appRepo()
    const findings = await checkDoctorConfig(serverEnv(repoDir), { docker: fakeDocker(HEALTHY_DOCKER), gh: fakeGh(GOOD_RULESETS) })
    expect(errors(findings)).toEqual([])
    expect(warnings(findings)).toEqual([])
    expect(findings.filter((finding) => finding.level === 'ok').map((finding) => finding.area)).toEqual(
      expect.arrayContaining(['настройка', 'окружение', 'docker', 'сети', 'github']),
    )
  })

  it('через remontnik-doctor check-config: код 0 и итог в выводе', async () => {
    const repoDir = appRepo()
    let out = ''
    const code = await runDoctorCommand(['check-config'], {
      env: { ...serverEnv(repoDir), PATH: pathWith(fakeDocker(HEALTHY_DOCKER), fakeGh(GOOD_RULESETS)) },
      stdout: (text) => (out += text),
      stderr: (text) => (out += text),
    })
    expect(code).toBe(0)
    expect(out).toMatch(/ошибок нет/)
  })
})

describe('check-config: файлы команд выкатки', () => {
  const withCommands = (commands: Record<string, string>, deployFiles: NonNullable<Parameters<typeof appRepo>[0]>['deployFiles']): string => {
    const base = testRemontnikConfig()
    const config = { ...base, deploy: { ...base.deploy, commands: { ...base.deploy.commands, ...commands } }, forbidden: { schema: base.forbidden.schema, money: base.forbidden.money, access: base.forbidden.access } }
    return appRepo({ config, deployFiles })
  }
  const check = (repoDir: string) => checkDoctorConfig(serverEnv(repoDir), { docker: fakeDocker(HEALTHY_DOCKER), gh: fakeGh(GOOD_RULESETS) })

  it('файла команды нет в основной ветке — ошибка с именем файла', async () => {
    const findings = await check(appRepo({ deployFiles: {} }))
    expect(errors(findings).join('\n')).toContain('deploy.ts')
  })

  it('команда запускает файл напрямую, а бита исполнения нет — ошибка', async () => {
    const repoDir = withCommands({ build: './deploy/build.sh' }, { 'deploy.ts': { content: '//\n' }, 'deploy/build.sh': { content: '#!/bin/sh\nexit 0\n' } })
    expect(errors(await check(repoDir)).join('\n')).toContain('deploy/build.sh')
  })

  it('синтаксическая ошибка в скрипте на node — ошибка, сама команда не запускается', async () => {
    const marker = join(tempDir(), 'ran')
    const repoDir = withCommands({ build: 'node deploy.mjs build' }, { 'deploy.ts': { content: '//\n' }, 'deploy.mjs': { content: `import { writeFileSync } from 'node:fs'\nwriteFileSync(${JSON.stringify(marker)}, 'x')\nconst = \n` } })
    expect(errors(await check(repoDir)).join('\n')).toContain('deploy.mjs')
    expect(() => execFileSync('test', ['-e', marker])).toThrow()
  })

  it('исполняемый скрипт и рабочий скрипт на node — без ошибок', async () => {
    const repoDir = withCommands(
      { build: './deploy/build.sh', promote: 'node deploy.mjs promote' },
      { 'deploy.ts': { content: '//\n' }, 'deploy/build.sh': { content: '#!/bin/sh\nexit 0\n', executable: true }, 'deploy.mjs': { content: 'console.log(1)\n' } },
    )
    expect(errors(await check(repoDir))).toEqual([])
  })

  it('в команде pnpm или curl — предупреждение: в контейнере врача их нет', async () => {
    const repoDir = withCommands({ build: 'pnpm build' }, { 'deploy.ts': { content: '//\n' } })
    expect(warnings(await check(repoDir)).join('\n')).toContain('pnpm')
  })
})

describe('check-config: папка сценариев eval', () => {
  const withEval = (scenariosDir: string | undefined, closedPaths: string[], files: string[], evalScope: object[] = []): string => {
    const base = testRemontnikConfig()
    const evalCheck = { run: 'node evals/run.mjs', resultFile: 'out.json', env: [], ...(scenariosDir ? { scenariosDir } : {}) }
    const config = { ...base, checks: { ...base.checks, eval: evalCheck }, closedPaths, evalScope, forbidden: { schema: base.forbidden.schema, money: base.forbidden.money, access: base.forbidden.access } }
    return appRepo({ config, deployFiles: { 'deploy.ts': { content: '//\n' }, ...Object.fromEntries(files.map((file) => [file, { content: '{}\n' }])) } })
  }
  const check = (repoDir: string) => checkDoctorConfig(serverEnv(repoDir), { docker: fakeDocker(HEALTHY_DOCKER), gh: fakeGh(GOOD_RULESETS) })

  it('сценарии не в eval/scenarios, а scenariosDir не задан — ошибка про закрытый путь и предупреждение про папку', async () => {
    const findings = await check(withEval(undefined, ['evals/scenarios/private*'], ['evals/scenarios/private.json'], [{ paths: ['src/**'], scenarios: ['private'] }]))
    expect(errors(findings).join('\n')).toContain('evals/scenarios/private*')
    expect(warnings(findings).join('\n')).toContain('eval/scenarios')
  })

  it('scenariosDir указывает на настоящую папку, закрытые пути в ней — без ошибок и предупреждений про eval', async () => {
    const findings = await check(withEval('evals/scenarios', ['evals/scenarios/private*', 'evals/**/secret*', 'exports/**'], ['evals/scenarios/private.json']))
    expect([...errors(findings), ...warnings(findings)].filter((text) => text.includes('eval'))).toEqual([])
  })

  it('отложенные сценарии в соседней закрытой папке, evalScope называет только сценарии из scenariosDir — ни ошибки, ни предупреждения', async () => {
    const repoDir = withEval('evals/scenarios', ['evals/scenarios-holdout/**'], ['evals/scenarios/open.json', 'evals/scenarios-holdout/hidden.json'], [{ paths: ['src/**'], scenarios: ['open'] }])
    const findings = await check(repoDir)
    expect([...errors(findings), ...warnings(findings)].filter((text) => text.includes('eval'))).toEqual([])
  })

  it('сценарий из evalScope лежит под закрытой маской вне scenariosDir — ошибка с названием сценария', async () => {
    const repoDir = withEval('evals/scenarios', ['evals/scenarios-holdout/**'], ['evals/scenarios/open.json', 'evals/scenarios-holdout/hidden.json'], [{ paths: ['src/**'], scenarios: ['open', 'hidden'] }])
    const problems = errors(await check(repoDir)).join('\n')
    expect(problems).toContain('hidden')
    expect(problems).toContain('evals/scenarios-holdout/**')
  })
})

describe('check-config: окружение', () => {
  it('все недостающие переменные — сразу списком, у каждой — как исправить', async () => {
    const repoDir = appRepo()
    const env = serverEnv(repoDir, { REMONTNIK_SHARED_SECRET: undefined, DEEPSEEK_API_KEY: undefined, TEST_ALERT_BOT_TOKEN: '', REMONTNIK_GATEWAY_CONTAINER: undefined })
    const findings = await checkDoctorConfig(env, { docker: fakeDocker(HEALTHY_DOCKER), gh: fakeGh(GOOD_RULESETS) })
    const problems = errors(findings).join('\n')
    for (const name of ['REMONTNIK_SHARED_SECRET', 'DEEPSEEK_API_KEY', 'TEST_ALERT_BOT_TOKEN', 'REMONTNIK_GATEWAY_CONTAINER']) expect(problems).toContain(name)
    const shared = findings.find((finding) => finding.problem.includes('REMONTNIK_SHARED_SECRET'))!
    expect(shared.fix).toMatch(/secret-handoff/)
  })

  it('секрет владельца совпадает с общим — ошибка; не задан — предупреждение', async () => {
    const repoDir = appRepo()
    const docker = fakeDocker(HEALTHY_DOCKER)
    const gh = fakeGh(GOOD_RULESETS)
    const same = await checkDoctorConfig(serverEnv(repoDir, { REMONTNIK_CONTROL_SECRET: SHARED }), { docker, gh })
    expect(errors(same).join('\n')).toMatch(/REMONTNIK_CONTROL_SECRET.*совпадает/)
    const missing = await checkDoctorConfig(serverEnv(repoDir, { REMONTNIK_CONTROL_SECRET: undefined }), { docker, gh })
    expect(errors(missing)).toEqual([])
    expect(warnings(missing).join('\n')).toMatch(/REMONTNIK_CONTROL_SECRET/)
  })

  it('секреты: короче 32 знаков или секрет моста равен общему или владельца — ошибка, без значений в тексте', async () => {
    const paseo = { bridgeUrlEnv: 'TEST_BRIDGE_URL', bridgeSecretEnv: 'TEST_BRIDGE_SECRET', listenEnv: 'TEST_BRIDGE_LISTEN', acceptTimeoutMs: 300_000, workTimeoutMs: 3_600_000 }
    const config = testRemontnikConfig({ handoff: { mode: 'paseo-first', paseo } })
    const repoDir = appRepo({ config: { ...config, forbidden: { schema: config.forbidden.schema, money: config.forbidden.money, access: config.forbidden.access } } })
    const docker = fakeDocker(HEALTHY_DOCKER)
    const gh = fakeGh(GOOD_RULESETS)
    const bridgeEnv = (overrides: Record<string, string | undefined>) =>
      serverEnv(repoDir, { TEST_BRIDGE_URL: 'http://10.0.0.2:7900', TEST_BRIDGE_LISTEN: '10.0.0.1:7820', TEST_BRIDGE_SECRET: 'bridge-secret-for-check-config-tests', ...overrides })
    expect(errors(await checkDoctorConfig(bridgeEnv({}), { docker, gh }))).toEqual([])

    const same = errors(await checkDoctorConfig(bridgeEnv({ TEST_BRIDGE_SECRET: SHARED }), { docker, gh }))
    expect(same).toEqual(['TEST_BRIDGE_SECRET совпадает с REMONTNIK_SHARED_SECRET'])
    const owner = errors(await checkDoctorConfig(bridgeEnv({ TEST_BRIDGE_SECRET: OWNER }), { docker, gh }))
    expect(owner).toEqual(['TEST_BRIDGE_SECRET совпадает с REMONTNIK_CONTROL_SECRET'])
    const short = await checkDoctorConfig(bridgeEnv({ REMONTNIK_SHARED_SECRET: 'too-short-secret' }), { docker, gh })
    expect(errors(short)).toEqual(['REMONTNIK_SHARED_SECRET короче 32 знаков'])
    expect(JSON.stringify(short)).not.toContain('too-short-secret')
  })

  it('ключи провайдеров eval из настройки нужны врачу', async () => {
    const config = testRemontnikConfig()
    const raw = {
      ...config,
      checks: {
        ...config.checks,
        eval: {
          run: 'node eval/run.mjs',
          resultFile: 'eval/out.json',
          env: [],
          providers: [{ name: 'deepseek', baseUrlEnv: 'EVAL_BASE_URL', keyEnv: 'EVAL_DEEPSEEK_KEY', upstream: 'https://api.example.com', models: { m: { input: 1, output: 1 } } }],
          proxy: {},
        },
      },
      forbidden: { schema: config.forbidden.schema, money: config.forbidden.money, access: config.forbidden.access },
    }
    const findings = await checkDoctorConfig(serverEnv(appRepo({ config: raw })), { docker: fakeDocker(HEALTHY_DOCKER), gh: fakeGh(GOOD_RULESETS) })
    expect(errors(findings).join('\n')).toContain('EVAL_DEEPSEEK_KEY')
  })

  it('переменные заголовков к upstream нужны врачу', async () => {
    const config = testRemontnikConfig()
    const raw = {
      ...config,
      checks: {
        ...config.checks,
        eval: {
          run: 'node eval/run.mjs',
          resultFile: 'eval/out.json',
          env: [],
          providers: [{ name: 'deepseek', baseUrlEnv: 'EVAL_BASE_URL', keyEnv: 'EVAL_DEEPSEEK_KEY', upstream: 'https://api.example.com', upstreamHeaders: [{ name: 'x-gateway-pass', valueEnv: 'EVAL_GATEWAY_PASS' }], models: { m: { input: 1, output: 1 } } }],
          proxy: {},
        },
      },
      forbidden: { schema: config.forbidden.schema, money: config.forbidden.money, access: config.forbidden.access },
    }
    const findings = await checkDoctorConfig(serverEnv(appRepo({ config: raw }), { EVAL_DEEPSEEK_KEY: 'k'.repeat(20) }), { docker: fakeDocker(HEALTHY_DOCKER), gh: fakeGh(GOOD_RULESETS) })
    const text = errors(findings).join('\n')
    expect(text).toContain('EVAL_GATEWAY_PASS')
    expect(text).not.toContain('EVAL_DEEPSEEK_KEY')
  })

  it('слушать все адреса нельзя — ошибка с причиной', async () => {
    const repoDir = appRepo()
    const findings = await checkDoctorConfig(serverEnv(repoDir, { REMONTNIK_LISTEN_NETWORK: undefined, REMONTNIK_LISTEN: '0.0.0.0:7800' }), { docker: fakeDocker(HEALTHY_DOCKER), gh: fakeGh(GOOD_RULESETS) })
    expect(errors(findings).join('\n')).toMatch(/REMONTNIK_LISTEN/)
  })
})

describe('check-config: настройка', () => {
  it('нет каталога настройки — ошибка, дальше настройку не проверяем', async () => {
    const findings = await checkDoctorConfig(serverEnv('', { REMONTNIK_CONFIG_REPO_DIR: undefined }), { docker: fakeDocker(HEALTHY_DOCKER), gh: fakeGh(GOOD_RULESETS) })
    expect(errors(findings).join('\n')).toContain('REMONTNIK_CONFIG_REPO_DIR')
  })

  it('origin у allowedMutations вне allowedOrigins — ошибка настройки', async () => {
    const config = testRemontnikConfig()
    const raw = {
      ...config,
      forbidden: { schema: config.forbidden.schema, money: config.forbidden.money, access: config.forbidden.access },
      browser: { enabled: true, profile: 'remontnik', allowedOrigins: ['https://app.example.com'], allowedMutations: [{ method: 'POST', pathPattern: '/login', origin: 'https://auth.example.net' }], pagesToCheck: [] },
    }
    const findings = await checkDoctorConfig(serverEnv(appRepo({ config: raw })), { docker: fakeDocker(HEALTHY_DOCKER), gh: fakeGh(GOOD_RULESETS) })
    expect(errors(findings).join('\n')).toMatch(/browser\.allowedMutations\.0\.origin/)
  })

  it('настройка с ошибками — каждое поле отдельно', async () => {
    const repoDir = appRepo({ config: { app: { name: 'demo' } } })
    const findings = await checkDoctorConfig(serverEnv(repoDir), { docker: fakeDocker(HEALTHY_DOCKER), gh: fakeGh(GOOD_RULESETS) })
    const problems = errors(findings).filter((problem) => /repo|workbench|checks/.test(problem))
    expect(problems.length).toBeGreaterThanOrEqual(3)
  })

  it('настройка подключает файл из fixablePaths — предупреждение: врач его не правит; файл вне fixablePaths — нет', async () => {
    const config = testRemontnikConfig()
    const data = { ...config, forbidden: { schema: config.forbidden.schema, money: config.forbidden.money, access: config.forbidden.access } }
    const repoDir = join(tempDir(), 'app')
    mkdirSync(join(repoDir, 'src'), { recursive: true })
    git(repoDir, 'init', '--quiet', '--initial-branch=main')
    git(repoDir, 'remote', 'add', 'origin', 'https://github.com/example-owner/example-app.git')
    writeFileSync(join(repoDir, 'deploy.ts'), '// команды выкатки\n')
    writeFileSync(join(repoDir, 'src/shared-names.mjs'), `export const NAME = ${JSON.stringify(data.app.name)}\n`)
    writeFileSync(join(repoDir, 'remontnik.config.shared.mjs'), `export const CHECKS = ${JSON.stringify(data.checks)}\n`)
    writeFileSync(
      join(repoDir, 'remontnik.config.mjs'),
      `import { NAME } from './src/shared-names.mjs'\nimport { CHECKS } from './remontnik.config.shared.mjs'\nexport default { ...${JSON.stringify(data)}, app: { name: NAME }, checks: CHECKS }\n`,
    )
    git(repoDir, 'add', '-A')
    git(repoDir, 'commit', '--quiet', '-m', 'настройка')

    const findings = await checkDoctorConfig(serverEnv(repoDir), { docker: fakeDocker(HEALTHY_DOCKER), gh: fakeGh(GOOD_RULESETS), configReader: localConfigReaderForTests() })

    expect(errors(findings)).toEqual([])
    expect(warnings(findings)).toHaveLength(1)
    expect(warnings(findings)[0]).toContain('src/shared-names.mjs')
    expect(warnings(findings)[0]).toContain('fixablePaths')
    expect(warnings(findings)[0]).toContain('только отчёт человеку')
  })

  it('check-config запущен не из образа врача (на хосте) — ошибка «запускайте внутри контейнера врача», а не «Cannot find package»', async () => {
    const config = testRemontnikConfig()
    const data = { ...config, forbidden: { schema: config.forbidden.schema, money: config.forbidden.money, access: config.forbidden.access } }
    const repoDir = join(tempDir(), 'app')
    mkdirSync(repoDir)
    git(repoDir, 'init', '--quiet', '--initial-branch=main')
    git(repoDir, 'remote', 'add', 'origin', 'https://github.com/example-owner/example-app.git')
    writeFileSync(join(repoDir, 'deploy.ts'), '// команды выкатки\n')
    writeFileSync(join(repoDir, 'remontnik.config.mjs'), `import { defineRemontnikConfig } from '@ykurilov/remontnik-core/config'\nexport default defineRemontnikConfig(${JSON.stringify(data)})\n`)
    git(repoDir, 'add', '-A')
    git(repoDir, 'commit', '--quiet', '-m', 'настройка')
    // Контейнер чтения из образа врача: пути пакетов процесса, запустившего чтение, в нём нет.
    const local = localConfigReaderForTests()
    const hostOnlyPaths: ConfigCodeReader = {
      ...local,
      run: (input) => {
        const hooks = JSON.parse(input.args.at(-1)!) as Record<string, unknown>
        const args = [...input.args.slice(0, -1), JSON.stringify({ ...hooks, base: pathToFileURL(join(tempDir(), 'host', 'config-source.js')).href, sourceRoot: null })]
        return local.run({ ...input, args })
      },
    }

    const findings = await checkDoctorConfig(serverEnv(repoDir), { docker: fakeDocker(HEALTHY_DOCKER), gh: fakeGh(GOOD_RULESETS), configReader: hostOnlyPaths })

    const settings = findings.filter((finding) => finding.area === 'настройка' && finding.level === 'error')
    expect(settings).toHaveLength(1)
    expect(settings[0]!.problem).toContain('не из своего контейнера')
    expect(settings[0]!.problem).not.toContain('Cannot find package')
    expect(settings[0]!.fix).toContain('exec doctor remontnik-doctor check-config')
  })

  it('код настройки без контейнера врача не выполняется: нет REMONTNIK_GATEWAY_CONTAINER — ошибка, а не чтение в процессе врача', async () => {
    const repoDir = join(tempDir(), 'app')
    mkdirSync(repoDir, { recursive: true })
    git(repoDir, 'init', '--quiet', '--initial-branch=main')
    writeFileSync(join(repoDir, 'remontnik.config.mjs'), `export default ${JSON.stringify(testRemontnikConfig())}\n`)
    writeFileSync(join(repoDir, 'deploy.ts'), '// команды выкатки\n')
    git(repoDir, 'add', '-A')
    git(repoDir, 'commit', '--quiet', '-m', 'настройка')

    const findings = await checkDoctorConfig(serverEnv(repoDir, { REMONTNIK_GATEWAY_CONTAINER: undefined }), { docker: fakeDocker(HEALTHY_DOCKER), gh: fakeGh(GOOD_RULESETS) })

    expect(errors(findings).join('\n')).toContain('только в контейнере')
  })

  it('файл служб в fixablePaths — ошибка чтения настройки', async () => {
    const raw = { ...configWithServices(), fixablePaths: ['src/**', 'ci/**'] }
    const findings = await checkDoctorConfig(serverEnv(appRepo({ config: raw, services: `services:\n  db:\n    image: postgres${PIN}\n` })), { docker: fakeDocker(HEALTHY_DOCKER), gh: fakeGh(GOOD_RULESETS) })
    expect(errors(findings).join('\n')).toMatch(/checks\.services.*fixablePaths/)
  })

  it('образ службы без закрепления и подстановка $VAR — ошибки', async () => {
    const services = `services:\n  db:\n    image: postgres:17\n`
    const findings = await checkDoctorConfig(serverEnv(appRepo({ config: configWithServices(), services })), { docker: fakeDocker(HEALTHY_DOCKER), gh: fakeGh(GOOD_RULESETS) })
    expect(errors(findings).join('\n')).toMatch(/services\.db\.image.*@sha256/)
  })

  it('закреплённые службы — в порядке', async () => {
    const services = `services:\n  db:\n    image: postgres${PIN}\n`
    const findings = await checkDoctorConfig(serverEnv(appRepo({ config: configWithServices(), services })), { docker: fakeDocker(HEALTHY_DOCKER), gh: fakeGh(GOOD_RULESETS) })
    expect(errors(findings)).toEqual([])
    expect(findings.some((finding) => finding.level === 'ok' && finding.area === 'службы')).toBe(true)
  })

  it('файла служб нет в основной ветке — ошибка', async () => {
    const findings = await checkDoctorConfig(serverEnv(appRepo({ config: configWithServices() })), { docker: fakeDocker(HEALTHY_DOCKER), gh: fakeGh(GOOD_RULESETS) })
    expect(errors(findings).join('\n')).toMatch(/ci\/services\.yml/)
  })
})

describe('check-config: pnpm и yarn в образе верстака', () => {
  const withWorkbench = (workbench: { install: string; test?: string }, packageJson?: object): string => {
    const base = testRemontnikConfig()
    const config = {
      ...base,
      workbench: { ...base.workbench, install: workbench.install },
      checks: { ...base.checks, test: workbench.test ?? base.checks.test },
      forbidden: { schema: base.forbidden.schema, money: base.forbidden.money, access: base.forbidden.access },
    }
    return appRepo({ config, ...(packageJson ? { packageJson } : {}) })
  }
  const check = (repoDir: string, workbench: DockerScenario['workbench']) =>
    checkDoctorConfig(serverEnv(repoDir), { docker: fakeDocker({ ...HEALTHY_DOCKER, workbench }), gh: fakeGh(GOOD_RULESETS) })
  const about = (findings: Finding[]) => findings.filter((finding) => finding.area === 'верстак')

  it('ни pnpm, ни corepack в образе — ошибка до первого случая: установка упала бы с «pnpm: not found»', async () => {
    const findings = await check(withWorkbench({ install: 'pnpm install --frozen-lockfile' }, { packageManager: 'pnpm@10.33.2' }), { tools: [] })
    const problem = about(findings).find((finding) => finding.level === 'error')
    expect(problem?.problem).toMatch(/pnpm.*corepack/)
    expect(problem?.fix).toMatch(/node:22|corepack/)
  })

  it('yarn нет, а в образе только pnpm — ошибка про yarn', async () => {
    const findings = await check(withWorkbench({ install: 'yarn install --immutable', test: 'yarn test' }, { packageManager: 'yarn@4.5.0' }), { tools: ['pnpm'] })
    expect(about(findings).filter((finding) => finding.level === 'error').map((finding) => finding.problem).join('\n')).toMatch(/yarn/)
  })

  it('pnpm через corepack и packageManager закреплён — в порядке', async () => {
    const findings = await check(withWorkbench({ install: 'pnpm install --frozen-lockfile' }, { packageManager: 'pnpm@10.33.2' }), { tools: ['corepack'] })
    expect(errors(findings)).toEqual([])
    expect(warnings(findings)).toEqual([])
    expect(about(findings)).toEqual([expect.objectContaining({ level: 'ok', problem: expect.stringMatching(/corepack/) })])
  })

  it('pnpm через corepack, а packageManager в package.json нет — предупреждение: версия pnpm не та, что у файла-замка', async () => {
    const findings = await check(withWorkbench({ install: 'pnpm install --frozen-lockfile' }, { name: 'app' }), { tools: ['corepack'] })
    expect(errors(findings)).toEqual([])
    expect(about(findings).find((finding) => finding.level === 'warning')?.problem).toMatch(/packageManager/)
  })

  it('свой pnpm в образе — в порядке', async () => {
    const findings = await check(withWorkbench({ install: 'pnpm install --frozen-lockfile' }, { name: 'app' }), { tools: ['pnpm'] })
    expect(about(findings)).toEqual([expect.objectContaining({ level: 'ok' })])
  })

  it('образа верстака на сервере нет — предупреждение: проверить нельзя', async () => {
    const findings = await check(withWorkbench({ install: 'pnpm install --frozen-lockfile' }), { pulled: false, tools: [] })
    expect(errors(findings)).toEqual([])
    expect(about(findings).find((finding) => finding.level === 'warning')?.fix).toMatch(/docker pull/)
  })

  it('npm-проект — образ на pnpm и yarn не проверяется', async () => {
    const findings = await check(withWorkbench({ install: 'npm ci', test: 'npm test' }, { name: 'app' }), { tools: [] })
    expect(about(findings)).toEqual([])
  })
})

describe('check-config: Docker и сети', () => {
  it('папка состояния у врача смонтирована не тем же путём, что на хосте — ошибка: копию файлов настройки контейнер чтения не увидит', async () => {
    const findings = await checkDoctorConfig(serverEnv(appRepo()), { docker: fakeDocker({ ...HEALTHY_DOCKER, stateMount: 'volume' }), gh: fakeGh(GOOD_RULESETS) })
    const problem = findings.find((finding) => finding.level === 'error' && finding.problem.includes('REMONTNIK_STATE_DIR'))
    expect(problem).toMatchObject({ area: 'docker', problem: expect.stringContaining('не тем же путём') })
    expect(problem!.fix).toContain('одинаковым путём')
  })

  it('Docker недоступен — ошибка, остальные проверки Docker не идут', async () => {
    const findings = await checkDoctorConfig(serverEnv(appRepo()), { docker: fakeDocker({ down: true }), gh: fakeGh(GOOD_RULESETS) })
    const problems = errors(findings).filter((problem) => /docker/i.test(problem))
    expect(problems).toHaveLength(1)
  })

  it('контейнера врача нет в сети приложения — ошибка', async () => {
    const findings = await checkDoctorConfig(serverEnv(appRepo()), { docker: fakeDocker({ ...HEALTHY_DOCKER, gatewayNetworks: { bridge: '172.17.0.2' } }), gh: fakeGh(GOOD_RULESETS) })
    expect(errors(findings).join('\n')).toMatch(/remontnik-app/)
  })

  describe('приложение в сети хоста: приём на 127.0.0.1 сервера', () => {
    const hostApp: DockerScenario = {
      ...HEALTHY_DOCKER,
      gatewayNetworks: { 'remontnik-app': '10.5.0.3', 'remontnik-outside': '10.6.0.2' },
      gwPriority: { 'remontnik-app': 1 },
      portBindings: { '7800/tcp': [{ HostIp: '127.0.0.1', HostPort: '7800' }] },
    }
    const dockerErrors = async (scenario: DockerScenario) =>
      (await checkDoctorConfig(serverEnv(appRepo()), { docker: fakeDocker(scenario), gh: fakeGh(GOOD_RULESETS) })).filter((finding) => finding.level === 'error' && finding.area === 'docker')

    it('порт на 127.0.0.1 и сеть приёма с высшим gw_priority — ошибок нет', async () => {
      expect(await dockerErrors(hostApp)).toEqual([])
    })

    it('порт опубликован не только на 127.0.0.1 — ошибка', async () => {
      for (const HostIp of ['', '0.0.0.0', '::', '10.0.0.5']) {
        const found = await dockerErrors({ ...hostApp, portBindings: { '7800/tcp': [{ HostIp: '127.0.0.1', HostPort: '7800' }, { HostIp, HostPort: '7801' }] } })
        expect(found.map((finding) => finding.problem).join('\n')).toMatch(/127\.0\.0\.1/)
      }
    })

    it('у сети приёма gw_priority не выше остальных — ошибка: порт ведёт не туда, где слушает врач', async () => {
      for (const gwPriority of [{}, { 'remontnik-app': 1, 'remontnik-outside': 1 }, { 'remontnik-outside': 2, 'remontnik-app': 1 }]) {
        const found = await dockerErrors({ ...hostApp, gwPriority })
        expect(found.map((finding) => `${finding.problem} ${finding.fix}`).join('\n')).toMatch(/gw_priority/)
      }
    })
  })

  it('сеть случая не закрыта или с адресом моста — ошибка', async () => {
    const docker = fakeDocker({ ...HEALTHY_DOCKER, caseNetworks: [{ id: 'open-net', internal: false, inhibit: true }, { id: 'bridged-net', internal: true, inhibit: false }] })
    const problems = errors(await checkDoctorConfig(serverEnv(appRepo()), { docker, gh: fakeGh(GOOD_RULESETS) })).join('\n')
    expect(problems).toMatch(/open-net.*не закрыта/)
    expect(problems).toMatch(/bridged-net/)
  })

  it('пул подсетей случая пересекается с чужой сетью — ошибка с именем сети, без подсетей', async () => {
    const docker = fakeDocker({ ...HEALTHY_DOCKER, networks: [...HEALTHY_DOCKER.networks!, { name: 'office-vpn', subnet: '10.213.128.0/20' }] })
    const findings = await checkDoctorConfig(serverEnv(appRepo()), { docker, gh: fakeGh(GOOD_RULESETS) })
    const problem = errors(findings).join('\n')
    expect(problem).toMatch(/REMONTNIK_CASE_SUBNETS.*office-vpn/)
    expect(formatFindings(findings, {})).not.toMatch(/10\.213\.128/)
  })
})

describe('check-config: настройка службы браузера', () => {
  const withBrowser = (repoDir: string) => serverEnv(repoDir, { REMONTNIK_BROWSER_URL: 'http://remontnik-browser:7700' })
  const browserFindings = async (browser: DockerScenario['browser']) =>
    (await checkDoctorConfig(withBrowser(appRepo()), { docker: fakeDocker({ ...HEALTHY_DOCKER, ...(browser ? { browser } : {}) }), gh: fakeGh(GOOD_RULESETS) })).filter(
      (finding) => finding.area === 'браузер',
    )

  it('без службы браузера у врача проверки нет', async () => {
    const findings = await checkDoctorConfig(serverEnv(appRepo()), { docker: fakeDocker(HEALTHY_DOCKER), gh: fakeGh(GOOD_RULESETS) })
    expect(findings.filter((finding) => finding.area === 'браузер')).toEqual([])
  })

  it('настройка верна — ok; неверна — ошибка на каждое поле с подсказкой', async () => {
    expect(await browserFindings({ running: true })).toEqual([expect.objectContaining({ level: 'ok' })])
    const wrong = await browserFindings({ running: true, problems: ['extraOrigins.0: внутренний адрес в extraOrigins не пускается', 'allowedOrigins: мало'] })
    expect(wrong.map((finding) => [finding.level, finding.problem])).toEqual([
      ['error', expect.stringContaining('extraOrigins.0: внутренний адрес')],
      ['error', expect.stringContaining('allowedOrigins: мало')],
    ])
    expect(wrong[0]!.fix).toContain('browser-policy.json')
  })

  it('контейнер не запущен, не найден или со старым образом — предупреждение, не ошибка', async () => {
    for (const browser of [{ running: false }, undefined, { running: true, oldImage: true }]) {
      expect((await browserFindings(browser)).map((finding) => finding.level)).toEqual(['warning'])
    }
    expect((await browserFindings({ running: true, oldImage: true }))[0]!.problem).toMatch(/образ старее врача/)
  })

  it('в контейнере не задан REMONTNIK_BROWSER_POLICY — так и сказано, а не «образ старее»', async () => {
    const [finding] = await browserFindings({ running: true, noPolicy: true })
    expect(finding).toMatchObject({ level: 'warning', problem: expect.stringContaining('не задан REMONTNIK_BROWSER_POLICY') })
    expect(finding!.problem).not.toMatch(/старее/)
  })

  it('ответ контейнера ограничен: не больше 10 ошибок, короткие строки, без управляющих знаков', async () => {
    const many = Array.from({ length: 14 }, (_, index) => `поле${index}: ${'x'.repeat(500)}\u001b[31m\u202e`)
    const findings = await browserFindings({ running: true, problems: many })
    expect(findings).toHaveLength(11)
    expect(findings.at(-1)!.problem).toContain('ещё 4 ошибок')
    for (const finding of findings) {
      expect(finding.problem.length).toBeLessThan(260)
      expect(finding.problem).not.toMatch(/[\u0000-\u001f\u202e]/)
    }
  })
})

describe('check-config: правила GitHub', () => {
  it('gh не найден — предупреждение, не ошибка', async () => {
    const findings = await checkDoctorConfig(serverEnv(appRepo()), { docker: fakeDocker(HEALTHY_DOCKER), gh: join(tempDir(), 'no-gh') })
    expect(errors(findings)).toEqual([])
    expect(warnings(findings).join('\n')).toMatch(/gh/)
  })

  it('нет набора для меток, а у ветки нет запрета удаления — ошибки с подсказкой deploy/github-ruleset.json', async () => {
    const branchOnly = [{ ...GOOD_RULESETS[0]!, rules: [{ type: 'non_fast_forward' }] }]
    const findings = await checkDoctorConfig(serverEnv(appRepo()), { docker: fakeDocker(HEALTHY_DOCKER), gh: fakeGh(branchOnly) })
    const github = findings.filter((finding) => finding.area === 'github' && finding.level === 'error')
    expect(github.map((finding) => finding.problem).join('\n')).toMatch(/меток/)
    expect(github.map((finding) => finding.problem).join('\n')).toMatch(/deletion/)
    expect(github[0]!.fix).toContain('deploy/github-ruleset.json')
  })

  it('набор выключен или с обходами — не считается', async () => {
    const lax = [{ ...GOOD_RULESETS[0]!, enforcement: 'evaluate' }, { ...GOOD_RULESETS[1]!, bypass_actors: [{ actor_type: 'RepositoryRole' }] }]
    const problems = errors(await checkDoctorConfig(serverEnv(appRepo()), { docker: fakeDocker(HEALTHY_DOCKER), gh: fakeGh(lax) })).join('\n')
    expect(problems).toMatch(/ветк/)
    expect(problems).toMatch(/меток/)
  })
})

describe('check-config: своё хранилище по SSH', () => {
  const KNOWN_HOSTS = 'storage.invalid ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOnlyForCheckConfigTests'
  const KEY_BASE64 = Buffer.from(TEST_SSH_KEY).toString('base64')

  /** Приложение, чей origin — своё хранилище по SSH; в main два коммита, чтобы было что «перезаписать». */
  function ownStorage(options: StorageOptions = {}) {
    const repoDir = appRepo()
    writeFileSync(join(repoDir, 'notes.txt'), 'второй\n')
    git(repoDir, 'add', '-A')
    git(repoDir, 'commit', '--quiet', '-m', 'второй')
    const store = storage({ ...options, source: repoDir })
    git(repoDir, 'remote', 'set-url', 'origin', `ssh://git@storage.invalid${store.bare}`)
    return { repoDir, store }
  }

  const sshEnv = (repoDir: string, overrides: Record<string, string | undefined> = {}) =>
    serverEnv(repoDir, { REMONTNIK_GIT_SSH_KEY: KEY_BASE64, REMONTNIK_GIT_KNOWN_HOSTS: KNOWN_HOSTS, ...overrides })
  const check = (repoDir: string, ssh: FakeSsh, overrides: Record<string, string | undefined> = {}) =>
    checkDoctorConfig(sshEnv(repoDir, overrides), { docker: fakeDocker(HEALTHY_DOCKER), gh: fakeGh([]), ssh: ssh.ssh })
  const storageErrors = (findings: Finding[]) => findings.filter((finding) => finding.area === 'хранилище' && finding.level === 'error')

  it.skipIf(asRoot)('исправное хранилище: ошибок нет, правила GitHub не нужны; чего не проверить по SSH — предупреждение с командой владельцу; ничего не записано', async () => {
    const { repoDir, store } = ownStorage({ locked: true })
    const before = store.refs()
    const ssh = fakeSsh({ home: store.home, forced: ['doctor', store.bare] })
    const findings = await check(repoDir, ssh)
    expect(errors(findings)).toEqual([])
    expect(warnings(findings)).toEqual([expect.stringMatching(/по SSH не проверить/)])
    expect(findings.find((finding) => finding.level === 'warning')!.fix).toMatch(/stat .*cmp /s)
    expect(findings.filter((finding) => finding.area === 'хранилище' && finding.level === 'ok')).not.toEqual([])
    expect(findings.some((finding) => finding.area === 'github')).toBe(false)
    expect(store.refs()).toBe(before)
    // git получил путь из принудительной команды и роль врача.
    expect(ssh.gitShellCalls()).toContain(`receive-pack ${realpathSync(store.bare)} doctor`)
    const calls = ssh.calls()
    expect(calls).not.toEqual([])
    for (const call of calls) {
      expect(call.key).toBe(`${TEST_SSH_KEY}\n`)
      expect(call.args).toContain('StrictHostKeyChecking=yes')
      // Ключ лежал во временной папке только на время проверки.
      expect(existsSync(call.args[call.args.indexOf('-i') + 1]!)).toBe(false)
    }
  })

  it('receive.denyNonFastForwards и receive.denyDeletes выключены — ошибки с названием настройки', async () => {
    const { repoDir, store } = ownStorage({ denyNonFastForwards: false, denyDeletes: false })
    const problems = storageErrors(await check(repoDir, fakeSsh({ home: store.home, forced: ['doctor', store.bare] })))
    expect(problems.map((finding) => finding.problem).join('\n')).toMatch(/receive\.denyNonFastForwards/)
    expect(problems.map((finding) => finding.problem).join('\n')).toMatch(/receive\.denyDeletes/)
  })

  it('хука нет — ошибки: хук не ответил, метки remontnik/** не защищены; ни одна ссылка не изменилась', async () => {
    const { repoDir, store } = ownStorage({ hook: false })
    const before = store.refs()
    const problems = storageErrors(await check(repoDir, fakeSsh({ home: store.home, forced: ['doctor', store.bare] })))
    const text = problems.map((finding) => finding.problem).join('\n')
    expect(text).toMatch(/хук update не ответил/)
    expect(text).toMatch(/метки remontnik\/\*\*/)
    expect(problems.find((finding) => /хук update/.test(finding.problem))!.fix).toContain('deploy/git-update-hook')
    expect(store.refs()).toBe(before)
  })

  it('ключ врача без принудительной команды — ошибка с подсказкой command="remontnik-git doctor <путь>"', async () => {
    const { repoDir, store } = ownStorage({ locked: true })
    const problems = storageErrors(await check(repoDir, fakeSsh({ home: store.home })))
    expect(problems.map((finding) => finding.fix).join('\n')).toContain('command="remontnik-git doctor <путь хранилища>"')
  })

  it.skipIf(asRoot)('принудительная команда не сверяет путь — ошибка: ключ врача открывает и другие хранилища', async () => {
    const { repoDir, store } = ownStorage({ locked: true })
    const problems = storageErrors(await check(repoDir, fakeSsh({ home: store.home, role: 'doctor' })))
    expect(problems).toHaveLength(1)
    expect(problems[0]!.problem).toMatch(/другие хранилища/)
    expect(problems[0]!.fix).toContain('command="remontnik-git doctor <путь хранилища>"')
  })

  it('ключ врача привязан к другому хранилищу, чем в origin — ошибка про путь', async () => {
    const { repoDir, store } = ownStorage()
    const other = storage()
    const problems = storageErrors(await check(repoDir, fakeSsh({ home: store.home, forced: ['doctor', other.bare] })))
    expect(problems).toHaveLength(1)
    expect(problems[0]!.problem).toMatch(/привязан к другому хранилищу/)
  })

  it.skipIf(asRoot)('пользователь git может писать в хук и config — ошибка со списком и подсказкой про root', async () => {
    const { repoDir, store } = ownStorage()
    const problem = storageErrors(await check(repoDir, fakeSsh({ home: store.home, forced: ['doctor', store.bare] }))).find((finding) => /может писать/.test(finding.problem))!
    expect(problem.problem).toMatch(/config/)
    expect(problem.problem).toMatch(/hooks\/update/)
    expect(problem.fix).toMatch(/root/)
  })

  it('ssh не пустил ключ, не узнал сервер или не достучался — ошибка с подсказкой, без текста ssh', async () => {
    const { repoDir, store } = ownStorage()
    const fixFor = async (failure: string) => {
      const problems = storageErrors(await check(repoDir, fakeSsh({ home: store.home, failure })))
      expect(problems).toHaveLength(1)
      expect(problems[0]!.problem).not.toContain('storage.invalid')
      return problems[0]!.fix
    }
    expect(await fixFor('git@storage.invalid: Permission denied (publickey).')).toMatch(/authorized_keys/)
    expect(await fixFor('Host key verification failed.')).toMatch(/REMONTNIK_GIT_KNOWN_HOSTS/)
    expect(await fixFor('ssh: connect to host storage.invalid port 22: Connection refused')).toMatch(/host-gateway/)
  })

  it('origin по SSH без ключа врача — не своё хранилище: прежнее предупреждение, по SSH никуда не ходим', async () => {
    for (const origin of [undefined, 'git@gitlab.invalid:group/app.git', 'ssh://git@gitlab.invalid/group/app.git']) {
      const { repoDir, store } = ownStorage()
      if (origin) git(repoDir, 'remote', 'set-url', 'origin', origin)
      const ssh = fakeSsh({ home: store.home, forced: ['doctor', store.bare] })
      const findings = await check(repoDir, ssh, { REMONTNIK_GIT_SSH_KEY: undefined, REMONTNIK_GIT_KNOWN_HOSTS: undefined })
      expect(findings.filter((finding) => finding.area === 'хранилище')).toEqual([])
      expect(errors(findings)).toEqual([])
      expect(warnings(findings)).toEqual([expect.stringMatching(/не на GitHub и не своё хранилище.*не проверена/)])
      expect(ssh.calls()).toEqual([])
    }
  })

  it('ключ задан без known_hosts — ошибка окружения', async () => {
    const { repoDir, store } = ownStorage()
    const findings = await check(repoDir, fakeSsh({ home: store.home, forced: ['doctor', store.bare] }), { REMONTNIK_GIT_KNOWN_HOSTS: undefined })
    expect(findings.filter((finding) => finding.area === 'окружение' && finding.level === 'error').map((finding) => finding.problem).join('\n')).toMatch(/REMONTNIK_GIT_KNOWN_HOSTS/)
  })

  it('вывод: ни ключа, ни адреса и пути хранилища, ни known_hosts', async () => {
    const { repoDir, store } = ownStorage({ hook: false })
    const ssh = fakeSsh({ home: store.home, forced: ['doctor', store.bare] })
    let out = ''
    const env = { ...sshEnv(repoDir), PATH: pathWith(fakeDocker(HEALTHY_DOCKER), fakeGh([]), ssh.ssh) }
    const code = await runDoctorCommand(['check-config'], { env, stdout: (text) => (out += text), stderr: (text) => (out += text) })
    expect(code).toBe(1)
    expect(ssh.calls()).not.toEqual([])
    for (const secret of [KEY_BASE64, TEST_SSH_KEY.split('\n')[1]!, KNOWN_HOSTS, store.bare, store.root, 'storage.invalid']) expect(out).not.toContain(secret)
    expect(out).toMatch(/\[хранилище\]/)
  })
})

describe('check-config: вывод', () => {
  it('ни секретов, ни адресов в выводе; есть ошибки — код 1', async () => {
    const repoDir = appRepo()
    const docker = fakeDocker({ down: true, errorText: `dial tcp 192.168.10.5:2376: refused; token=${SHARED} https://docker.example.com/v1` })
    let out = ''
    const env = { ...serverEnv(repoDir, { REMONTNIK_CONTROL_SECRET: SHARED, REMONTNIK_LISTEN_NETWORK: undefined, REMONTNIK_LISTEN: '0.0.0.0:7800' }), PATH: pathWith(docker, fakeGh([])) }
    const code = await runDoctorCommand(['check-config'], { env, stdout: (text) => (out += text), stderr: (text) => (out += text) })
    expect(code).toBe(1)
    for (const secret of [SHARED, OWNER, BOT, 'deepseek-check-config-test-key', '-1001234567890']) expect(out).not.toContain(secret)
    expect(out).not.toMatch(/192\.168\.10\.5|docker\.example\.com|0\.0\.0\.0|github\.com|example-owner/)
    expect(out).not.toContain(repoDir)
    expect(out).toMatch(/как исправить/i)
  })

  it('лишний аргумент — ошибка использования', async () => {
    let err = ''
    const code = await runDoctorCommand(['check-config', 'лишнее'], { env: {}, stdout: () => {}, stderr: (text) => (err += text) })
    expect(code).toBe(2)
    expect(err).toContain('check-config')
  })
})
