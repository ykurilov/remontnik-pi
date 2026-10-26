// Команды выкатки «Пациента» на папках (contracts/deploy-commands.md), без Docker, git и сети:
//
//   $PATIENT_DEPLOY_ROOT/releases/<версия>/   собранные версии
//   $PATIENT_DEPLOY_ROOT/current              ссылка на работающую версию
//   $PATIENT_DEPLOY_ROOT/previous             ссылка на прежнюю версию (для отката)
//   $PATIENT_DEPLOY_ROOT/candidate            ссылка на собранного кандидата
//   $PATIENT_DEPLOY_ROOT/state.json           отметка «выкатка не подтверждена»
//   $PATIENT_DEPLOY_ROOT/settings.json        настройки владельца, необязательно: { healthUrl, versionUrl, startTimeoutSeconds }
//
// Запуск: node deploy/remontnik-deploy.ts <build|promote|confirm|rollback|current|health>.
// Перезапуск процесса «Пациента» после смены `current` — дело внешнего присмотра (systemd, pm2 и т. п.).
// С versionUrl promote и rollback ждут, пока перезапущенный процесс ответит своей версией
// (контракт: «promote 0 = кандидат работает»), не дольше startTimeoutSeconds (по умолчанию 60).
// Адреса — в файле, а не в переменных: врач не передаёт командам выкатки переменные с URL в имени.
import { cpSync, existsSync, mkdirSync, readFileSync, readlinkSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { basename, join, relative, resolve, sep } from 'node:path'

interface DeployState {
  unconfirmed: boolean
  rolledBackFrom?: string
}

interface DeploySettings {
  /** Адрес проверки здоровья работающего приложения: 200 — здоров. */
  healthUrl?: string
  /** Адрес, по которому работающее приложение отвечает `{ version }`. */
  versionUrl?: string
  startTimeoutSeconds?: number
}

class DeployError extends Error {}

const SKIPPED_ENTRIES = new Set(['node_modules', '.git', 'dist', '.remontnik'])

function deployRoot(): string {
  const root = process.env.PATIENT_DEPLOY_ROOT
  if (!root) throw new DeployError('нужна переменная PATIENT_DEPLOY_ROOT — папка выкаток')
  return resolve(root)
}

function linkTarget(root: string, name: string): string | null {
  try {
    return readlinkSync(join(root, name))
  } catch {
    return null
  }
}

function versionOf(root: string, name: string): string | null {
  const target = linkTarget(root, name)
  return target === null ? null : basename(target)
}

/** Атомарная смена ссылки: новая ссылка рядом, затем переименование поверх старой. */
function pointLink(root: string, name: string, target: string): void {
  const temporary = join(root, `.${name}.${process.pid}.tmp`)
  rmSync(temporary, { force: true })
  symlinkSync(target, temporary)
  renameSync(temporary, join(root, name))
}

function removeLink(root: string, name: string): void {
  rmSync(join(root, name), { force: true })
}

function readSettings(root: string): DeploySettings {
  const file = join(root, 'settings.json')
  if (!existsSync(file)) return {}
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as DeploySettings
  } catch (error) {
    throw new DeployError(`${file} не читается: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function readState(root: string): DeployState {
  try {
    return JSON.parse(readFileSync(join(root, 'state.json'), 'utf8')) as DeployState
  } catch {
    return { unconfirmed: false }
  }
}

function writeState(root: string, state: DeployState): void {
  const temporary = join(root, `.state.${process.pid}.tmp`)
  writeFileSync(temporary, `${JSON.stringify(state)}\n`)
  renameSync(temporary, join(root, 'state.json'))
}

function build(): string {
  const version = process.env.REMONTNIK_VERSION ?? ''
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(version)) {
    throw new DeployError(`REMONTNIK_VERSION="${version}": ожидается версия из букв, цифр, точек, дефисов`)
  }
  const root = deployRoot()
  const source = process.cwd()
  const releaseDirectory = join(root, 'releases', version)
  if (versionOf(root, 'current') === version) {
    pointLink(root, 'candidate', join('releases', version))
    return `кандидат ${version} уже работает`
  }

  mkdirSync(join(root, 'releases'), { recursive: true })
  const staging = join(root, 'releases', `.${version}.${process.pid}.tmp`)
  rmSync(staging, { recursive: true, force: true })
  cpSync(source, staging, {
    recursive: true,
    filter: (path) => {
      const inside = relative(source, path)
      if (inside === '') return true
      if (resolve(path) === root || resolve(path).startsWith(root + sep)) return false
      return !SKIPPED_ENTRIES.has(inside.split(sep)[0] ?? '')
    },
  })
  writeFileSync(join(staging, 'release.json'), `${JSON.stringify({ version, builtAt: new Date().toISOString() })}\n`)
  rmSync(releaseDirectory, { recursive: true, force: true })
  renameSync(staging, releaseDirectory)
  pointLink(root, 'candidate', join('releases', version))
  return `собран кандидат ${version}`
}

const DEFAULT_START_TIMEOUT_SECONDS = 60

async function versionAnswered(url: string): Promise<string | null> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(5_000) })
    if (response.status !== 200) return null
    const body = (await response.json()) as { version?: unknown }
    return typeof body.version === 'string' ? body.version : null
  } catch {
    return null
  }
}

/** Ждёт, пока работающее приложение ответит нужной версией. Без versionUrl — сразу. */
async function waitForRunningVersion(root: string, version: string): Promise<void> {
  const { versionUrl: url, startTimeoutSeconds: seconds = DEFAULT_START_TIMEOUT_SECONDS } = readSettings(root)
  if (!url) return
  const deadline = Date.now() + seconds * 1000
  let answered: string | null = null
  while (Date.now() < deadline) {
    answered = await versionAnswered(url)
    if (answered === version) return
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  throw new DeployError(`${version} не заработала за ${seconds} с: ${url} отвечает ${answered === null ? 'ошибкой' : `версией ${answered}`}`)
}

async function promote(): Promise<string> {
  const root = deployRoot()
  const candidate = linkTarget(root, 'candidate')
  if (candidate === null || !existsSync(join(root, candidate))) throw new DeployError('нет собранного кандидата: сначала build')
  const running = linkTarget(root, 'current')
  if (running !== null && running !== candidate) pointLink(root, 'previous', running)
  pointLink(root, 'current', candidate)
  removeLink(root, 'candidate')
  writeState(root, { unconfirmed: true })
  await waitForRunningVersion(root, basename(candidate))
  return `работает ${basename(candidate)}`
}

function confirm(): string {
  const root = deployRoot()
  mkdirSync(root, { recursive: true })
  writeState(root, { unconfirmed: false })
  return 'выкатка подтверждена'
}

async function rollback(): Promise<string> {
  const root = deployRoot()
  const previous = linkTarget(root, 'previous')
  const running = versionOf(root, 'current')
  if (previous === null) {
    const state = readState(root)
    if (state.rolledBackFrom && running !== null && running !== state.rolledBackFrom) return `уже откачено на ${running}`
    throw new DeployError('нет прежней сборки для отката')
  }
  pointLink(root, 'current', previous)
  removeLink(root, 'previous')
  writeState(root, { unconfirmed: false, ...(running ? { rolledBackFrom: running } : {}) })
  await waitForRunningVersion(root, basename(previous))
  return `откат на ${basename(previous)}`
}

function current(): string {
  const root = deployRoot()
  return JSON.stringify({ version: versionOf(root, 'current'), previous: versionOf(root, 'previous') })
}

async function health(): Promise<string> {
  const root = deployRoot()
  const version = versionOf(root, 'current')
  if (version === null || !existsSync(join(root, 'current', 'release.json'))) {
    throw new DeployError('нездоров: нет работающей версии')
  }
  const url = readSettings(root).healthUrl
  if (url) {
    const response = await fetch(url, { signal: AbortSignal.timeout(25_000) }).catch((error: unknown) => {
      throw new DeployError(`нездоров: ${url} недоступен (${error instanceof Error ? error.message : String(error)})`)
    })
    if (response.status !== 200) throw new DeployError(`нездоров: ${url} ответил ${response.status}`)
  }
  return `ok ${version}`
}

const COMMANDS: Record<string, () => string | Promise<string>> = { build, promote, confirm, rollback, current, health }

const command = COMMANDS[process.argv[2] ?? '']
if (!command) {
  console.error(`неизвестная команда "${process.argv[2] ?? ''}": ${Object.keys(COMMANDS).join(', ')}`)
  process.exit(2)
}
try {
  console.log(await command())
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  console.log(message)
  if (!(error instanceof DeployError)) console.error(error)
  process.exit(1)
}
