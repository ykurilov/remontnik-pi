import { execFile } from 'node:child_process'
import { constants } from 'node:fs'
import { access, readFile, stat } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import type { RemontnikConfig } from '@ykurilov/remontnik-core/config'
import { redactSecrets } from '@ykurilov/remontnik-core/redact'
import { CASE_NETWORK_LABEL } from '../case-networks/index.js'
import { MIN_SECRET_LENGTH, secretProblems } from '../intake/http-kit.js'
import { parseServicesFile } from '../case-services/index.js'
import { matchesAllowMask } from '../path-mask/index.js'
import type { ConfigCodeReader } from '../service/config-reader.js'
import { loadMainBranchConfig } from '../service/config-source.js'
import { configReaderFromEnv, doctorStartPlan, type DoctorEnv } from '../service/start.js'
import { UsageError, type DoctorCommandIo } from './command-io.js'

// `remontnik-doctor check-config`: всё, на чём споткнётся старт врача, — одним списком и до старта.
// Настройка читается тем же путём, что и при старте; окружение проверяется целиком, а не до первой ошибки;
// Docker, сети случая и правила GitHub — только чтением. В выводе нет ни секретов, ни адресов, ни имени репозитория.

export const CHECK_CONFIG_USAGE = `  remontnik-doctor check-config        проверить настройку, окружение, Docker и правила GitHub до старта
`

export interface Finding {
  level: 'error' | 'warning' | 'ok'
  area: 'настройка' | 'окружение' | 'службы' | 'docker' | 'сети' | 'браузер' | 'github'
  problem: string
  /** Как исправить; у «ok» — пусто. */
  fix: string
}

export interface CheckConfigDeps {
  docker?: string
  gh?: string
  /** Где выполняется код настройки; по умолчанию — как при старте врача, в контейнере из его образа. */
  configReader?: ConfigCodeReader
}

const COMMAND_TIMEOUT_MS = 30_000
const SECRETS_FIX = 'положите значение в файл окружения врача через secret-handoff (в чат и в репозиторий — нельзя) и перезапустите врача'
const RULESET_FIX = 'примените шаблон deploy/github-ruleset.json через gh api (команды — в docs/security.md, раздел о правилах GitHub)'

const REQUIRED_ENV = ['REMONTNIK_CONFIG_REPO_DIR', 'REMONTNIK_STATE_DIR', 'REMONTNIK_SHARED_SECRET', 'REMONTNIK_GATEWAY_CONTAINER', 'DEEPSEEK_API_KEY', 'OPENROUTER_API_KEY']
/** Значения этих переменных — секреты или адреса: в выводе их не должно быть. */
const SENSITIVE_NAME = /KEY|TOKEN|SECRET|PASS|CHAT|URL|DSN|LISTEN|SUBNET|EMAIL/i
const PATH_VARIABLES = ['REMONTNIK_CONFIG_REPO_DIR', 'REMONTNIK_STATE_DIR', 'REMONTNIK_WORKTREES_DIR']

interface CommandResult {
  ok: boolean
  /** Программы нет (ENOENT). */
  missing: boolean
  stdout: string
  stderr: string
}

function run(binary: string, args: string[], env: DoctorEnv, cwd?: string): Promise<CommandResult> {
  const childEnv = Object.fromEntries(Object.entries({ ...process.env, ...env }).filter((entry): entry is [string, string] => entry[1] !== undefined))
  return new Promise((resolve) => {
    execFile(binary, args, { env: childEnv, timeout: COMMAND_TIMEOUT_MS, maxBuffer: 10 * 1024 * 1024, ...(cwd ? { cwd } : {}) }, (error, stdout, stderr) => {
      resolve({ ok: !error, missing: (error as NodeJS.ErrnoException | null)?.code === 'ENOENT', stdout: String(stdout), stderr: String(stderr) })
    })
  })
}

const value = (env: DoctorEnv, name: string) => env[name]?.trim() || undefined

/** Имена переменных окружения, которые настройка требует от врача. */
function configEnvNames(config: RemontnikConfig): string[] {
  const names = [config.reports.telegram.botTokenEnv]
  if (config.reports.telegram.chatIdEnv) names.push(config.reports.telegram.chatIdEnv)
  const evalCheck = config.checks.eval
  if (evalCheck) names.push(...evalCheck.providers.map((provider) => provider.keyEnv))
  const paseo = config.handoff?.mode === 'paseo-first' ? config.handoff.paseo : undefined
  if (paseo) names.push(paseo.bridgeUrlEnv, paseo.bridgeSecretEnv, paseo.listenEnv)
  return names
}

