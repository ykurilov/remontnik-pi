import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
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
  /** `container` — отдельный контейнер без секретов, сокета Docker и сети; `none` — процесс Node с правами врача. */
  readonly isolation: 'container' | 'none'
  /** Где создаются копии файлов настройки. Контейнеру копия видна по тому же пути, что и врачу. */
  readonly scratchDir: string
  /** Выполняет `node <args>` в копии; ответ — stdout. */
  run(input: ConfigReadRun): Promise<string>
}

function outputOf(error: Error | null, stdout: string, stderr: string): string {
  if (error) throw new Error(stderr.trim() || error.message)
  return stdout
}

/** Чтение настройки процессом Node на этой машине — только для тестов и разработки: код настройки может всё, что может врач. */
export function localConfigReader(options: { scratchDir?: string } = {}): ConfigCodeReader {
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
  image: string
  copyDir: string
  user?: string
  env: Record<string, string>
  args: string[]
}

export const CONFIG_READ_LABEL = 'remontnik.config-read'

/** Аргументы `docker run` для чтения настройки. Чего здесь нет — того у кода настройки нет: окружения врача, сокета, сети. */
export function configReadDockerArgs(spec: ConfigReadContainerSpec): string[] {
  if (/[,\n]/.test(spec.copyDir)) throw new Error(`путь с запятой нельзя смонтировать: ${spec.copyDir}`)
  return [
    'run',
    '--rm',
    '--name', spec.name,
    '--label', `${CONFIG_READ_LABEL}=1`,
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
    '--entrypoint', 'node',
    spec.image,
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
        try {
          resolve(outputOf(error, stdout, stderr))
        } catch (failure) {
          reject(failure)
        }
      })
    })
  let image: string | undefined
  return {
    isolation: 'container',
    scratchDir: options.scratchDir,
    async run(input) {
      image ??= (await call(['inspect', '--format', '{{.Image}}', options.gatewayContainer], CONTAINER_MARGIN_MS).catch((error: Error) => {
        throw new Error(`образ врача не найден у контейнера ${options.gatewayContainer}: ${error.message}`)
      })).trim()
      const name = `remontnik-config-${randomBytes(6).toString('hex')}`
      const args = configReadDockerArgs({ name, image, copyDir: input.copyDir, ...(user ? { user } : {}), env: input.env, args: input.args })
      try {
        return await call(args, input.timeoutMs + CONTAINER_MARGIN_MS, input.maxOutputBytes)
      } catch (error) {
        await call(['rm', '-f', name], CONTAINER_MARGIN_MS).catch(() => undefined)
        throw error
      }
    },
  }
}
