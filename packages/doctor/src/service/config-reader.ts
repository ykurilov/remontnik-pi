import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { dockerClientEnv } from '../workbench/runner.js'

// Где выполняется код `remontnik.config.*` (`config-source.ts`). Код настройки берётся из основной ветки, но файлы,
// которые она подключает, могли прийти туда правкой врача. Процесс с правами врача видел бы его окружение
// (`/proc/<родитель>/environ`: ключи моделей, git, Telegram) и сокет Docker, то есть root на хосте. Поэтому на
// сервере настройка читается в отдельном контейнере из образа самого врача: без окружения врача, без сокета, без сети,
// с корнем только для чтения и единственной папкой — копией файлов настройки, тоже только для чтения.
// Локальный исполнитель — для тестов и разработки: изоляции у него нет.

export interface ConfigReadRun {
  /** Копия файлов настройки: только она видна коду настройки. */
  copyDir: string
  /** Аргументы `node`. */
  args: string[]
  env: Record<string, string>
  timeoutMs: number
  maxOutputBytes: number
}

export interface ConfigCodeReader {
  /**
   * `container` — отдельный контейнер без секретов, сокета Docker и сети; `none` — процесс Node с правами врача (тесты);
   * `unavailable` — выполнять негде, любое чтение кода настройки — отказ.
   */
  readonly isolation: 'container' | 'none' | 'unavailable'
  /** Где создаются копии файлов настройки. Контейнеру копия видна по тому же пути, что и врачу. */
  readonly scratchDir: string
  /** Выполняет `node <args>` в копии; ответ — stdout. */
  run(input: ConfigReadRun): Promise<string>
}

/** Исполнитель не может выполнить код настройки вовсе (нет Docker, нет контейнера врача): сама настройка тут ни при чём. */
export class ConfigReaderUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ConfigReaderUnavailableError'
  }
}

/** Исполнитель, которому выполнять негде: каждое чтение — понятный отказ. */
export function unavailableConfigReader(reason: string): ConfigCodeReader {
  return { isolation: 'unavailable', scratchDir: tmpdir(), run: () => Promise.reject(new ConfigReaderUnavailableError(reason)) }
}

function outputOf(error: Error | null, stdout: string, stderr: string): string {
  if (error) throw new Error(stderr.trim() || error.message)
  return stdout
}

/** Только для тестов: чтение настройки процессом Node на этой машине, без изоляции — код настройки может всё, что может врач. */
export function localConfigReaderForTests(options: { scratchDir?: string } = {}): ConfigCodeReader {
  return {
    isolation: 'none',
    scratchDir: options.scratchDir ?? tmpdir(),
    run: (input) =>
      new Promise((resolve, reject) => {
        execFile(
          process.execPath,
          input.args,
          { cwd: input.copyDir, timeout: input.timeoutMs, maxBuffer: input.maxOutputBytes, env: { PATH: process.env.PATH ?? '', ...input.env } },
          (error, stdout, stderr) => {
            try {
              resolve(outputOf(error, stdout, stderr))
            } catch (failure) {
              reject(failure)
            }
          },
        )
      }),
  }
}

export interface ConfigReadContainerSpec {
  name: string
  /** Контейнер врача, чей это контейнер чтения: по метке его остатки убирает старт этого врача. */
  owner: string
  image: string
  copyDir: string
  user?: string
  env: Record<string, string>
  args: string[]
  /** Срок жизни внутри контейнера: по нему `timeout` убивает код настройки, даже если клиент `docker` уже не ждёт. */
  lifetimeSeconds: number
}

export const CONFIG_READ_LABEL = 'remontnik.config-read'

/** Аргументы `docker run` для чтения настройки. Чего здесь нет — того у кода настройки нет: окружения врача, сокета, сети. */
export function configReadDockerArgs(spec: ConfigReadContainerSpec): string[] {
  if (/[,\n]/.test(spec.copyDir)) throw new Error(`путь с запятой нельзя смонтировать: ${spec.copyDir}`)
  return [
    'run',
    '--rm',
    '--name', spec.name,
    '--label', `${CONFIG_READ_LABEL}=${spec.owner}`,
    '--network', 'none',
    ...(spec.user ? ['--user', spec.user] : []),
    '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges',
    '--pids-limit', '64',
    '--memory', '512m',
    '--memory-swap', '512m',
    '--cpus', '1',
    '--read-only',
    '--tmpfs', '/tmp:rw,noexec,nosuid,nodev,size=16m',
    '--mount', `type=bind,source=${spec.copyDir},target=${spec.copyDir},readonly`,
    '-w', spec.copyDir,
    ...Object.entries(spec.env).flatMap(([name, value]) => ['--env', `${name}=${value}`]),
    // `timeout` из coreutils образа врача (Debian): по сроку — KILL всей группе процессов; с ним кончается и контейнер.
    '--entrypoint', 'timeout',
    spec.image,
    '-s', 'KILL', String(spec.lifetimeSeconds),
    'node',
    ...spec.args,
  ]
}

