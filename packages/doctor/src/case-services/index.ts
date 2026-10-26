import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse } from 'yaml'
import type { CaseNetworks } from '../case-networks/index.js'
import { dockerClientEnv } from '../workbench/runner.js'

// Службы для тестов приложения (`checks.services`, контракт app-integration.md, п. 5): например, временная база.
// Врач поднимает их на время проверок отдельным проектом compose — у каждой копии случая свой — в её сети проверок.
// Файл приложения не запускается как есть: из него берутся только поля из короткого списка (образ, команда,
// окружение, проверка готовности, tmpfs и подобные), и врач собирает свой проект. Портов наружу, томов хоста,
// сетей кроме сети проверок, секретов врача, `env_file`, сборки и лишних прав у служб нет. Подстановка `${…}`
// выключена. После проверок проект убирается вместе с безымянными томами; после падения врача — на старте.

export const CASE_SERVICES_LABEL = 'remontnik.case-services'
const MEMORY = '1g'
const CPUS = '1'
const PIDS_LIMIT = 512
const WAIT_TIMEOUT_SECONDS = 180
/** Подъём включает скачивание образов. */
const UP_TIMEOUT_MS = 15 * 60_000
const DOCKER_TIMEOUT_MS = 2 * 60_000

type Command = string | string[]

export interface CaseService {
  image: string
  command?: Command
  entrypoint?: Command
  environment?: Record<string, string>
  healthcheck?: Record<string, string | number | boolean | string[]>
  tmpfs?: string[]
  working_dir?: string
  user?: string
  shm_size?: string | number
  depends_on?: Record<string, { condition: string }>
}

export interface RunningCaseServices {
  /** Имя проекта compose: свой у каждой копии. */
  project: string
  /** Убрать службы и их тома; сеть проверок больше не держится. */
  down(): Promise<void>
}

export interface CaseServices {
  /** Поднять службы файла `text` для копии `copyDir` в её сети проверок и дождаться готовности. */
  up(copyDir: string, text: string): Promise<RunningCaseServices>
  /** Убрать службы прошлого запуска врача (по метке). */
  removeStale(): Promise<void>
}

export interface CaseServicesOptions {
  docker?: string
  caseNetworks: CaseNetworks
  /** Память каждой службы (без подкачки); по умолчанию `1g`. */
  memory?: string
  /** Процессор каждой службы; по умолчанию `1`. */
  cpus?: string
  log?: (line: string) => void
}

const TOP_KEYS = new Set(['services', 'name', 'version'])
const SERVICE_NAME = /^[a-z0-9][a-z0-9_-]{0,62}$/
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/
const HEALTHCHECK_KEYS = new Set(['test', 'interval', 'timeout', 'retries', 'start_period', 'start_interval', 'disable'])
const CONDITIONS = new Set(['service_started', 'service_healthy', 'service_completed_successfully'])

function refuse(message: string): never {
  throw new Error(`файл служб для тестов (checks.services): ${message}`)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function text(value: unknown, where: string): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return refuse(`${where}: нужна строка`)
}

function command(value: unknown, where: string): Command {
  if (Array.isArray(value)) return value.map((part, index) => text(part, `${where}[${index}]`))
  return text(value, where)
}

function environment(value: unknown, where: string): Record<string, string> {
  const entries: [string, string][] = Array.isArray(value)
    ? value.map((item) => {
        const line = text(item, where)
        const at = line.indexOf('=')
        // `ИМЯ` без значения берёт значение из окружения запуска — у врача это его секреты.
        if (at < 1) refuse(`${where}: «${line}» без значения`)
        return [line.slice(0, at), line.slice(at + 1)]
      })
    : isRecord(value)
      ? Object.entries(value).map(([name, item]) => {
          if (item === null || item === undefined) refuse(`${where}.${name} без значения`)
          return [name, text(item, `${where}.${name}`)]
        })
      : refuse(`${where}: нужен словарь или список`)
  for (const [name] of entries) if (!ENV_NAME.test(name)) refuse(`${where}: недопустимое имя переменной «${name}»`)
  return Object.fromEntries(entries)
}

