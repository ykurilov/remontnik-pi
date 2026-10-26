import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { RemontnikConfig } from '@ykurilov/remontnik-core/config'
import { redactSecrets } from '@ykurilov/remontnik-core/redact'
import { CASE_NETWORK_LABEL } from '../case-networks/index.js'
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
  area: 'настройка' | 'окружение' | 'службы' | 'docker' | 'сети' | 'github'
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
}

function run(binary: string, args: string[], env: DoctorEnv, cwd?: string): Promise<CommandResult> {
  const childEnv = Object.fromEntries(Object.entries({ ...process.env, ...env }).filter((entry): entry is [string, string] => entry[1] !== undefined))
  return new Promise((resolve) => {
    execFile(binary, args, { env: childEnv, timeout: COMMAND_TIMEOUT_MS, maxBuffer: 10 * 1024 * 1024, ...(cwd ? { cwd } : {}) }, (error, stdout) => {
      resolve({ ok: !error, missing: (error as NodeJS.ErrnoException | null)?.code === 'ENOENT', stdout: String(stdout) })
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
  } else if (control === shared) {
    findings.push({ level: 'error', area: 'окружение', problem: 'REMONTNIK_CONTROL_SECRET совпадает с REMONTNIK_SHARED_SECRET', fix: `нужен отдельный секрет владельца: ${SECRETS_FIX}` })
  }

  // Остальное (адрес приёма, пул подсетей) проверяет сам план старта. Недостающие переменные уже в списке —
  // план получает заглушки, чтобы дойти до прочих ошибок; секрет владельца проверен выше.
  if (config) {
    const patched: Record<string, string | undefined> = { ...env, ...Object.fromEntries(missing.map((name) => [name, 'заглушка'])), REMONTNIK_CONTROL_SECRET: undefined }
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
      findings.push({ level: 'error', area: 'docker', problem: `контейнер врача «${container}» не найден`, fix: 'REMONTNIK_GATEWAY_CONTAINER — имя контейнера, в котором работает врач (container_name в compose)' })
    } else if (network) {
      let networks: Record<string, unknown> = {}
      try {
        networks = JSON.parse(inspect.stdout) ?? {}
      } catch {}
      if (!Object.hasOwn(networks, network)) {
        findings.push({ level: 'error', area: 'docker', problem: `контейнер врача не подключён к сети приложения «${network}»`, fix: 'подключите врача к сети приложения в compose (networks) или исправьте REMONTNIK_LISTEN_NETWORK' })
      }
    }
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

/** Все проверки подряд; ни одна не меняет сервер, репозиторий или GitHub. */
export async function checkDoctorConfig(env: DoctorEnv, deps: CheckConfigDeps = {}): Promise<Finding[]> {
  const { config, findings: settings } = await checkSettings(env, deps)
  return [
    ...settings,
    ...checkEnvironment(env, config),
    ...(config ? await checkServices(env, config) : []),
    ...(await checkDocker(env, deps.docker ?? 'docker')),
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