/**
 * Файлы, которые подключает настройка, врач не правит никогда (шлюз правки, `config-files`). Если такой файл в `fixablePaths`,
 * владелец, скорее всего, ждёт, что врач его чинит, — предупреждаем. Это не дыра в защите, поэтому не ошибка.
 */
function importsInFixablePaths(config: RemontnikConfig, localImports: string[]): Finding[] {
  return localImports.filter((path) => matchesAllowMask(config.fixablePaths, path)).map((path) => ({
    level: 'warning',
    area: 'настройка',
    problem: `настройка подключает файл ${path} из fixablePaths: врач его не правит, правка в нём — только отчёт человеку`,
    fix: `если врач должен чинить ${path}, уберите его из импортов настройки; общий с настройкой текст держите в remontnik.config.<имя>.ts`,
  }))
}

async function checkSettings(env: DoctorEnv, deps: CheckConfigDeps): Promise<{ findings: Finding[]; config?: RemontnikConfig }> {
  const repoDir = value(env, 'REMONTNIK_CONFIG_REPO_DIR')
  if (!repoDir) return { findings: [] }
  const mainBranch = value(env, 'REMONTNIK_MAIN_BRANCH') ?? 'main'
  try {
    const reader = deps.configReader ?? configReaderFromEnv(env, deps.docker ? { docker: deps.docker } : {})
    const { config, localImports } = await loadMainBranchConfig({ mainCheckoutDirectory: repoDir, mainBranch, reader })
    return { config, findings: [{ level: 'ok', area: 'настройка', problem: 'настройка основной ветки читается без ошибок', fix: '' }, ...importsInFixablePaths(config, localImports)] }
  } catch (error) {
    const issues = (error as { issues?: unknown }).issues
    if (Array.isArray(issues)) {
      return { findings: issues.map((issue) => ({ level: 'error', area: 'настройка', problem: String(issue), fix: 'исправьте поле в remontnik.config основной ветки (все поля — docs/configuration.md)' })) }
    }
    const code = (error as { code?: string }).code
    const fix = code === 'branch_mismatch' || code === 'branch_unknown'
      ? `рабочая копия настройки должна стоять на основной ветке (REMONTNIK_MAIN_BRANCH, по умолчанию main)`
      : code === 'not_found'
        ? 'положите remontnik.config в корень рабочей копии основной ветки'
        : 'исправьте remontnik.config основной ветки (все поля — docs/configuration.md)'
    return { findings: [{ level: 'error', area: 'настройка', problem: (error as Error).message, fix }] }
  }
}

/** Разные длинные заглушки вместо секретов: их ошибки уже в списке, план не должен повторить их. */
function secretStubs(secrets: Array<{ name: string }>): Record<string, string | undefined> {
  return Object.fromEntries(secrets.map(({ name }, index) => [name, name === 'REMONTNIK_CONTROL_SECRET' ? undefined : `заглушка-секрета-${index}-`.padEnd(MIN_SECRET_LENGTH, 'x')]))
}

