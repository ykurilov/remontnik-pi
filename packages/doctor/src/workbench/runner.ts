import { spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'

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
  /** `internal` — внутренняя сеть проверок, где видно только прокси модели и службы тестов. По умолчанию — внешняя. */
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

/** HOME копии: папка по имени корня копии внутри `homesDir`. */
function homeOf(homesDir: string, copyDir: string): string {
  const home = join(homesDir, createHash('sha256').update(resolve(copyDir)).digest('hex').slice(0, 16))
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
  user?: string
  /** Файл переменных (`--env-file`): значения не видны в `ps` и аргументах клиента. */
  envFile: string
  memory: string
  cpus: string
  command: string
}

const CONTAINER_HOME = '/home/remontnik'

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
    '--label', 'remontnik.workbench=1',
    '--network', spec.network,
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
    'sh', '-c', spec.command,
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
  /** Сеть контейнера: нужна для установки пакетов, но не внутренняя сеть приложения. По умолчанию `bridge`. */
  network?: string
  /**
   * Внутренняя сеть Docker (`internal: true`) для тестов, проверки типов и eval: выхода наружу нет, видны только
   * прокси модели и службы тестов приложения. Не задана — такие команды не запускаются.
   */
  internalNetwork?: string
  /** Пользователь в контейнере; по умолчанию — тот же, что у врача, чтобы файлы копии оставались его. */
  user?: string
  /** Лимит памяти контейнера (без подкачки). По умолчанию `4g`. */
  memory?: string
  /** Лимит процессора. По умолчанию `2`. */
  cpus?: string
  docker?: string
}

const DOCKER_STEP_TIMEOUT_SECONDS = 120
const DOCKER_KILL_TIMEOUT_SECONDS = 30

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
  const clientEnv = {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    ...(process.env.HOME ? { HOME: process.env.HOME } : {}),
    ...(process.env.DOCKER_HOST ? { DOCKER_HOST: process.env.DOCKER_HOST } : {}),
  }
  const spoiledMark = (copyDir: string) => `${homeOf(options.homesDir, copyDir)}.spoiled`
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

  return {
    isolation: 'container',
    spoiled: (copyDir) => existsSync(spoiledMark(resolve(copyDir))),
    async run(command, runOptions) {
      const copyDir = resolve(runOptions.copyDir ?? runOptions.cwd)
      const inCopy = relative(copyDir, resolve(runOptions.cwd))
      if (inCopy.startsWith('..') || isAbsolute(inCopy)) return failed(`папка ${runOptions.cwd} вне копии ${copyDir}`)
      if (existsSync(spoiledMark(copyDir))) return failed(new SpoiledCopyError(copyDir).message)
      if (runOptions.network === 'internal' && !options.internalNetwork) return failed('внутренняя сеть проверок не задана (internalNetwork)')
      const name = `remontnik-${randomBytes(6).toString('hex')}`
      const envDir = mkdtempSync(join(tmpdir(), 'remontnik-env-'))
      const envFile = join(envDir, 'env')
      let created: RunResult
      try {
        writeFileSync(envFile, envFileText(runOptions.env ?? {}), { mode: 0o600 })
        const args = dockerCreateArgs({
          name,
          image: options.image,
          copyDir,
          home: homeOf(options.homesDir, copyDir),
          workdir: resolve(runOptions.cwd),
          writableDirs: (runOptions.writableDirs ?? []).map((dir) => resolve(dir)),
          network: runOptions.network === 'internal' ? options.internalNetwork! : (options.network ?? 'bridge'),
          ...(user ? { user } : {}),
          envFile,
          memory: options.memory ?? '4g',
          cpus: options.cpus ?? '2',
          command: typeof command === 'string' ? command : command.map(shellQuote).join(' '),
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
    },
  }
}
