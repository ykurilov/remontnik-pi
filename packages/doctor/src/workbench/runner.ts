import { spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { mkdirSync, mkdtempSync } from 'node:fs'
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
}

export interface RunResult {
  /** `null` — процесс убит (тайм-аут, отмена) или не запустился. */
  exitCode: number | null
  timedOut: boolean
  aborted: boolean
  /** Хвост общего вывода. */
  output: string
  spawnError?: string
}

export interface CommandRunner {
  /** `container` — команда видит только свою копию; `none` — процесс на этой машине с правами врача. */
  readonly isolation: 'container' | 'none'
  run(command: string | readonly string[], options: RunOptions): Promise<RunResult>
}

const OUTPUT_TAIL_BYTES = 64 * 1024

interface SpawnSpec {
  file: string
  args: string[]
  cwd: string
  env: Record<string, string>
}

function spawnWithTimeout(spec: SpawnSpec, options: RunOptions, killGraceMs = 0, onKill?: () => void): Promise<RunResult> {
  return new Promise((resolve) => {
    let output = ''
    let timedOut = false
    let aborted = false
    let settled = false
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
      onKill?.()
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
    child.on('error', (error) => finish({ exitCode: null, timedOut, aborted, output, spawnError: error.message }))
    child.on('close', (code) => finish({ exitCode: timedOut || aborted ? null : code, timedOut, aborted, output }))
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
  env: Record<string, string>
  network: string
  user?: string
  command: string
}

const CONTAINER_HOME = '/home/remontnik'

function bindMount(source: string, target: string): string[] {
  if (/[,\n]/.test(source) || /[,\n]/.test(target)) throw new Error(`путь с запятой нельзя смонтировать: ${source}`)
  return ['--mount', `type=bind,source=${source},target=${target}`]
}

/** Аргументы `docker run` для одной команды: контейнер без прав, только копия, её HOME и разрешённые папки. */
export function dockerRunArgs(spec: DockerRunSpec): string[] {
  const env = Object.entries({ ...spec.env, HOME: CONTAINER_HOME }).flatMap(([name, value]) => ['-e', `${name}=${value}`])
  return [
    'run',
    '--rm',
    '--name', spec.name,
    '--label', 'remontnik.workbench=1',
    '--network', spec.network,
    ...(spec.user ? ['--user', spec.user] : []),
    '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges',
    '--pids-limit', '1024',
    ...bindMount(spec.copyDir, spec.copyDir),
    ...bindMount(spec.home, CONTAINER_HOME),
    ...spec.writableDirs.flatMap((dir) => bindMount(dir, dir)),
    '-w', spec.workdir,
    ...env,
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
  /** Пользователь в контейнере; по умолчанию — тот же, что у врача, чтобы файлы копии оставались его. */
  user?: string
  docker?: string
}

/**
 * Исполнитель в контейнере: на каждую команду — `docker run --rm` с одной копией. Основного репозитория,
 * его gitdir (указатель `.git` копии ведёт в никуда), окружения и файлов врача в контейнере нет.
 * По тайм-ауту контейнер убивается по имени (`docker kill`), а не только клиент `docker`.
 */
export function createDockerRunner(options: DockerRunnerOptions): CommandRunner {
  const docker = options.docker ?? 'docker'
  const user = options.user ?? (process.getuid && process.getgid ? `${process.getuid()}:${process.getgid()}` : undefined)
  const clientEnv = {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    ...(process.env.HOME ? { HOME: process.env.HOME } : {}),
    ...(process.env.DOCKER_HOST ? { DOCKER_HOST: process.env.DOCKER_HOST } : {}),
  }
  return {
    isolation: 'container',
    run(command, runOptions) {
      const copyDir = resolve(runOptions.copyDir ?? runOptions.cwd)
      const inCopy = relative(copyDir, resolve(runOptions.cwd))
      if (inCopy.startsWith('..') || isAbsolute(inCopy)) {
        return Promise.resolve({ exitCode: null, timedOut: false, aborted: false, output: '', spawnError: `папка ${runOptions.cwd} вне копии ${copyDir}` })
      }
      const name = `remontnik-${randomBytes(6).toString('hex')}`
      let args: string[]
      try {
        args = dockerRunArgs({
          name,
          image: options.image,
          copyDir,
          home: homeOf(options.homesDir, copyDir),
          workdir: resolve(runOptions.cwd),
          writableDirs: (runOptions.writableDirs ?? []).map((dir) => resolve(dir)),
          env: runOptions.env ?? {},
          network: options.network ?? 'bridge',
          ...(user ? { user } : {}),
          command: typeof command === 'string' ? command : command.map(shellQuote).join(' '),
        })
      } catch (error) {
        return Promise.resolve({ exitCode: null, timedOut: false, aborted: false, output: '', spawnError: (error as Error).message })
      }
      const killContainer = () => {
        spawn(docker, ['kill', name], { env: clientEnv, stdio: 'ignore', detached: true }).on('error', () => {}).unref()
      }
      return spawnWithTimeout({ file: docker, args, cwd: copyDir, env: clientEnv }, runOptions, 0, killContainer)
    },
  }
}