function checkEnvironment(env: DoctorEnv, config: RemontnikConfig | undefined): Finding[] {
  const findings: Finding[] = []
  const needed = [...REQUIRED_ENV, ...(config ? configEnvNames(config) : [])]
  const missing = [...new Set(needed)].filter((name) => !value(env, name))
  if (!value(env, 'REMONTNIK_LISTEN_NETWORK') && !value(env, 'REMONTNIK_LISTEN')) missing.push('REMONTNIK_LISTEN_NETWORK')
  for (const name of missing) {
    const fix = name === 'REMONTNIK_LISTEN_NETWORK'
      ? 'укажите сеть Docker приложения (REMONTNIK_LISTEN_NETWORK) или адрес в ней (REMONTNIK_LISTEN)'
      : SENSITIVE_NAME.test(name) ? SECRETS_FIX : 'укажите переменную в файле окружения врача и перезапустите врача'
    findings.push({ level: 'error', area: 'окружение', problem: `не задана переменная ${name}`, fix })
  }

  const shared = value(env, 'REMONTNIK_SHARED_SECRET')
  const control = value(env, 'REMONTNIK_CONTROL_SECRET')
  if (!control) {
    findings.push({ level: 'warning', area: 'окружение', problem: 'не задан REMONTNIK_CONTROL_SECRET: стоп-кран выкаток снимается общим секретом', fix: `заведите отдельный секрет владельца: ${SECRETS_FIX}` })
  }
  const bridgeSecretEnv = config?.handoff.paseo?.bridgeSecretEnv
  const secrets = [
    { name: 'REMONTNIK_SHARED_SECRET', value: shared },
    { name: 'REMONTNIK_CONTROL_SECRET', value: control },
    ...(bridgeSecretEnv ? [{ name: bridgeSecretEnv, value: value(env, bridgeSecretEnv) }] : []),
  ]
  for (const problem of secretProblems(secrets)) {
    findings.push({ level: 'error', area: 'окружение', problem, fix: `у каждого секрета своё значение не короче ${MIN_SECRET_LENGTH} знаков: ${SECRETS_FIX}` })
  }

  // Остальное (адрес приёма, пул подсетей) проверяет сам план старта. Недостающие переменные уже в списке —
  // план получает заглушки, чтобы дойти до прочих ошибок; секреты проверены выше и плану даны заглушками.
  if (config) {
    const patched: Record<string, string | undefined> = { ...env, ...Object.fromEntries(missing.map((name) => [name, 'заглушка'])), ...secretStubs(secrets) }
    try {
      doctorStartPlan(patched, config)
    } catch (error) {
      const message = (error as Error).message
      const fix = /REMONTNIK_LISTEN/.test(message)
        ? 'слушайте только адрес врача в сети приложения: REMONTNIK_LISTEN_NETWORK=<сеть приложения> вместо REMONTNIK_LISTEN'
        : /пул подсетей/.test(message)
          ? 'REMONTNIK_CASE_SUBNETS: частный IPv4-пул вида a.b.c.d/16, не занятый другими сетями'
          : 'исправьте переменную в файле окружения врача'
      findings.push({ level: 'error', area: 'окружение', problem: message, fix })
    }
  }
  if (!findings.some((finding) => finding.level === 'error')) findings.push({ level: 'ok', area: 'окружение', problem: 'все нужные переменные на месте', fix: '' })
  return findings
}

async function checkServices(env: DoctorEnv, config: RemontnikConfig): Promise<Finding[]> {
  const path = config.checks.services?.trim()
  const repoDir = value(env, 'REMONTNIK_CONFIG_REPO_DIR')
  if (!path || !repoDir) return []
  let source: string
  try {
    source = await readFile(join(repoDir, path), 'utf8')
  } catch {
    return [{ level: 'error', area: 'службы', problem: `файла служб для тестов ${path} нет в основной ветке`, fix: 'добавьте файл в основную ветку или уберите checks.services из настройки' }]
  }
  try {
    const services = parseServicesFile(source)
    return [{ level: 'ok', area: 'службы', problem: `службы для тестов: ${Object.keys(services).join(', ')} — образы закреплены`, fix: '' }]
  } catch (error) {
    return [{ level: 'error', area: 'службы', problem: (error as Error).message, fix: 'образы — только «имя@sha256:<отпечаток>» (docker buildx imagetools inspect <образ>), вместо $ пишите $$; поля — docs/configuration.md' }]
  }
}

function ipv4Range(cidr: string): { start: number; end: number } | undefined {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/.exec(cidr.trim())
  if (!match) return undefined
  const parts = match.slice(1, 5).map(Number)
  const bits = Number(match[5])
  if (parts.some((part) => part > 255) || bits > 32) return undefined
  const size = 2 ** (32 - bits)
  const start = Math.floor(parts.reduce((sum, part) => sum * 256 + part, 0) / size) * size
  return { start, end: start + size - 1 }
}

/**
 * Контейнер чтения настройки монтирует копию её файлов из папки состояния по пути врача: у врача и у хоста
 * этот путь должен быть один (том «путь:путь» в compose), иначе Docker смонтирует пустую папку хоста.
 */
async function checkStateMount(env: DoctorEnv, docker: string, container: string, stateDir: string): Promise<Finding[]> {
  const inspect = await run(docker, ['inspect', '--format', '{{json .Mounts}}', container], env)
  let mounts: { Source?: string; Destination?: string }[] = []
  try {
    mounts = JSON.parse(inspect.stdout) ?? []
  } catch {}
  const path = stateDir.replace(/\/+$/, '')
  const holder = mounts
    .filter((mount) => mount.Destination && (path === mount.Destination || path.startsWith(`${mount.Destination.replace(/\/+$/, '')}/`)))
    .sort((a, b) => b.Destination!.length - a.Destination!.length)[0]
  if (holder && holder.Source === holder.Destination) return []
  return [{
    level: 'error',
    area: 'docker',
    problem: 'папка состояния REMONTNIK_STATE_DIR смонтирована у врача не тем же путём, что на хосте: контейнер чтения настройки не увидит копию её файлов',
    fix: 'смонтируйте папку состояния одинаковым путём у хоста и врача (том «путь:путь», как в deploy/compose.remontnik.yml)',
  }]
}

