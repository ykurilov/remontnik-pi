import { spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'
import type { CaseNetworkLease, CaseNetworks } from '../case-networks/index.js'

// Исполнитель команд верстака и проверок. Окружение процесса собирается с нуля: PATH, свой HOME у каждой копии
// и только явно переданные переменные. Окружение врача (ключи моделей, git, Telegram) не наследуется.
// Каждая команда — с тайм-аутом; по нему убивается вся группа процессов.
//
// Работает врач только с контейнером (`createDockerRunner`): модель в нём не видит ни файлов сервера, ни gitdir
// основного репозитория, ни окружения врача. Локальный исполнитель — для тестов: изоляции у него нет.

export interface RunOptions {
  cwd: string
  /** Корень копии, где идёт команда: только она видна команде, и у неё свой HOME. По умолчанию — `cwd`. */
  copyDir?: string
  /** Папки вне копии, куда команде можно писать (итог eval). Других команд они не касаются. */
  writableDirs?: readonly string[]
  env?: Record<string, string>
  timeoutSeconds: number
  onOutput?: (text: string, stream: 'stdout' | 'stderr') => void
  signal?: AbortSignal
  /** `internal` — сеть проверок копии, где видно только прокси eval. По умолчанию — сеть верстака с зеркалом реестра. */
  network?: 'internal'
}

export interface RunResult {
  /** `null` — процесс убит (тайм-аут, отмена) или не запустился. */
  exitCode: number | null
  timedOut: boolean
  aborted: boolean
  /** Хвост общего вывода. */
  output: string
  spawnError?: string
  /** Команду убить не удалось: она, возможно, ещё пишет в копию. Копия испорчена (`CommandRunner.spoiled`). */
  stillRunning?: boolean
}

export interface CommandRunner {
  /** `container` — команда видит только свою копию; `none` — процесс на этой машине с правами врача. */
  readonly isolation: 'container' | 'none'
  run(command: string | readonly string[], options: RunOptions): Promise<RunResult>
  /** В копии осталась неубитая команда: доверять копии нельзя, коммитить из неё и запускать в ней — тоже. */
  spoiled(copyDir: string): boolean
}

/** Копия испорчена неубитой командой: случай останавливается, нужен человек. */
export class SpoiledCopyError extends Error {
  constructor(readonly copyDir: string) {
    super(`команда в копии ${copyDir} не остановлена: копия испорчена`)
    this.name = 'SpoiledCopyError'
  }
}

const OUTPUT_TAIL_BYTES = 64 * 1024

export interface SpawnSpec {
  file: string
  args: string[]
  cwd: string
  env: Record<string, string>
}

/** `onKill` — дополнительная остановка (контейнер по имени); итог ждёт её, `false` — команда, возможно, ещё идёт. */
export function spawnWithTimeout(spec: SpawnSpec, options: RunOptions, killGraceMs = 0, onKill?: () => Promise<boolean>): Promise<RunResult> {
  return new Promise((resolve) => {
    let output = ''
    let timedOut = false
    let aborted = false
    let settled = false
    let killing: Promise<boolean> | undefined
    const append = (text: string, stream: 'stdout' | 'stderr') => {
      output += text
      if (output.length > OUTPUT_TAIL_BYTES * 2) output = output.slice(-OUTPUT_TAIL_BYTES)
      options.onOutput?.(text, stream)
    }
    const finish = (result: RunResult) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', onAbort)
      resolve({ ...result, output: result.output.slice(-OUTPUT_TAIL_BYTES) })
    }
    if (options.signal?.aborted) return finish({ exitCode: null, timedOut: false, aborted: true, output: '' })

    const child = spawn(spec.file, spec.args, { cwd: spec.cwd, env: spec.env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
    const kill = () => {
      killing ??= onKill?.()
      try {
        process.kill(-child.pid!, 'SIGKILL')
      } catch {
        child.kill('SIGKILL')
      }
    }
    const onAbort = () => {
      aborted = true
      kill()
    }
    const timer = setTimeout(() => {
      timedOut = true
      kill()
    }, options.timeoutSeconds * 1000 + killGraceMs)
    options.signal?.addEventListener('abort', onAbort, { once: true })
    child.stdout.setEncoding('utf8').on('data', (text: string) => append(text, 'stdout'))
    child.stderr.setEncoding('utf8').on('data', (text: string) => append(text, 'stderr'))
    const stopped = async (): Promise<Pick<RunResult, 'stillRunning'>> => ((await (killing ?? true)) ? {} : { stillRunning: true })
    child.on('error', (error) => void stopped().then((still) => finish({ exitCode: null, timedOut, aborted, output, spawnError: error.message, ...still })))
    child.on('close', (code) => void stopped().then((still) => finish({ exitCode: timedOut || aborted ? null : code, timedOut, aborted, output, ...still })))
  })
}

/** Ключ копии: имя её HOME и метка её контейнеров. */
function copyKey(copyDir: string): string {
  return createHash('sha256').update(resolve(copyDir)).digest('hex').slice(0, 16)
}

/** HOME копии: папка по имени корня копии внутри `homesDir`. */
function homeOf(homesDir: string, copyDir: string): string {
  const home = join(homesDir, copyKey(copyDir))
  mkdirSync(home, { recursive: true })
  return home
}

export interface LocalRunnerOptions {
  /** PATH для команд; по умолчанию PATH врача. */
  path?: string
}

/** Исполнитель на этой машине — только для тестов и разработки: изоляции нет, команда может всё, что может врач. */
export function createLocalRunner(runnerOptions: LocalRunnerOptions = {}): CommandRunner {
  let homesDir: string | undefined
  return {
    isolation: 'none',
    run(command, options) {
      homesDir ??= mkdtempSync(join(tmpdir(), 'remontnik-home-'))
      const [file, ...args] = typeof command === 'string' ? ['/bin/sh', '-c', command] : [...command]
      return spawnWithTimeout(
        {
          file: file!,
          args,
          cwd: options.cwd,
          env: {
            PATH: runnerOptions.path ?? process.env.PATH ?? '/usr/bin:/bin',
            HOME: homeOf(homesDir, options.copyDir ?? options.cwd),
            LANG: 'C.UTF-8',
            ...options.env,
          },
        },
        options,
      )
    },
    // Группа процессов убивается сигналом сразу: неубитой команды у локального исполнителя не бывает.
    spoiled: () => false,
  }
}

export interface DockerRunSpec {
  name: string
  image: string
  /** Корень копии: монтируется по тому же пути. */
  copyDir: string
  home: string
  workdir: string
  writableDirs: readonly string[]
  network: string
  /** Записи `/etc/hosts` контейнера: имя → адрес (врач в сети случая). */
  hosts?: Record<string, string>
  user?: string
  /** Файл переменных (`--env-file`): значения не видны в `ps` и аргументах клиента. */
  envFile: string
  memory: string
  cpus: string
  command: string
  /** Срок жизни контейнера в секундах: по нему обёртка убивает всё внутри, даже если врача уже нет. */
  lifetimeSeconds: number
}

const CONTAINER_HOME = '/home/remontnik'
export const WORKBENCH_LABEL = 'remontnik.workbench'
const COPY_LABEL = 'remontnik.copy'
/** Запас срока жизни контейнера сверх тайм-аута команды: обычно её убивает врач, обёртка — когда врача нет. */
export const CONTAINER_LIFETIME_MARGIN_SECONDS = 60
/**
 * Обёртка — первый процесс контейнера (`sh -c <обёртка> remontnik <срок> <команда>`). Команда идёт дочерним `sh`,
 * обёртка раз в секунду сверяет часы и по сроку убивает все процессы контейнера, кроме себя, — контейнер кончается.
 * Счёт ведёт сам первый процесс: сигналы от процессов контейнера ему не доходят, команда срок не отменит.
 */
const LIFETIME_WRAPPER = 'end=$(( $(date +%s) + $1 )); sh -c "$2" & cmd=$!; while kill -0 "$cmd" 2>/dev/null; do if [ "$(date +%s)" -ge "$end" ]; then echo "remontnik: срок жизни контейнера истёк" >&2; kill -KILL -1; exit 137; fi; sleep 1; done; wait "$cmd"'

function bindMount(source: string, target: string): string[] {
  if (/[,\n]/.test(source) || /[,\n]/.test(target)) throw new Error(`путь с запятой нельзя смонтировать: ${source}`)
  return ['--mount', `type=bind,source=${source},target=${target}`]
}

/** Содержимое файла переменных; перевод строки в значении он не передаст — такое значение отклоняется. */
export function envFileText(env: Record<string, string>): string {
  return Object.entries({ ...env, HOME: CONTAINER_HOME })
    .map(([name, value]) => {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || /[\r\n\0]/.test(value)) throw new Error(`переменную ${name} нельзя передать файлом окружения`)
      return `${name}=${value}\n`
    })
    .join('')
}

/**
 * Аргументы `docker create` для одной команды: контейнер без прав, с лимитами памяти и процессора, корневая система
 * только для чтения; писать можно в копию, её HOME, разрешённые папки и `/tmp`.
 */
export function dockerCreateArgs(spec: DockerRunSpec): string[] {
  return [
    'create',
    '--rm',
    '--name', spec.name,
    '--label', `${WORKBENCH_LABEL}=1`,
    '--label', `${COPY_LABEL}=${copyKey(spec.copyDir)}`,
    '--network', spec.network,
    ...Object.entries(spec.hosts ?? {}).flatMap(([host, ip]) => ['--add-host', `${host}:${ip}`]),
    ...(spec.user ? ['--user', spec.user] : []),
    '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges',
    '--pids-limit', '1024',
    '--memory', spec.memory,
    '--memory-swap', spec.memory,
    '--cpus', spec.cpus,
    '--read-only',
    '--tmpfs', '/tmp:rw,exec,nosuid,nodev,size=1g',
    ...bindMount(spec.copyDir, spec.copyDir),
    ...bindMount(spec.home, CONTAINER_HOME),
    ...spec.writableDirs.flatMap((dir) => bindMount(dir, dir)),
    '-w', spec.workdir,
    '--env-file', spec.envFile,
    spec.image,
    'sh', '-c', LIFETIME_WRAPPER, 'remontnik', String(spec.lifetimeSeconds), spec.command,
  ]
}

function shellQuote(text: string): string {
  return `'${text.replaceAll("'", `'\\''`)}'`
}

export interface DockerRunnerOptions {
  /** Образ разработки приложения (`workbench.image`): Node, pnpm. Секретов и сокета Docker в нём нет. */
  image: string
  /** Где лежат HOME копий (на сервере, вне папки копий). */
  homesDir: string
  /**
   * Сети случая: у каждой копии своя закрытая сеть верстака (команды модели, установка; там зеркало реестра)
   * и своя сеть проверок (тесты, типы, eval; там прокси eval). Сеть берётся по ID и сверяется перед каждой командой.
   * Не заданы — у команд нет сети совсем, а проверки не запускаются.
   */
  caseNetworks?: CaseNetworks
  /** Переменные команд в сети верстака (адрес зеркала реестра). Сильнее переданных; в сеть проверок не уходят. */
  workbenchEnv?: Record<string, string>
  /** Пользователь в контейнере; по умолчанию — тот же, что у врача, чтобы файлы копии оставались его. */
  user?: string
  /** Лимит памяти контейнера (без подкачки). По умолчанию `4g`. */
  memory?: string
  /** Лимит процессора. По умолчанию `2`. */
  cpus?: string
  docker?: string
}

const DOCKER_STEP_TIMEOUT_SECONDS = 120
/** Имя врача в контейнере случая: по нему зеркало реестра и прокси eval, адрес — свой в каждой сети. */
export const CASE_GATEWAY_HOST = 'remontnik-gateway'

/** Окружение клиента `docker`: только то, что ему нужно, без ключей врача. */
export function dockerClientEnv(): Record<string, string> {
  return {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    ...(process.env.HOME ? { HOME: process.env.HOME } : {}),
    ...(process.env.DOCKER_HOST ? { DOCKER_HOST: process.env.DOCKER_HOST } : {}),
  }
}
const DOCKER_KILL_TIMEOUT_SECONDS = 30

/** Отметка испорченной копии рядом с её HOME: переживает перезапуск врача. */
function spoiledMarkOf(homesDir: string, key: string): string {
  return `${join(homesDir, key)}.spoiled`
}

/**
 * Контейнеры верстака прошлого запуска врача (врач упал, `--rm` их не убрал): убить и удалить. Если команда в
 * контейнере уже шла, она оборвана на середине — копия помечается испорченной. Возвращает ID удалённых.
 */
export async function removeOrphanWorkbenches(options: { homesDir: string; docker?: string; log?: (line: string) => void }): Promise<string[]> {
  const docker = options.docker ?? 'docker'
  const step = (args: string[]) => spawnWithTimeout({ file: docker, args, cwd: tmpdir(), env: dockerClientEnv() }, { cwd: tmpdir(), timeoutSeconds: DOCKER_STEP_TIMEOUT_SECONDS })
  const listed = await step(['ps', '-a', '--filter', `label=${WORKBENCH_LABEL}=1`, '--format', `{{.ID}} {{.State}} {{.Label "${COPY_LABEL}"}}`])
  if (listed.exitCode !== 0) throw new Error(`контейнеры верстака не перечислились: ${(listed.spawnError ?? listed.output).trim().slice(-300)}`)
  const removed: string[] = []
  for (const line of listed.output.split('\n')) {
    const [id, state, key] = line.trim().split(/\s+/)
    if (!id) continue
    if (state !== 'created' && key && /^[0-9a-f]{16}$/.test(key)) {
      mkdirSync(options.homesDir, { recursive: true })
      writeFileSync(spoiledMarkOf(options.homesDir, key), `${id}\n`)
    }
    const killed = await step(['rm', '-f', id])
    if (killed.exitCode === 0) removed.push(id)
    else options.log?.(`[врач] старый контейнер верстака ${id} не удалился: ${killed.output.trim().slice(-300)}`)
  }
  return removed
}

/**
 * Исполнитель в контейнере: на каждую команду — свой контейнер с одной копией. Основного репозитория,
 * его gitdir (указатель `.git` копии ведёт в никуда), окружения и файлов врача в контейнере нет.
 * Контейнер создаётся (`docker create`) с файлом переменных 0600, файл сразу удаляется, затем `docker start --attach`.
 * По тайм-ауту или отмене контейнер убивается по имени, и итог ждёт `docker kill`. Не убился — копия помечается
 * испорченной (отметка рядом с её HOME переживает перезапуск врача), и команд в ней больше нет.
 */
export function createDockerRunner(options: DockerRunnerOptions): CommandRunner {
  const docker = options.docker ?? 'docker'
  const user = options.user ?? (process.getuid && process.getgid ? `${process.getuid()}:${process.getgid()}` : undefined)
  const clientEnv = dockerClientEnv()
  const spoiledMark = (copyDir: string) => spoiledMarkOf(options.homesDir, copyKey(copyDir))
  const failed = (spawnError: string): Promise<RunResult> => Promise.resolve({ exitCode: null, timedOut: false, aborted: false, output: '', spawnError })
  const dockerStep = (args: string[], cwd: string, timeoutSeconds: number, signal?: AbortSignal) =>
    spawnWithTimeout({ file: docker, args, cwd, env: clientEnv }, { cwd, timeoutSeconds, ...(signal ? { signal } : {}) })

  /** Убивает контейнер и проверяет, что он не идёт: `true` — остановлен или его уже нет. */
  async function killContainer(name: string, cwd: string): Promise<boolean> {
    await dockerStep(['kill', name], cwd, DOCKER_KILL_TIMEOUT_SECONDS)
    const inspected = await dockerStep(['inspect', '--format', '{{.State.Running}}', name], cwd, DOCKER_KILL_TIMEOUT_SECONDS)
    if (inspected.exitCode === 0) return inspected.output.trim() === 'false'
    return inspected.exitCode !== null && /no such (object|container)/i.test(inspected.output)
  }

  /** Одна команда в своём контейнере; сеть (если есть) уже сверена. */
  async function runInContainer(command: string | readonly string[], runOptions: RunOptions, copyDir: string, lease: CaseNetworkLease | undefined): Promise<RunResult> {
    const internal = runOptions.network === 'internal'
    const name = `remontnik-${randomBytes(6).toString('hex')}`
    const envDir = mkdtempSync(join(tmpdir(), 'remontnik-env-'))
    const envFile = join(envDir, 'env')
    let created: RunResult
    try {
      const env = internal ? (runOptions.env ?? {}) : { ...runOptions.env, ...options.workbenchEnv }
      writeFileSync(envFile, envFileText(env), { mode: 0o600 })
      const args = dockerCreateArgs({
        name,
        image: options.image,
        copyDir,
        home: homeOf(options.homesDir, copyDir),
        workdir: resolve(runOptions.cwd),
        writableDirs: (runOptions.writableDirs ?? []).map((dir) => resolve(dir)),
        network: lease?.network.id ?? 'none',
        ...(lease ? { hosts: { [CASE_GATEWAY_HOST]: lease.network.gatewayIp } } : {}),
        ...(user ? { user } : {}),
        envFile,
        memory: options.memory ?? '4g',
        cpus: options.cpus ?? '2',
        command: typeof command === 'string' ? command : command.map(shellQuote).join(' '),
        lifetimeSeconds: Math.ceil(runOptions.timeoutSeconds) + CONTAINER_LIFETIME_MARGIN_SECONDS,
      })
      created = await dockerStep(args, copyDir, DOCKER_STEP_TIMEOUT_SECONDS, runOptions.signal)
    } catch (error) {
      return failed((error as Error).message)
    } finally {
      rmSync(envDir, { recursive: true, force: true })
    }
    if (created.exitCode !== 0) {
      return { ...created, exitCode: null, spawnError: created.spawnError ?? `контейнер не создан: ${created.output.trim().slice(-500)}` }
    }
    const result = await spawnWithTimeout({ file: docker, args: ['start', '--attach', name], cwd: copyDir, env: clientEnv }, runOptions, 0, () =>
      killContainer(name, copyDir),
    )
    if (result.stillRunning) writeFileSync(spoiledMark(copyDir), `${name}\n`)
    return result
  }

  return {
    isolation: 'container',
    spoiled: (copyDir) => existsSync(spoiledMark(resolve(copyDir))),
    async run(command, runOptions) {
      const copyDir = resolve(runOptions.copyDir ?? runOptions.cwd)
      const inCopy = relative(copyDir, resolve(runOptions.cwd))
      if (inCopy.startsWith('..') || isAbsolute(inCopy)) return failed(`папка ${runOptions.cwd} вне копии ${copyDir}`)
      if (existsSync(spoiledMark(copyDir))) return failed(new SpoiledCopyError(copyDir).message)
      const internal = runOptions.network === 'internal'
      if (internal && !options.caseNetworks) return failed('сети случая не заданы (caseNetworks): проверки без закрытой сети не запускаются')
      let lease: CaseNetworkLease | undefined
      try {
        lease = await options.caseNetworks?.use(copyDir, internal ? 'checks' : 'workbench')
      } catch (error) {
        return failed((error as Error).message)
      }
      try {
        return await runInContainer(command, runOptions, copyDir, lease)
      } finally {
        lease?.done()
      }
    },
  }
}
