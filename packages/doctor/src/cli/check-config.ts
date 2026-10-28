import { execFile } from 'node:child_process'
import { constants } from 'node:fs'
import { access, mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import type { RemontnikConfig } from '@ykurilov/remontnik-core/config'
import { redactSecrets } from '@ykurilov/remontnik-core/redact'
import { CASE_NETWORK_LABEL } from '../case-networks/index.js'
import { gitSshAccess, parseSshRemote, probeGitStorage, writeGitSshFiles, type GitSshAccess, type SshRemote, type StorageFailure, type StorageProbeResult } from '../git-storage/index.js'
import { MIN_SECRET_LENGTH, secretProblems } from '../intake/http-kit.js'
import { parseServicesFile } from '../case-services/index.js'
import { matchesAllowMask } from '../path-mask/index.js'
import type { ConfigCodeReader } from '../service/config-reader.js'
import { loadMainBranchConfig } from '../service/config-source.js'
import { configReaderFromEnv, doctorStartPlan, type DoctorEnv } from '../service/start.js'
import { UsageError, type DoctorCommandIo } from './command-io.js'

// `remontnik-doctor check-config`: всё, на чём споткнётся старт врача, — одним списком и до старта.
// Настройка читается тем же путём, что и при старте; окружение проверяется целиком, а не до первой ошибки;
// Docker, сети случая, правила GitHub или защита своего хранилища — только чтением (пробы хранилища ничего не
// записывают). В выводе нет ни секретов, ни адресов, ни имени репозитория.

export const CHECK_CONFIG_USAGE = `  remontnik-doctor check-config        проверить настройку, окружение, Docker и защиту origin (правила GitHub или своё хранилище) до старта
`

export interface Finding {
  level: 'error' | 'warning' | 'ok'
  area: 'настройка' | 'окружение' | 'службы' | 'docker' | 'верстак' | 'сети' | 'браузер' | 'github' | 'хранилище'
  problem: string
  /** Как исправить; у «ok» — пусто. */
  fix: string
}

export interface CheckConfigDeps {
  docker?: string
  gh?: string
  /** ssh для проб своего хранилища. */
  ssh?: string
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
  if (evalCheck) names.push(...evalCheck.providers.flatMap((provider) => [provider.keyEnv, ...provider.upstreamHeaders.map((header) => header.valueEnv)]))
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
        : code === 'outside_doctor_image'
          ? 'запускайте проверку внутри контейнера врача, а не на хосте из node_modules приложения: docker compose -f deploy/compose.remontnik.yml exec doctor remontnik-doctor check-config'
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

  let gitSshBroken = false
  try {
    gitSshAccess(env, tmpdir())
  } catch (error) {
    gitSshBroken = true
    const message = (error as Error).message
    const fix = /KNOWN_HOSTS/.test(message)
      ? `строка ключа сервера хранилища под тем же именем, что в origin (${STORAGE_RECIPE}); укажите её в файле окружения врача`
      : SECRETS_FIX
    findings.push({ level: 'error', area: 'окружение', problem: message, fix })
  }

  // Остальное (адрес приёма, пул подсетей) проверяет сам план старта. Недостающие переменные уже в списке —
  // план получает заглушки, чтобы дойти до прочих ошибок; секреты проверены выше и плану даны заглушками.
  if (config) {
    const patched: Record<string, string | undefined> = { ...env, ...Object.fromEntries(missing.map((name) => [name, 'заглушка'])), ...secretStubs(secrets), ...(gitSshBroken ? { REMONTNIK_GIT_SSH_KEY: undefined } : {}) }
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

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1'])

/**
 * Приложение в сети сервера (`network_mode: host`) ходит к врачу через опубликованный порт. Он должен быть только
 * на петле сервера, а вести — в сеть приёма: Docker ведёт порт в сеть с высшим `gw_priority`, в другой сети врач
 * не слушает. Порт не опубликован — проверять нечего.
 */
async function checkPublishedIntake(env: DoctorEnv, docker: string, container: string, network: string, networks: Record<string, { GwPriority?: number }>): Promise<Finding[]> {
  const inspect = await run(docker, ['inspect', '--format', '{{json .HostConfig.PortBindings}}', container], env)
  let bindings: Record<string, { HostIp?: string }[] | null> = {}
  try {
    bindings = JSON.parse(inspect.stdout) ?? {}
  } catch {}
  const published = Object.values(bindings).flatMap((list) => list ?? [])
  if (published.length === 0) return []
  const findings: Finding[] = []
  if (published.some((binding) => !LOOPBACK_HOSTS.has(binding.HostIp ?? ''))) {
    findings.push({ level: 'error', area: 'docker', problem: 'порт врача опубликован не только на 127.0.0.1: приём виден с других адресов сервера', fix: 'публикуйте приём только как 127.0.0.1:<порт>:7800 (добавка deploy/compose.remontnik.host-app.yml)' })
  }
  const priority = (name: string) => networks[name]?.GwPriority ?? 0
  if (Object.keys(networks).some((name) => name !== network && priority(name) >= priority(network))) {
    findings.push({ level: 'error', area: 'docker', problem: `опубликованный порт врача ведёт не в сеть приёма «${network}»: там, куда он ведёт, врач не слушает`, fix: 'дайте сети приёма gw_priority выше остальных сетей врача (добавка deploy/compose.remontnik.host-app.yml, Docker 28 или новее)' })
  }
  return findings
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
      let networks: Record<string, { GwPriority?: number }> = {}
      try {
        networks = JSON.parse(inspect.stdout) ?? {}
      } catch {}
      if (!Object.hasOwn(networks, network)) {
        findings.push({ level: 'error', area: 'docker', problem: `контейнер врача не подключён к сети приложения «${network}»`, fix: 'подключите врача к сети приложения в compose (networks) или исправьте REMONTNIK_LISTEN_NETWORK' })
      } else {
        findings.push(...(await checkPublishedIntake(env, docker, container, network, networks)))
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

/** Защита origin: на GitHub — наборы правил, в своём хранилище по SSH — его настройки и хук. */
async function checkOrigin(env: DoctorEnv, deps: CheckConfigDeps, config: RemontnikConfig | undefined): Promise<Finding[]> {
  const repoDir = value(env, 'REMONTNIK_CONFIG_REPO_DIR')
  if (!repoDir) return []
  const origin = (await run('git', ['-C', repoDir, 'remote', 'get-url', 'origin'], env)).stdout.trim()
  const mainBranch = config?.repo.mainBranch ?? value(env, 'REMONTNIK_MAIN_BRANCH') ?? 'main'
  const repo = /github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(origin)
  if (repo) return checkGithub(env, deps.gh ?? 'gh', repo[1]!, repo[2]!, mainBranch)
  // Своё хранилище — origin по SSH и ключ врача к нему. Без ключа это чужой git-хостинг: пробы туда не шлём.
  const remote = value(env, 'REMONTNIK_GIT_SSH_KEY') ? parseSshRemote(origin) : undefined
  if (remote) return checkOwnStorage(env, deps.ssh ?? 'ssh', repoDir, remote, mainBranch)
  return [
    {
      level: 'warning',
      area: 'github',
      problem: 'origin не на GitHub и не своё хранилище по SSH — защита ветки и меток не проверена',
      fix: `защитите основную ветку и метки remontnik/* от перезаписи и удаления средствами своего git-хостинга; своё хранилище проверяется с ключом врача REMONTNIK_GIT_SSH_KEY (${STORAGE_RECIPE})`,
    },
  ]
}

async function checkGithub(env: DoctorEnv, gh: string, owner: string, name: string, mainBranch: string): Promise<Finding[]> {
  const api = `/repos/${owner}/${name}/rulesets`
  const list = await run(gh, ['api', api], env)
  if (list.missing) return [{ level: 'warning', area: 'github', problem: 'нет gh — правила GitHub не проверены', fix: 'поставьте gh и войдите (gh auth login) или проверьте правила вручную по docs/security.md' }]
  if (!list.ok) return [{ level: 'warning', area: 'github', problem: 'gh не смог прочитать правила репозитория (нет входа или прав)', fix: 'gh auth login под владельцем репозитория и повторите проверку' }]

  const rulesets: Ruleset[] = []
  for (const { id } of JSON.parse(list.stdout || '[]') as { id: number }[]) {
    const full = await run(gh, ['api', `${api}/${id}`], env)
    if (full.ok) rulesets.push(JSON.parse(full.stdout) as Ruleset)
  }

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

const STORAGE_RECIPE = 'docs/security.md, раздел «Своё хранилище на сервере»'
const DOCTOR_KEY_FIX = `в authorized_keys пользователя git перед ключом врача — restrict,command="remontnik-git doctor <путь хранилища>"; deploy/git-shell-remontnik-git — от root в <дом git>/git-shell-commands/remontnik-git (${STORAGE_RECIPE})`
const STORAGE_HOOK_FIX = `поставьте хук от root: install -o root -g root -m 755 deploy/git-update-hook <хранилище>/hooks/update (${STORAGE_RECIPE})`

/** Почему врач не дошёл до хранилища. Текст ssh наружу не идёт: в нём адрес сервера. */
const STORAGE_FAILURES: Record<StorageFailure, Pick<Finding, 'problem' | 'fix'>> = {
  'host-key': {
    problem: 'ssh не узнал сервер хранилища: его ключа нет в known_hosts врача или ключ другой',
    fix: 'запишите в REMONTNIK_GIT_KNOWN_HOSTS строку ключа сервера под тем же именем, что в origin (ssh-keyscan на самом сервере), и перезапустите врача',
  },
  denied: {
    problem: 'хранилище не пустило ключ врача',
    fix: 'открытый ключ врача — в authorized_keys пользователя git с restrict,command="remontnik-git doctor <путь хранилища>"; в REMONTNIK_GIT_SSH_KEY — его закрытая пара',
  },
  network: {
    problem: 'врач не достучался до SSH хранилища',
    fix: 'у врача в compose — extra_hosts: host.docker.internal:host-gateway; sshd на хосте слушает адрес моста Docker, сетевой экран пускает подсети Docker',
  },
  'not-repository': {
    problem: 'по пути из origin нет хранилища, или git не доверяет его владельцу',
    fix: `проверьте путь в origin; хранилищу с владельцем root нужен safe.directory в системной настройке git сервера (${STORAGE_RECIPE})`,
  },
  'not-git-shell': {
    problem: 'вход ключом врача не ведёт к git-receive-pack',
    fix: `оболочка пользователя git — git-shell, ключ врача — с restrict,command="remontnik-git doctor <путь хранилища>" (${STORAGE_RECIPE})`,
  },
  'foreign-repository': {
    problem: 'ключ врача привязан к другому хранилищу, не к тому, что в origin',
    fix: 'путь в command="remontnik-git doctor <путь>" ключа врача и путь в origin должны вести к одному хранилищу',
  },
  other: { problem: 'проверка хранилища по SSH не удалась', fix: `проверьте доступ врача по рецепту (${STORAGE_RECIPE})` },
}

const isGitRefusal = (outcome: StorageProbeResult['outcomes'][keyof StorageProbeResult['outcomes']], reason: string) => outcome?.kind === 'git' && outcome.reason === reason
const isHookRefusal = (outcome: StorageProbeResult['outcomes'][keyof StorageProbeResult['outcomes']], code: string) => outcome?.kind === 'hook' && outcome.code === code

/** Ответы хранилища на пробы — в находки: что держит git, что хук, чего нет. */
function storageFindings(result: StorageProbeResult): Finding[] {
  if (result.failure) return [{ level: 'error', area: 'хранилище', ...STORAGE_FAILURES[result.failure] }]
  if (!result.mainHead) {
    return [{ level: 'warning', area: 'хранилище', problem: 'в хранилище нет основной ветки — защита не проверена', fix: 'отправьте основную ветку в хранилище и повторите проверку' }]
  }
  const findings: Finding[] = []
  const error = (problem: string, fix: string) => findings.push({ level: 'error', area: 'хранилище', problem, fix })
  const { outcomes, status } = result

  if (!status) error('хук update не ответил: его нет, он не исполняемый или старый', STORAGE_HOOK_FIX)
  else if (status.writable.length > 0) {
    error(
      `пользователь git может писать: ${status.writable.join(', ')} — так можно снять защиту хранилища`,
      `владелец этих путей — root, запись только у root (chown root:root, chmod go-w); за git остаются только objects и refs (${STORAGE_RECIPE})`,
    )
  }

  if (!outcomes.nonFastForward) {
    findings.push({ level: 'warning', area: 'хранилище', problem: 'перезапись основной ветки не проверена: в рабочей копии нет её предыдущего коммита', fix: 'повторите проверку, когда в основной ветке будет больше одного коммита' })
  } else if (isHookRefusal(outcomes.nonFastForward, 'non-fast-forward')) {
    error('receive.denyNonFastForwards выключен: перезапись веток держит только хук', 'от root: git -C <хранилище> config receive.denyNonFastForwards true')
  } else if (!isGitRefusal(outcomes.nonFastForward, 'non-fast-forward')) {
    error('перезапись веток в хранилище не запрещена', `от root: git -C <хранилище> config receive.denyNonFastForwards true; ${STORAGE_HOOK_FIX}`)
  }

  if (isHookRefusal(outcomes.deleteBranch, 'delete')) {
    error('receive.denyDeletes выключен: удаление веток держит только хук', 'от root: git -C <хранилище> config receive.denyDeletes true')
  } else if (!isGitRefusal(outcomes.deleteBranch, 'deletion prohibited')) {
    error('удаление веток в хранилище не запрещено', `от root: git -C <хранилище> config receive.denyDeletes true; ${STORAGE_HOOK_FIX}`)
  }

  if (!isHookRefusal(outcomes.moveTag, 'tag-immutable') || !isHookRefusal(outcomes.deleteTag, 'tag-immutable')) {
    error('метки remontnik/** в хранилище можно перезаписать или удалить', STORAGE_HOOK_FIX)
  }

  if (isHookRefusal(outcomes.foreignBranch, 'probe')) {
    error('ключ врача пишет в любые ветки и в другие хранилища на сервере: у него нет принудительной команды', DOCTOR_KEY_FIX)
  } else {
    if (status && !isHookRefusal(outcomes.foreignBranch, 'doctor-ref')) error('хук не ограничил ключ врача его ссылками', STORAGE_HOOK_FIX)
    if (result.foreignRepository === 'open') error('ключ врача открывает и другие хранилища на сервере: принудительная команда не сверяет путь', DOCTOR_KEY_FIX)
  }

  if (findings.length === 0) {
    findings.push({ level: 'ok', area: 'хранилище', problem: 'перезапись и удаление веток отклоняет git, метки remontnik/** и чужие ветки врача — хук; пользователь git не правит хук и config', fix: '' })
  }
  findings.push({
    level: 'warning',
    area: 'хранилище',
    problem: 'что хук и config принадлежат root, хук совпадает с шаблоном и у каждого ключа есть принудительная команда, по SSH не проверить: хук отвечает сам о себе',
    fix: 'сверьте на сервере от root: stat -c "%U:%G %a %n" <хранилище> <хранилище>/config <хранилище>/hooks <хранилище>/hooks/update <дом git>/.ssh/authorized_keys && cmp deploy/git-update-hook <хранилище>/hooks/update; grep -vc \'^restrict,command="remontnik-git \' <дом git>/.ssh/authorized_keys — должно быть 0',
  })
  return findings
}

/** Коммит хранилища, который не потомок головы основной ветки: её родитель или то, что рабочая копия знает как origin. */
async function olderStorageCommit(env: DoctorEnv, repoDir: string, mainBranch: string, head: string): Promise<string | undefined> {
  for (const candidate of [`${head}^`, `refs/remotes/origin/${mainBranch}`]) {
    const result = await run('git', ['-C', repoDir, 'rev-parse', '--verify', '--quiet', `${candidate}^{commit}`], env)
    const oid = result.stdout.trim()
    if (result.ok && oid && oid !== head) return oid
  }
  return undefined
}

/** Своё хранилище по SSH: ключом врача, пробами, которые ничего не записывают. Ключ — во временной папке на время проверки. */
async function checkOwnStorage(env: DoctorEnv, ssh: string, repoDir: string, remote: SshRemote, mainBranch: string): Promise<Finding[]> {
  const dir = await mkdtemp(join(tmpdir(), 'remontnik-check-git-ssh-'))
  try {
    let access: GitSshAccess
    try {
      access = gitSshAccess(env, join(dir, 'ssh'))!
    } catch {
      return [{ level: 'warning', area: 'хранилище', problem: 'защита хранилища не проверена: доступ врача по SSH настроен с ошибкой', fix: 'исправьте переменные доступа (ошибка — в разделе «окружение») и повторите проверку' }]
    }
    await writeGitSshFiles(access)
    const result = await probeGitStorage({
      remote,
      sshOptions: access.sshOptions,
      mainBranch,
      olderCommit: (head) => olderStorageCommit(env, repoDir, mainBranch, head),
      ssh,
      ...(env.PATH ? { env: { PATH: env.PATH } } : {}),
    })
    return storageFindings(result)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
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
 * Закрытый сценарий врач узнаёт по пути `<checks.eval.scenariosDir>/<id>`. Папки нет — закрытые пути не узнают
 * закрытые сценарии. Закрытая папка рядом со сценариями (отложенные сценарии) — законное устройство: врач запускает
 * только то, что названо в evalScope и лежит в scenariosDir. Ошибка — когда сценарий из evalScope лежит под закрытой
 * маской вне scenariosDir, а в scenariosDir его нет: врач запустит его, а закрытый путь его не накроет.
 */
async function checkEvalScenarios(env: DoctorEnv, config: RemontnikConfig): Promise<Finding[]> {
  const repoDir = value(env, 'REMONTNIK_CONFIG_REPO_DIR')
  const evalCheck = config.checks.eval
  if (!repoDir || !evalCheck) return []
  const dir = evalCheck.scenariosDir
  const findings: Finding[] = []
  const entriesOf = (folder: string) => readdir(resolve(repoDir, folder)).catch(() => [] as string[])
  const isDirectory = await stat(resolve(repoDir, dir)).then((entry) => entry.isDirectory(), () => false)
  if (!isDirectory) {
    findings.push({ level: 'warning', area: 'настройка', problem: `папки сценариев eval ${dir} нет в основной ветке: закрытые пути не узнают закрытые сценарии`, fix: 'впишите в checks.eval.scenariosDir папку, где лежат сценарии (по умолчанию eval/scenarios)' })
  }
  const named = [...new Set(config.evalScope.flatMap((entry) => (entry.scenarios === 'all' ? [] : entry.scenarios)))]
  const hasScenarioFile = (names: readonly string[], id: string) => names.some((name) => name === id || name.startsWith(`${id}.`))
  const inDir = await entriesOf(dir)
  const outside = named.filter((id) => !hasScenarioFile(inDir, id))
  if (outside.length === 0) return findings
  for (const mask of config.closedPaths) {
    // Папки маски до первого знака маски: на пути к папке сценариев или внутри неё — маска может её накрыть.
    const literal = mask.slice(0, mask.search(/[*?[{]|$/))
    const folders = literal.slice(0, literal.lastIndexOf('/') + 1)
    if (!SCENARIO_LIKE_MASK.test(mask) || `${dir}/`.startsWith(folders) || folders.startsWith(`${dir}/`)) continue
    const names = await entriesOf(folders)
    const found = outside.filter((id) => hasScenarioFile(names, id))
    if (found.length === 0) continue
    findings.push({ level: 'error', area: 'настройка', problem: `сценарий ${found.join(', ')} из evalScope лежит под закрытым путём ${mask} вне checks.eval.scenariosDir (${dir}): закрытый путь его не узнает, и врач его запустит`, fix: 'впишите настоящую папку сценариев в checks.eval.scenariosDir или уберите сценарий из evalScope' })
  }
  return findings
}

/** pnpm или yarn, которые зовут команды верстака и проверок, и то, что указано в `packageManager` приложения. */
async function packageManagersOf(config: RemontnikConfig, repoDir: string | undefined): Promise<{ needed: Set<'pnpm' | 'yarn'>; pinned?: string }> {
  const commands = [config.workbench.install, config.checks.test, config.checks.typecheck ?? ''].join('\n')
  const needed = new Set<'pnpm' | 'yarn'>()
  if (/(^|[\s;&|(])(pnpm|pnpx)(\s|$)/m.test(commands)) needed.add('pnpm')
  if (/(^|[\s;&|(])yarn(\s|$)/m.test(commands)) needed.add('yarn')
  const manifest = repoDir ? await readFile(join(repoDir, 'package.json'), 'utf8').then((text) => JSON.parse(text) as { packageManager?: unknown }, () => undefined) : undefined
  const pinned = typeof manifest?.packageManager === 'string' ? manifest.packageManager : undefined
  const pinnedName = /^(pnpm|yarn)@/.exec(pinned ?? '')?.[1] as 'pnpm' | 'yarn' | undefined
  if (pinnedName && needed.size > 0) needed.add(pinnedName)
  return { needed, ...(manifest ? { pinned: pinned ?? '' } : {}) }
}

/**
 * pnpm и yarn в образе верстака: своя программа или corepack (по нему врач подставляет `pnpm` и `yarn` сам). Нет ни того,
 * ни другого — установка в первом же случае упадёт с «pnpm: not found». Образ запускается без сети и только читает.
 */
async function checkWorkbenchTools(env: DoctorEnv, docker: string, config: RemontnikConfig): Promise<Finding[]> {
  const { needed, pinned } = await packageManagersOf(config, value(env, 'REMONTNIK_CONFIG_REPO_DIR'))
  if (needed.size === 0) return []
  const image = config.workbench.image
  const names = [...needed].join(' и ')
  // Docker недоступен — об этом уже ошибка в проверке Docker.
  if (!(await run(docker, ['version', '--format', '{{.Server.Version}}'], env)).ok) return []
  if (!(await run(docker, ['image', 'inspect', '--format', '{{.Id}}', image], env)).ok) {
    return [{ level: 'warning', area: 'верстак', problem: `образа верстака ${image} нет на сервере: есть ли в нём ${names}, не проверить`, fix: `docker pull ${image} и снова check-config` }]
  }
  const probe = await run(docker, ['run', '--rm', '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--entrypoint', 'sh', image, '-c', 'for t in pnpm yarn corepack; do command -v "$t" >/dev/null 2>&1 && echo "$t"; done; true'], env)
  if (!probe.ok) {
    return [{ level: 'warning', area: 'верстак', problem: `образ верстака ${image} не запустился для проверки ${names}`, fix: `в образе нужен sh; проверьте: docker run --rm --entrypoint sh ${image} -c "command -v ${[...needed][0]}"` }]
  }
  const tools = new Set(probe.stdout.split('\n').map((line) => line.trim()))
  const findings: Finding[] = []
  for (const name of needed) {
    if (tools.has(name)) {
      findings.push({ level: 'ok', area: 'верстак', problem: `${name} есть в образе верстака`, fix: '' })
      continue
    }
    if (!tools.has('corepack')) {
      findings.push({ level: 'error', area: 'верстак', problem: `в образе верстака ${image} нет ни ${name}, ни corepack: установка упадёт с «${name}: not found»`, fix: `возьмите образ с corepack (node:22, node:24) или со своим ${name} (deploy/workbench.Dockerfile); пример — docs/configuration.md, раздел workbench` })
      continue
    }
    if (pinned === '') {
      findings.push({ level: 'warning', area: 'верстак', problem: `${name} в верстаке — через corepack, а поля packageManager в package.json нет: corepack возьмёт свою версию, не ту, что у файла-замка`, fix: `закрепите версию в package.json: "packageManager": "${name}@<версия>" (${name} --version)` })
      continue
    }
    findings.push({ level: 'ok', area: 'верстак', problem: `${name} в верстаке — через corepack, версия из packageManager`, fix: '' })
  }
  return findings
}

/** Все проверки подряд; ни одна не меняет сервер, репозиторий, GitHub или своё хранилище. */
export async function checkDoctorConfig(env: DoctorEnv, deps: CheckConfigDeps = {}): Promise<Finding[]> {
  const { config, findings: settings } = await checkSettings(env, deps)
  return [
    ...settings,
    ...(config ? await checkDeployCommands(env, config) : []),
    ...(config ? await checkEvalScenarios(env, config) : []),
    ...checkEnvironment(env, config),
    ...(config ? await checkServices(env, config) : []),
    ...(await checkDocker(env, deps.docker ?? 'docker')),
    ...(config ? await checkWorkbenchTools(env, deps.docker ?? 'docker', config) : []),
    ...(await checkBrowserPolicy(env, deps.docker ?? 'docker')),
    ...(await checkOrigin(env, deps, config)),
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
