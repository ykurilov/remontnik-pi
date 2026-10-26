import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, isAbsolute } from 'node:path'

// Исполнитель команд верстака и проверок. Окружение процесса собирается с нуля: PATH, пустой HOME
// и только явно переданные переменные. Окружение врача (ключи моделей, git, Telegram) не наследуется.
// Каждая команда — с тайм-аутом; по нему убивается вся группа процессов.

export interface RunOptions {
  cwd: string
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
  run(command: string | readonly string[], options: RunOptions): Promise<RunResult>
}

const OUTPUT_TAIL_BYTES = 64 * 1024

interface SpawnSpec {
  file: string
  args: string[]
  cwd: string
  env: Record<string, string>
}

function spawnWithTimeout(spec: SpawnSpec, options: RunOptions, killGraceMs = 0): Promise<RunResult> {
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

export interface LocalRunnerOptions {
  /** PATH для команд; по умолчанию PATH врача. */
  path?: string
}

/** Исполнитель на этой машине — для проверок и разработки вместо контейнера. */
export function createLocalRunner(runnerOptions: LocalRunnerOptions = {}): CommandRunner {
  let home: string | undefined
  return {
    run(command, options) {
      home ??= mkdtempSync(join(tmpdir(), 'remontnik-home-'))
      const [file, ...args] = typeof command === 'string' ? ['/bin/sh', '-c', command] : [...command]
      return spawnWithTimeout(
        {
          file: file!,
          args,
          cwd: options.cwd,
          env: { PATH: runnerOptions.path ?? process.env.PATH ?? '/usr/bin:/bin', HOME: home, LANG: 'C.UTF-8', ...options.env },
        },
        options,
      )
    },
  }
}

export interface DockerExecSpec {
  container: string
  workdir: string
  env: Record<string, string>
  command: string
}

/** Аргументы `docker` для одной команды в контейнере верстака. */
export function dockerExecArgs(spec: DockerExecSpec): string[] {
  const env = Object.entries(spec.env).flatMap(([name, value]) => ['-e', `${name}=${value}`])
  return ['exec', '-i', '-w', spec.workdir, ...env, spec.container, 'sh', '-c', spec.command]
}

function shellQuote(text: string): string {
  return `'${text.replaceAll("'", `'\\''`)}'`
}

export interface DockerRunnerOptions {
  container: string
  /** Папка на сервере, смонтированная в контейнер. */
  hostRoot: string
  /** Где она видна в контейнере. */
  containerRoot: string
  docker?: string
}

/**
 * Исполнитель в контейнере: `docker exec`. В контейнер смонтирована только копия (без `.git` основного репозитория
 * и без секретов). Тайм-аут двойной: `timeout` внутри контейнера убивает саму команду, снаружи через 5 с
 * убивается клиент `docker`, если контейнер не ответил.
 */
export function createDockerRunner(options: DockerRunnerOptions): CommandRunner {
  return {
    run(command, runOptions) {
      const path = relative(options.hostRoot, runOptions.cwd)
      if (path.startsWith('..') || isAbsolute(path)) {
        return Promise.resolve({ exitCode: null, timedOut: false, aborted: false, output: '', spawnError: `папка ${runOptions.cwd} не смонтирована в контейнер` })
      }
      const workdir = path === '' ? options.containerRoot : `${options.containerRoot}/${path.split('\\').join('/')}`
      const text = typeof command === 'string' ? command : command.map(shellQuote).join(' ')
      const wrapped = `timeout -s KILL ${Math.ceil(runOptions.timeoutSeconds)} sh -c ${shellQuote(text)}`
      return spawnWithTimeout(
        {
          file: options.docker ?? 'docker',
          args: dockerExecArgs({ container: options.container, workdir, env: runOptions.env ?? {}, command: wrapped }),
          cwd: options.hostRoot,
          env: {
            PATH: process.env.PATH ?? '/usr/bin:/bin',
            ...(process.env.HOME ? { HOME: process.env.HOME } : {}),
            ...(process.env.DOCKER_HOST ? { DOCKER_HOST: process.env.DOCKER_HOST } : {}),
          },
        },
        runOptions,
        5_000,
      )
    },
  }
}
