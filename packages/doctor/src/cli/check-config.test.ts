import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { localConfigReader } from '../service/config-reader.js'
import { testRemontnikConfig } from '../testing/config.js'
import { checkDoctorConfig, formatFindings } from './check-config.js'
import { runDoctorCommand } from './run-doctor-command.js'

// `remontnik-doctor check-config`: настройка, окружение, Docker и правила GitHub — до старта врача. Ответ — список
// «что не так и как исправить» без секретов и адресов; есть ошибки — код выхода не нулевой.

// Каждая проверка запускает десяток подставных docker, gh и git: под нагрузкой это дольше 5 секунд по умолчанию.
vi.setConfig({ testTimeout: 30_000 })

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
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
function appRepo(options: { config?: object; services?: string } = {}): string {
  const repoDir = join(tempDir(), 'app')
  mkdirSync(repoDir)
  git(repoDir, 'init', '--quiet', '--initial-branch=main')
  git(repoDir, 'remote', 'add', 'origin', 'https://github.com/example-owner/example-app.git')
  const config = testRemontnikConfig()
  const raw = options.config ?? { ...config, forbidden: { schema: config.forbidden.schema, money: config.forbidden.money, access: config.forbidden.access } }
  writeFileSync(join(repoDir, 'remontnik.config.json'), JSON.stringify(raw))
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
  /** Сети случая: закрыта ли и без адреса моста. */
  caseNetworks?: { id: string; internal: boolean; inhibit: boolean }[]
  /** Все сети Docker с подсетями. */
  networks?: { name: string; subnet: string; caseNetwork?: boolean }[]
  /** Что docker пишет в stderr при отказе. */
  errorText?: string
}

const HEALTHY_DOCKER: DockerScenario = {
  gatewayNetworks: { 'remontnik-app': '10.5.0.3' },
  caseNetworks: [{ id: 'case-net-1', internal: true, inhibit: true }],
  networks: [
    { name: 'bridge', subnet: '172.17.0.0/16' },
    { name: 'remontnik-app', subnet: '10.5.0.0/24' },
    { name: 'remontnik-case-1', subnet: '10.213.0.0/27', caseNetwork: true },
  ],
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
if (a[0] === 'inspect') { const name = a.at(-1); if (name !== 'remontnik-doctor') { process.stderr.write('No such object: ' + name); process.exit(1) } out(JSON.stringify(Object.fromEntries(Object.entries(s.gatewayNetworks || {}).map(([n, ip]) => [n, { IPAddress: ip }])))) }
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
    writeFileSync(join(repoDir, 'src/shared-names.mjs'), `export const NAME = ${JSON.stringify(data.app.name)}\n`)
    writeFileSync(join(repoDir, 'remontnik.config.shared.mjs'), `export const CHECKS = ${JSON.stringify(data.checks)}\n`)
    writeFileSync(
      join(repoDir, 'remontnik.config.mjs'),
      `import { NAME } from './src/shared-names.mjs'\nimport { CHECKS } from './remontnik.config.shared.mjs'\nexport default { ...${JSON.stringify(data)}, app: { name: NAME }, checks: CHECKS }\n`,
    )
    git(repoDir, 'add', '-A')
    git(repoDir, 'commit', '--quiet', '-m', 'настройка')

    const findings = await checkDoctorConfig(serverEnv(repoDir), { docker: fakeDocker(HEALTHY_DOCKER), gh: fakeGh(GOOD_RULESETS), configReader: localConfigReader() })

    expect(errors(findings)).toEqual([])
    expect(warnings(findings)).toHaveLength(1)
    expect(warnings(findings)[0]).toContain('src/shared-names.mjs')
    expect(warnings(findings)[0]).toContain('fixablePaths')
    expect(warnings(findings)[0]).toContain('только отчёт человеку')
  })

  it('код настройки без контейнера врача не выполняется: нет REMONTNIK_GATEWAY_CONTAINER — ошибка, а не чтение в процессе врача', async () => {
    const repoDir = join(tempDir(), 'app')
    mkdirSync(repoDir, { recursive: true })
    git(repoDir, 'init', '--quiet', '--initial-branch=main')
    writeFileSync(join(repoDir, 'remontnik.config.mjs'), `export default ${JSON.stringify(testRemontnikConfig())}\n`)
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

describe('check-config: Docker и сети', () => {
  it('Docker недоступен — ошибка, остальные проверки Docker не идут', async () => {
    const findings = await checkDoctorConfig(serverEnv(appRepo()), { docker: fakeDocker({ down: true }), gh: fakeGh(GOOD_RULESETS) })
    const problems = errors(findings).filter((problem) => /docker/i.test(problem))
    expect(problems).toHaveLength(1)
  })

  it('контейнера врача нет в сети приложения — ошибка', async () => {
    const findings = await checkDoctorConfig(serverEnv(appRepo()), { docker: fakeDocker({ ...HEALTHY_DOCKER, gatewayNetworks: { bridge: '172.17.0.2' } }), gh: fakeGh(GOOD_RULESETS) })
    expect(errors(findings).join('\n')).toMatch(/remontnik-app/)
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