export interface ContainerConfigReaderOptions {
  /** Контейнер врача (`REMONTNIK_GATEWAY_CONTAINER`): из его образа берутся Node и пакеты Ремонтника. */
  gatewayContainer: string
  /** Папка для копий файлов настройки на пути, общем у врача и хоста (внутри `REMONTNIK_STATE_DIR`). */
  scratchDir: string
  docker?: string
}

/** Запас на запуск и остановку контейнера сверх срока чтения. */
const CONTAINER_MARGIN_MS = 30_000

// Клиент docker не дозвался до Docker: нет программы, сокета, прав на сокет или демон лежит.
const DOCKER_UNREACHABLE = /Cannot connect to the Docker daemon|error during connect|Is the docker daemon running|permission denied while trying to connect|docker\.sock: connect/i

/** Ошибка вызова docker: Docker недоступен — `ConfigReaderUnavailableError`, остальное — как есть. */
function dockerFailure(error: Error & { code?: unknown }, stderr: string): Error {
  const text = stderr.trim() || error.message
  if (error.code === 'ENOENT') return new ConfigReaderUnavailableError(`Docker недоступен (нет программы ${String((error as { path?: unknown }).path ?? 'docker')})`)
  if (DOCKER_UNREACHABLE.test(text)) return new ConfigReaderUnavailableError(`Docker недоступен (${text.split('\n')[0]!.slice(0, 200)})`)
  return new Error(text)
}

/**
 * Чтение настройки в контейнере из образа врача. Образ берётся по ID у контейнера врача: тот же Node и те же пакеты
 * Ремонтника, что у врача. Не вышло за срок — контейнер удаляется по имени.
 */
export function containerConfigReader(options: ContainerConfigReaderOptions): ConfigCodeReader {
  const docker = options.docker ?? 'docker'
  const env = dockerClientEnv()
  const user = process.getuid && process.getgid ? `${process.getuid()}:${process.getgid()}` : undefined
  const call = (args: string[], timeoutMs: number, maxBuffer = 1024 * 1024) =>
    new Promise<string>((resolve, reject) => {
      execFile(docker, args, { env, timeout: timeoutMs, maxBuffer }, (error, stdout, stderr) => {
        if (error) reject(dockerFailure(error, stderr))
        else resolve(stdout)
      })
    })
  let image: string | undefined
  return {
    isolation: 'container',
    scratchDir: options.scratchDir,
    async run(input) {
      image ??= (await call(['inspect', '--format', '{{.Image}}', options.gatewayContainer], CONTAINER_MARGIN_MS).catch((error: Error) => {
        if (error instanceof ConfigReaderUnavailableError) throw error
        throw new Error(`образ врача не найден у контейнера ${options.gatewayContainer}: ${error.message}`)
      })).trim()
      const name = `remontnik-config-${randomBytes(6).toString('hex')}`
      const lifetimeSeconds = Math.ceil(input.timeoutMs / 1000)
      const args = configReadDockerArgs({
        name,
        owner: options.gatewayContainer,
        image,
        copyDir: input.copyDir,
        ...(user ? { user } : {}),
        env: input.env,
        args: input.args,
        lifetimeSeconds,
      })
      try {
        return await call(args, input.timeoutMs + CONTAINER_MARGIN_MS, input.maxOutputBytes)
      } catch (error) {
        await call(['rm', '-f', name], CONTAINER_MARGIN_MS).catch(() => undefined)
        throw error
      }
    },
  }
}

/**
 * Остатки чтений настройки прошлого запуска врача (врач упал посреди чтения): контейнеры с его меткой и копии файлов
 * настройки `config-*` в папке чтения. Старт врача зовёт это раньше первого чтения.
 */
export async function removeOrphanConfigReads(options: { gatewayContainer: string; scratchDir: string; docker?: string; log?: (line: string) => void }): Promise<string[]> {
  const docker = options.docker ?? 'docker'
  const env = dockerClientEnv()
  const call = (args: string[]) =>
    new Promise<string>((resolve, reject) => {
      execFile(docker, args, { env, timeout: CONTAINER_MARGIN_MS }, (error, stdout, stderr) => (error ? reject(dockerFailure(error, stderr)) : resolve(stdout)))
    })
  const listed = await call(['ps', '-aq', '--filter', `label=${CONFIG_READ_LABEL}=${options.gatewayContainer}`])
  const removed: string[] = []
  for (const id of listed.split('\n').map((line) => line.trim()).filter(Boolean)) {
    try {
      await call(['rm', '-f', id])
      removed.push(id)
    } catch (error) {
      options.log?.(`[врач] старый контейнер чтения настройки ${id} не удалился: ${(error as Error).message.slice(-300)}`)
    }
  }
  if (existsSync(options.scratchDir)) {
    for (const entry of readdirSync(options.scratchDir)) {
      if (entry.startsWith('config-')) rmSync(join(options.scratchDir, entry), { recursive: true, force: true })
    }
  }
  return removed
}