function healthcheck(value: unknown, where: string): CaseService['healthcheck'] {
  if (!isRecord(value)) refuse(`${where}: нужен словарь`)
  const result: NonNullable<CaseService['healthcheck']> = {}
  for (const [key, item] of Object.entries(value)) {
    if (!HEALTHCHECK_KEYS.has(key)) refuse(`${where}.${key}: поле не поддерживается`)
    if (key === 'test') result.test = command(item, `${where}.test`)
    else if (key === 'retries') result.retries = Number.isInteger(item) ? (item as number) : refuse(`${where}.retries: нужно целое`)
    else if (key === 'disable') result.disable = item === true
    else result[key] = text(item, `${where}.${key}`)
  }
  return result
}

function dependsOn(value: unknown, where: string): NonNullable<CaseService['depends_on']> {
  if (Array.isArray(value)) return Object.fromEntries(value.map((name) => [text(name, where), { condition: 'service_started' }]))
  if (!isRecord(value)) refuse(`${where}: нужен список или словарь`)
  return Object.fromEntries(
    Object.entries(value).map(([name, item]) => {
      const condition = isRecord(item) && item.condition !== undefined ? text(item.condition, `${where}.${name}.condition`) : 'service_started'
      if (isRecord(item) && Object.keys(item).some((key) => key !== 'condition')) refuse(`${where}.${name}: поддерживается только condition`)
      if (!CONDITIONS.has(condition)) refuse(`${where}.${name}.condition: «${condition}» не поддерживается`)
      return [name, { condition }]
    }),
  )
}

function service(name: string, value: unknown): CaseService {
  const where = `services.${name}`
  if (!SERVICE_NAME.test(name)) refuse(`имя службы «${name}»: строчные латинские буквы, цифры, «-» и «_»`)
  if (!isRecord(value)) refuse(`${where}: нужен словарь`)
  if (typeof value.image !== 'string' || value.image.trim() === '') refuse(`${where}.image: нужен образ`)
  const result: CaseService = { image: value.image.trim() }
  for (const [key, item] of Object.entries(value)) {
    switch (key) {
      case 'image':
        break
      case 'command':
      case 'entrypoint':
        result[key] = command(item, `${where}.${key}`)
        break
      case 'environment':
        result.environment = environment(item, `${where}.environment`)
        break
      case 'healthcheck':
        result.healthcheck = healthcheck(item, `${where}.healthcheck`)
        break
      case 'tmpfs':
        result.tmpfs = Array.isArray(item) ? item.map((path) => text(path, `${where}.tmpfs`)) : [text(item, `${where}.tmpfs`)]
        break
      case 'working_dir':
      case 'user':
        result[key] = text(item, `${where}.${key}`)
        break
      case 'shm_size':
        result.shm_size = typeof item === 'number' ? item : text(item, `${where}.shm_size`)
        break
      case 'depends_on':
        result.depends_on = dependsOn(item, `${where}.depends_on`)
        break
      default:
        refuse(`${where}.${key}: поле не поддерживается — службам для тестов нельзя порты, тома, сети, права, секреты и сборку`)
    }
  }
  return result
}

/** Файл служб приложения → службы по короткому списку полей. Всё прочее — отказ с именем поля. */
export function parseServicesFile(source: string): Record<string, CaseService> {
  let document: unknown
  try {
    document = parse(source, { merge: true, maxAliasCount: 100 })
  } catch (error) {
    refuse(`не удалось разобрать: ${(error as Error).message.split('\n')[0]}`)
  }
  if (!isRecord(document)) refuse('нужен словарь с разделом services')
  for (const key of Object.keys(document)) {
    // `x-…` — заготовки для якорей YAML, сами по себе ничего не запускают.
    if (!TOP_KEYS.has(key) && !key.startsWith('x-')) refuse(`раздел ${key} не поддерживается — только services`)
  }
  if (!isRecord(document.services) || Object.keys(document.services).length === 0) refuse('нет раздела services')
  const services = Object.fromEntries(Object.entries(document.services).map(([name, value]) => [name, service(name, value)]))
  for (const [name, item] of Object.entries(services)) {
    for (const needed of Object.keys(item.depends_on ?? {})) if (!services[needed]) refuse(`services.${name}.depends_on: нет службы «${needed}»`)
  }
  return services
}