async function checkDocker(env: DoctorEnv, docker: string): Promise<Finding[]> {
  const version = await run(docker, ['version', '--format', '{{.Server.Version}}'], env)
  if (!version.ok) {
    return [{ level: 'error', area: 'docker', problem: 'Docker недоступен: врач не может запускать верстак и проверки', fix: 'запустите Docker и дайте врачу его сокет (в compose — том docker.sock); проверка: docker version' }]
  }
  const findings: Finding[] = []

  const container = value(env, 'REMONTNIK_GATEWAY_CONTAINER')
  const network = value(env, 'REMONTNIK_LISTEN_NETWORK')
  if (container) {
    const inspect = await run(docker, ['inspect', '--format', '{{json .NetworkSettings.Networks}}', container], env)
    if (!inspect.ok) {
      findings.push({ level: 'error', area: 'docker', problem: `контейнер врача «${container}» не найден`, fix: 'REMONTNIK_GATEWAY_CONTAINER — имя контейнера, в котором работает врач (в compose его задаёт REMONTNIK_CONTAINER_NAME, по умолчанию remontnik-doctor)' })
    } else if (network) {
      let networks: Record<string, unknown> = {}
      try {
        networks = JSON.parse(inspect.stdout) ?? {}
      } catch {}
      if (!Object.hasOwn(networks, network)) {
        findings.push({ level: 'error', area: 'docker', problem: `контейнер врача не подключён к сети приложения «${network}»`, fix: 'подключите врача к сети приложения в compose (networks) или исправьте REMONTNIK_LISTEN_NETWORK' })
      }
    }
    const stateDir = value(env, 'REMONTNIK_STATE_DIR')
    if (inspect.ok && stateDir) findings.push(...(await checkStateMount(env, docker, container, stateDir)))
  }
  if (findings.length === 0) findings.push({ level: 'ok', area: 'docker', problem: 'Docker доступен, врач на месте', fix: '' })

  const networkFindings: Finding[] = []
  const caseList = await run(docker, ['network', 'ls', '--filter', `label=${CASE_NETWORK_LABEL}`, '--format', '{{.ID}}'], env)
  for (const id of caseList.stdout.split('\n').map((line) => line.trim()).filter(Boolean)) {
    const inspect = await run(docker, ['network', 'inspect', '--format', '{{.Id}} {{.Internal}} {{index .Options "com.docker.network.bridge.inhibit_ipv4"}}', id], env)
    if (!inspect.ok) continue
    const [, internal, inhibit] = inspect.stdout.trim().split(/\s+/)
    if (internal !== 'true') networkFindings.push({ level: 'error', area: 'сети', problem: `сеть случая «${id}» не закрыта (internal): чужой код из неё выходит наружу`, fix: 'остановите врача и удалите сеть (docker network rm): врач пересоздаст её закрытой' })
    if (inhibit !== 'true') networkFindings.push({ level: 'error', area: 'сети', problem: `у сети случая «${id}» есть адрес моста на хосте: из неё виден сам сервер`, fix: 'остановите врача и удалите сеть (docker network rm): врач пересоздаст её без адреса моста' })
  }

  const pool = ipv4Range(value(env, 'REMONTNIK_CASE_SUBNETS') ?? '10.213.0.0/16')
  const names = (await run(docker, ['network', 'ls', '--format', '{{.Name}}'], env)).stdout.split('\n').map((line) => line.trim()).filter(Boolean)
  if (pool && names.length > 0) {
    const inspect = await run(docker, ['network', 'inspect', '--format', `{{.Name}}|{{range .IPAM.Config}}{{.Subnet}} {{end}}|{{index .Labels "${CASE_NETWORK_LABEL}"}}`, ...names], env)
    for (const line of inspect.stdout.split('\n').filter(Boolean)) {
      const [name, subnets = '', label = ''] = line.split('|')
      // Свои сети случая берутся из пула — это не пересечение.
      if (label.trim() && label.trim() !== '<no value>') continue
      const overlaps = subnets.split(/\s+/).map(ipv4Range).some((range) => range && range.start <= pool.end && pool.start <= range.end)
      if (overlaps) networkFindings.push({ level: 'error', area: 'сети', problem: `пул REMONTNIK_CASE_SUBNETS пересекается с сетью Docker «${name}»`, fix: 'выберите для REMONTNIK_CASE_SUBNETS свободный частный пул (docker network inspect покажет занятые подсети)' })
    }
  }
  if (networkFindings.length === 0) networkFindings.push({ level: 'ok', area: 'сети', problem: 'сети случая закрыты, пул подсетей свободен', fix: '' })
  return [...findings, ...networkFindings]
}

const BROWSER_POLICY_FIX = 'исправьте browser-policy.json (поля — packages/browser/README.md) и перезапустите службу браузера'

/**
 * Настройку браузера (browser-policy.json) видит только контейнер службы браузера: её проверяет сама служба
 * командой `remontnik-browser check-policy`. Контейнер — по имени хоста из REMONTNIK_BROWSER_URL, как в compose.
 */
const POLICY_PROBLEMS_SHOWN = 10
const POLICY_PROBLEM_LENGTH = 200

/** Ответ контейнера идёт в отчёт только буквами, цифрами и обычными знаками и ограниченной длины. */
function plainText(text: string): string {
  const plain = text
    .replace(/\s+/g, ' ')
    .replace(/[^\p{L}\p{N} .,:;!?«»"'()[\]{}<>/=+*_#@%&|~-]/gu, '?')
    .trim()
  return plain.length > POLICY_PROBLEM_LENGTH ? `${plain.slice(0, POLICY_PROBLEM_LENGTH)}…` : plain
}

/** Почему проверка в контейнере не ответила списком: старый образ, не задан путь к настройке или что-то ещё. */
function browserCheckFailure(container: string, stderr: string): Finding {
  if (stderr.includes('нет команды check-policy')) {
    return { level: 'warning', area: 'браузер', problem: 'служба браузера не умеет проверять настройку: образ старее врача', fix: 'обновите образ службы браузера до версии врача' }
  }
  if (stderr.includes('REMONTNIK_BROWSER_POLICY')) {
    return {
      level: 'warning',
      area: 'браузер',
      problem: `в контейнере «${container}» не задан REMONTNIK_BROWSER_POLICY: проверке неоткуда взять настройку`,
      fix: 'путь к настройке задаёт образ службы браузера; уберите пустое REMONTNIK_BROWSER_POLICY из environment службы в compose и перезапустите её',
    }
  }
  const said = plainText(stderr.split('\n').find((line) => line.trim() !== '') ?? '')
  return {
    level: 'warning',
    area: 'браузер',
    problem: `проверка настройки в контейнере «${container}» не ответила${said ? `: ${said}` : ''}`,
    fix: `запустите её вручную: docker exec ${container} remontnik-browser check-policy`,
  }
}

async function checkBrowserPolicy(env: DoctorEnv, docker: string): Promise<Finding[]> {
  const url = value(env, 'REMONTNIK_BROWSER_URL')
  if (!url) return []
  let container: string
  try {
    container = new URL(url).hostname
  } catch {
    return [{ level: 'error', area: 'браузер', problem: 'REMONTNIK_BROWSER_URL — не адрес', fix: 'в compose он задан сам: http://<контейнер браузера>:7700' }]
  }
  const running = await run(docker, ['inspect', '--format', '{{.State.Running}}', container], env)
  if (!running.ok) {
    return [{ level: 'warning', area: 'браузер', problem: `контейнер службы браузера «${container}» не найден: настройку браузера проверить нельзя`, fix: 'запустите службу браузера (compose) или проверьте файл на её сервере: remontnik-browser check-policy <путь>' }]
  }
  if (running.stdout.trim() !== 'true') {
    return [{ level: 'warning', area: 'браузер', problem: `контейнер службы браузера «${container}» не запущен`, fix: `причина — в docker logs ${container}; с неверной настройкой служба не стартует: ${BROWSER_POLICY_FIX}` }]
  }
  const checked = await run(docker, ['exec', container, 'remontnik-browser', 'check-policy'], env)
  let problems: string[] | undefined
  try {
    const parsed = JSON.parse(checked.stdout) as { problems?: unknown }
    if (Array.isArray(parsed.problems)) problems = parsed.problems.map(String)
  } catch {}
  if (!problems) return [browserCheckFailure(container, checked.stderr)]
  if (problems.length === 0) return [{ level: 'ok', area: 'браузер', problem: 'настройка службы браузера верна', fix: '' }]
  const shown: Finding[] = problems
    .slice(0, POLICY_PROBLEMS_SHOWN)
    .map((problem) => ({ level: 'error', area: 'браузер', problem: `настройка браузера: ${plainText(problem)}`, fix: BROWSER_POLICY_FIX }))
  if (problems.length > POLICY_PROBLEMS_SHOWN) {
    shown.push({ level: 'error', area: 'браузер', problem: `настройка браузера: ещё ${problems.length - POLICY_PROBLEMS_SHOWN} ошибок`, fix: `полный список: docker exec ${container} remontnik-browser check-policy` })
  }
  return shown
}

interface Ruleset {
  id: number
  target?: string
  enforcement?: string
  bypass_actors?: unknown[]
  conditions?: { ref_name?: { include?: string[] } }
  rules?: { type: string }[]
}

const RULESET_NEEDS = [
  { label: 'основной ветки', target: 'branch', refs: (mainBranch: string) => ['~DEFAULT_BRANCH', `refs/heads/${mainBranch}`], rules: ['non_fast_forward', 'deletion'] },
  { label: 'меток remontnik/*', target: 'tag', refs: () => ['refs/tags/remontnik/**', '~ALL'], rules: ['update', 'deletion'] },
] as const

async function checkGithub(env: DoctorEnv, gh: string, config: RemontnikConfig | undefined): Promise<Finding[]> {
  const repoDir = value(env, 'REMONTNIK_CONFIG_REPO_DIR')
  if (!repoDir) return []
  const origin = (await run('git', ['-C', repoDir, 'remote', 'get-url', 'origin'], env)).stdout.trim()
  const repo = /github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(origin)
  if (!repo) {
    return [{ level: 'warning', area: 'github', problem: 'origin не на GitHub — правила ветки и меток не проверены', fix: 'защитите основную ветку и метки remontnik/* от перезаписи и удаления средствами своего git-хостинга' }]
  }
  const api = `/repos/${repo[1]}/${repo[2]}/rulesets`
  const list = await run(gh, ['api', api], env)
  if (list.missing) return [{ level: 'warning', area: 'github', problem: 'нет gh — правила GitHub не проверены', fix: 'поставьте gh и войдите (gh auth login) или проверьте правила вручную по docs/security.md' }]
  if (!list.ok) return [{ level: 'warning', area: 'github', problem: 'gh не смог прочитать правила репозитория (нет входа или прав)', fix: 'gh auth login под владельцем репозитория и повторите проверку' }]

  const rulesets: Ruleset[] = []
  for (const { id } of JSON.parse(list.stdout || '[]') as { id: number }[]) {
    const full = await run(gh, ['api', `${api}/${id}`], env)
    if (full.ok) rulesets.push(JSON.parse(full.stdout) as Ruleset)
  }

  const mainBranch = config?.repo.mainBranch ?? value(env, 'REMONTNIK_MAIN_BRANCH') ?? 'main'
  const findings: Finding[] = []
  for (const need of RULESET_NEEDS) {
    const refs: readonly string[] = need.refs(mainBranch)
    const candidates = rulesets.filter((ruleset) => ruleset.target === need.target && (ruleset.conditions?.ref_name?.include ?? []).some((ref) => refs.includes(ref)))
    const active = candidates.filter((ruleset) => ruleset.enforcement === 'active')
    const strict = active.filter((ruleset) => (ruleset.bypass_actors ?? []).length === 0)
    if (candidates.length === 0) {
      findings.push({ level: 'error', area: 'github', problem: `нет набора правил для ${need.label}`, fix: RULESET_FIX })
    } else if (active.length === 0) {
      findings.push({ level: 'error', area: 'github', problem: `набор правил для ${need.label} не включён (enforcement не active)`, fix: 'включите набор: enforcement = active' })
    } else if (strict.length === 0) {
      findings.push({ level: 'error', area: 'github', problem: `у набора правил для ${need.label} есть обходы (bypass_actors)`, fix: 'уберите обходы: bypass_actors = []' })
    } else {
      const present = new Set(strict.flatMap((ruleset) => (ruleset.rules ?? []).map((rule) => rule.type)))
      const missing = need.rules.filter((rule) => !present.has(rule))
      if (missing.length > 0) findings.push({ level: 'error', area: 'github', problem: `в наборе правил для ${need.label} нет правил: ${missing.join(', ')}`, fix: RULESET_FIX })
    }
  }
  if (findings.length === 0) findings.push({ level: 'ok', area: 'github', problem: 'основная ветка и метки remontnik/* защищены от перезаписи и удаления', fix: '' })
  return findings
}

const INTERPRETERS = new Set(['node', 'sh', 'bash'])
/** Программы, которых нет в образе врача: команда, которая их зовёт, на сервере не заработает. */
const MISSING_IN_DOCTOR = /(^|[\s;&|(])(pnpm|npm|npx|yarn|bun|curl|wget|python3?)(\s|$)/

/** Файл, который запускает команда выкатки, и нужен ли ему бит исполнения; программы без файла (make) пропускаются. */
function deployCommandFile(command: string): { file: string; direct: boolean; interpreter?: string } | undefined {
  const words = command.trim().split(/\s+/).filter(Boolean)
  const first = words[0]
  if (!first) return undefined
  if (INTERPRETERS.has(first)) {
    const file = words.slice(1).find((word) => !word.startsWith('-'))
    return file ? { file, direct: false, interpreter: first } : undefined
  }
  return first.includes('/') ? { file: first, direct: true } : undefined
}

/** Файлы команд выкатки на месте и запускаются; сами команды не выполняются — только `node --check` и `sh -n` по файлу. */
async function checkDeployCommands(env: DoctorEnv, config: RemontnikConfig): Promise<Finding[]> {
  const repoDir = value(env, 'REMONTNIK_CONFIG_REPO_DIR')
  if (!repoDir) return []
  const findings: Finding[] = []
  for (const [name, command] of [...new Map(Object.entries(config.deploy.commands).map(([key, text]) => [text, key])).entries()].map(([text, key]) => [key, text] as const)) {
    if (MISSING_IN_DOCTOR.test(command)) {
      findings.push({ level: 'warning', area: 'настройка', problem: `команда выкатки «${name}» зовёт программу, которой нет в контейнере врача (pnpm, npm, curl и подобные)`, fix: 'команды выкатки выполняет сам врач: пишите их на node или sh и проверьте, что нужное есть в его образе (docs/getting-started.md)' })
    }
    const target = deployCommandFile(command)
    if (!target) continue
    const path = isAbsolute(target.file) ? target.file : resolve(repoDir, target.file)
    try {
      await access(path, constants.R_OK)
    } catch {
      findings.push({ level: 'error', area: 'настройка', problem: `команда выкатки «${name}»: файл ${target.file} не найден в основной ветке`, fix: 'добавьте файл в основную ветку или поправьте deploy.commands в remontnik.config' })
      continue
    }
    if (target.direct) {
      try {
        await access(path, constants.X_OK)
      } catch {
        findings.push({ level: 'error', area: 'настройка', problem: `команда выкатки «${name}»: у файла ${target.file} нет бита исполнения`, fix: `chmod +x ${target.file} и закоммитьте (git update-index --chmod=+x)` })
        continue
      }
    }
    const interpreter = target.interpreter ?? (/\.(m|c)?js$/.test(target.file) ? 'node' : /\.sh$/.test(target.file) ? 'sh' : undefined)
    const syntax = interpreter === 'node' && /\.(m|c)?js$/.test(target.file) ? await run('node', ['--check', path], env)
      : interpreter === 'sh' || interpreter === 'bash' ? await run(interpreter, ['-n', path], env)
        : undefined
    if (syntax && !syntax.ok) {
      findings.push({ level: 'error', area: 'настройка', problem: `команда выкатки «${name}»: файл ${target.file} не разбирается (синтаксическая ошибка)`, fix: `проверьте файл: ${interpreter === 'node' ? 'node --check' : 'sh -n'} ${target.file}` })
    }
  }
  if (findings.length === 0) findings.push({ level: 'ok', area: 'настройка', problem: 'файлы команд выкатки на месте и запускаются', fix: '' })
  return findings
}

/** Закрытый путь, который, судя по имени, про сценарии eval. */
const SCENARIO_LIKE_MASK = /(^|\/)(evals?|scenarios?)(\/|$)/i

/**
 * Закрытый сценарий врач узнаёт по пути `<checks.eval.scenariosDir>/<id>`. Папки нет или закрытый путь сценариев лежит
 * в другой папке — закрытые пути сценариев не сработают, и врач запустит закрытый сценарий.
 */
async function checkEvalScenarios(env: DoctorEnv, config: RemontnikConfig): Promise<Finding[]> {
  const repoDir = value(env, 'REMONTNIK_CONFIG_REPO_DIR')
  const evalCheck = config.checks.eval
  if (!repoDir || !evalCheck) return []
  const dir = evalCheck.scenariosDir
  const findings: Finding[] = []
  const isDirectory = await stat(resolve(repoDir, dir)).then((entry) => entry.isDirectory(), () => false)
  if (!isDirectory) {
    findings.push({ level: 'warning', area: 'настройка', problem: `папки сценариев eval ${dir} нет в основной ветке: закрытые пути не узнают закрытые сценарии`, fix: 'впишите в checks.eval.scenariosDir папку, где лежат сценарии (по умолчанию eval/scenarios)' })
  }
  for (const mask of config.closedPaths) {
    // Папки маски до первого знака маски: на пути к папке сценариев или внутри неё — маска может её накрыть.
    const literal = mask.slice(0, mask.search(/[*?[{]|$/))
    const folders = literal.slice(0, literal.lastIndexOf('/') + 1)
    if (!SCENARIO_LIKE_MASK.test(mask) || `${dir}/`.startsWith(folders) || folders.startsWith(`${dir}/`)) continue
    findings.push({ level: 'error', area: 'настройка', problem: `закрытый путь ${mask} похож на сценарии eval, но лежит вне checks.eval.scenariosDir (${dir}): такой сценарий врач не узнает и запустит`, fix: 'впишите настоящую папку сценариев в checks.eval.scenariosDir или поправьте закрытый путь' })
  }
  return findings
}

/** Все проверки подряд; ни одна не меняет сервер, репозиторий или GitHub. */
export async function checkDoctorConfig(env: DoctorEnv, deps: CheckConfigDeps = {}): Promise<Finding[]> {
  const { config, findings: settings } = await checkSettings(env, deps)
  return [
    ...settings,
    ...(config ? await checkDeployCommands(env, config) : []),
    ...(config ? await checkEvalScenarios(env, config) : []),
    ...checkEnvironment(env, config),
    ...(config ? await checkServices(env, config) : []),
    ...(await checkDocker(env, deps.docker ?? 'docker')),
    ...(await checkBrowserPolicy(env, deps.docker ?? 'docker')),
    ...(await checkGithub(env, deps.gh ?? 'gh', config)),
  ]
}

/** Убирает из текста каталоги сервера, значения секретов, адреса и ссылки. */
function scrub(text: string, env: DoctorEnv): string {
  let result = text
  for (const name of PATH_VARIABLES) {
    const path = value(env, name)
    if (path && path.length > 1) result = result.split(path).join(`<${name}>`)
  }
  const knownSecrets = Object.entries(env).filter(([name, item]) => SENSITIVE_NAME.test(name) && item?.trim()).map(([, item]) => item!.trim())
  result = redactSecrets(result, { knownSecrets })
  return result
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, '[адрес]')
    .replace(/\[?\b\d{1,3}(?:\.\d{1,3}){3}(?:\/\d{1,2})?\]?(?::\d+)?/g, '[адрес]')
}

const MARK = { error: '✗', warning: '!', ok: '✓' } as const

export function formatFindings(findings: Finding[], env: DoctorEnv): string {
  const lines = findings.map((finding) => {
    const head = `${MARK[finding.level]} [${finding.area}] ${finding.problem}`
    return finding.fix ? `${head}\n    как исправить: ${finding.fix}` : head
  })
  const errorCount = findings.filter((finding) => finding.level === 'error').length
  const warningCount = findings.filter((finding) => finding.level === 'warning').length
  const total = errorCount === 0 ? `Итог: ошибок нет, предупреждений ${warningCount}.` : `Итог: ошибок ${errorCount}, предупреждений ${warningCount}. Врач с такой настройкой не стартует или работает небезопасно.`
  return scrub(`${lines.join('\n')}\n\n${total}\n`, env)
}

export async function checkConfigCommand(args: string[], io: DoctorCommandIo): Promise<number> {
  if (args.length > 0) throw new UsageError('check-config: аргументы не нужны')
  const findings = await checkDoctorConfig(io.env)
  io.stdout(formatFindings(findings, io.env))
  return findings.some((finding) => finding.level === 'error') ? 1 : 0
}