/** `$` в compose — подстановка из окружения запуска; здесь она выключена: каждый `$` удваивается. */
function literal<T>(value: T): T {
  if (typeof value === 'string') return value.replaceAll('$', () => '$$') as T
  if (Array.isArray(value)) return value.map(literal) as T
  if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, literal(item)])) as T
  return value
}

/** Проект compose врача для служб одной копии: только сеть проверок случая (по ID), метка, пределы, без лишних прав. */
export function caseServicesCompose(input: { project: string; services: Record<string, CaseService>; networkId: string; memory: string; cpus: string }): object {
  return {
    name: input.project,
    services: Object.fromEntries(
      Object.entries(input.services).map(([name, item]) => [
        name,
        {
          ...literal(item),
          networks: { case: {} },
          labels: { [CASE_SERVICES_LABEL]: input.project },
          cap_drop: ['NET_RAW', 'NET_ADMIN', 'MKNOD', 'SYS_CHROOT', 'AUDIT_WRITE', 'SETFCAP'],
          security_opt: ['no-new-privileges:true'],
          mem_limit: input.memory,
          memswap_limit: input.memory,
          cpus: input.cpus,
          pids_limit: PIDS_LIMIT,
          restart: 'no',
        },
      ]),
    ),
    networks: { case: { external: true, name: input.networkId } },
  }
}

export function createCaseServices(options: CaseServicesOptions): CaseServices {
  const docker = options.docker ?? 'docker'
  const log = options.log ?? (() => {})

  function dockerRun(args: string[], timeout = DOCKER_TIMEOUT_MS): Promise<string> {
    return new Promise((resolve, reject) => {
      // Окружение клиента — без ключей врача: подставлять в проект compose нечего.
      execFile(docker, args, { env: dockerClientEnv(), timeout, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
        if (error) reject(new Error(String(stderr || error.message).trim().slice(-800)))
        else resolve(stdout.trim())
      })
    })
  }

  return {
    async up(copyDir, source) {
      const services = parseServicesFile(source)
      const project = `remontnik-services-${createHash('sha256').update(copyDir).digest('hex').slice(0, 16)}`
      const lease = await options.caseNetworks.use(copyDir, 'checks')
      // Пустая папка проекта: compose не найдёт в ней ни `.env`, ни других файлов.
      const dir = mkdtempSync(join(tmpdir(), 'remontnik-services-'))
      const file = join(dir, 'compose.json')
      writeFileSync(file, JSON.stringify(caseServicesCompose({ project, services, networkId: lease.network.id, memory: options.memory ?? MEMORY, cpus: options.cpus ?? CPUS })), { mode: 0o600 })
      const compose = ['compose', '-p', project, '-f', file, '--project-directory', dir]
      let downing: Promise<void> | undefined
      const down = () =>
        (downing ??= (async () => {
          try {
            await dockerRun([...compose, 'down', '-v', '--remove-orphans', '--timeout', '5'])
          } catch (error) {
            log(`[врач] службы для тестов ${project} не убрались: ${(error as Error).message}`)
            await removeByLabel(`${CASE_SERVICES_LABEL}=${project}`)
          } finally {
            lease.done()
            rmSync(dir, { recursive: true, force: true })
          }
        })())
      try {
        await dockerRun([...compose, 'up', '-d', '--wait', '--wait-timeout', String(WAIT_TIMEOUT_SECONDS)], UP_TIMEOUT_MS)
      } catch (error) {
        await down()
        throw new Error(`службы для тестов не поднялись: ${(error as Error).message}`)
      }
      log(`[врач] службы для тестов ${project} поднялись: ${Object.keys(services).join(', ')}`)
      return { project, down }
    },
    async removeStale() {
      await removeByLabel(CASE_SERVICES_LABEL)
    },
  }

  async function removeByLabel(label: string): Promise<void> {
    const ids = (await dockerRun(['ps', '-aq', '--filter', `label=${label}`])).split('\n').filter(Boolean)
    if (ids.length > 0) await dockerRun(['rm', '-fv', ...ids])
  }
}
