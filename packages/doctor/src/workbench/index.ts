import { existsSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { Context } from '@earendil-works/chord/context'
import {
  err,
  ExecutionError,
  FileError,
  ok,
  type BinaryReader,
  type DirReader,
  type ExecutionEnv,
  type FileInfo,
  type FileWatcher,
  type Result,
  type ShellExecOptions,
  type ShellExecResult,
  type TextLineReader,
} from '@earendil-works/pi-durable/env'
import { NodeExecutionEnv } from '@earendil-works/pi-durable/env/node'
import { treatmentBranch, type GitGuard } from '../git-guard/index.js'
import { matchesAnyMask } from '../path-mask/index.js'
import type { CommandRunner } from './runner.js'

export * from './runner.js'

// Верстак (R4): отдельная копия репозитория на коммите рабочей версии и окружение выполнения pi-durable поверх неё.
// Модель-врач видит только эту копию: закрытых путей в ней физически нет, `.git` и всё вне копии недоступны
// файловым инструментам, команды идут через исполнитель (контейнер или локальный) без секретов и с тайм-аутом.

export interface WorkbenchOptions {
  guard: GitGuard
  worktreesDir: string
  caseId: number
  slug: string
  baseCommit: string
  closedPaths: readonly string[]
}

export interface Workbench {
  path: string
  branch: string
  baseCommit: string
}

export function workbenchPath(worktreesDir: string, caseId: number): string {
  return join(worktreesDir, `case-${caseId}`)
}

/** Создаёт копию для случая или отдаёт уже созданную (после перезапуска врача правки модели сохраняются). */
export async function createWorkbench(options: WorkbenchOptions): Promise<Workbench> {
  const path = workbenchPath(options.worktreesDir, options.caseId)
  const branch = treatmentBranch(options.caseId, options.slug)
  const closed = (await options.guard.listFiles(options.baseCommit)).filter((file) => matchesAnyMask(options.closedPaths, file))
  await options.guard.addWorktree({ path, branch, base: options.baseCommit, exclude: closed })
  const leaked = closed.filter((file) => existsSync(join(path, file)))
  if (leaked.length > 0) throw new Error(`в копии случая ${options.caseId} остались закрытые файлы: ${leaked.join(', ')}`)
  return { path, branch, baseCommit: options.baseCommit }
}

export interface ContainerExecutionEnvOptions {
  /** Копия репозитория (верстак). */
  root: string
  runner: CommandRunner
  closedPaths: readonly string[]
  /** Тайм-аут команды, если модель его не указала. */
  defaultTimeoutSeconds: number
  maxTimeoutSeconds: number
  /** Постоянные переменные команд верстака (например, `CI=1`). Окружение врача не наследуется никогда. */
  env?: Record<string, string>
}

function denied(path: string, why: string): FileError {
  return new FileError('permission_denied', `${path}: ${why}`, path)
}

/** Ближайший существующий предок пути — по нему ловим выход из копии через символьные ссылки. */
function realpathOfExisting(path: string): string {
  let current = path
  for (;;) {
    try {
      const real = realpathSync(current)
      return current === path ? real : join(real, relative(current, path))
    } catch {
      const parent = dirname(current)
      if (parent === current) return path
      current = parent
    }
  }
}

/**
 * Окружение выполнения pi-durable для модели-врача. Файлы — через `NodeExecutionEnv` после проверки пути,
 * команды — через исполнитель верстака. Наблюдение за файлами не поддерживается: модели оно не нужно.
 */
export class ContainerExecutionEnv implements ExecutionEnv {
  readonly id: string
  cwd: string
  private readonly files: NodeExecutionEnv
  private readonly realRoot: string
  private readonly tempRoots: string[] = []

  constructor(private readonly options: ContainerExecutionEnvOptions) {
    this.cwd = resolve(options.root)
    this.realRoot = realpathSync(this.cwd)
    this.id = `remontnik-workbench:${this.cwd}`
    this.files = new NodeExecutionEnv({ cwd: this.cwd, shellEnv: {} })
  }

  /** Путь внутри копии, не в `.git` и не закрытый; иначе — отказ. */
  private check(path: string): Result<string, FileError> {
    const absolute = resolve(this.cwd, path)
    const real = realpathOfExisting(absolute)
    if (this.tempRoots.some((root) => real === root || real.startsWith(root + sep))) return ok(absolute)
    const inside = relative(this.realRoot, real)
    if (inside.startsWith('..') || isAbsolute(inside)) return err(denied(path, 'вне копии репозитория'))
    const repoPath = inside.split(sep).join('/')
    if (repoPath.split('/').includes('.git')) return err(denied(path, 'служебная папка git закрыта'))
    if (repoPath !== '' && matchesAnyMask(this.options.closedPaths, repoPath)) return err(denied(path, 'закрытый путь'))
    return ok(absolute)
  }

  private async guarded<T>(path: string, action: (absolute: string) => Promise<Result<T, FileError>>): Promise<Result<T, FileError>> {
    const checked = this.check(path)
    return checked.ok ? action(checked.value) : err(checked.error)
  }

  absolutePath(path: string, context: Context) {
    return this.files.absolutePath(path, context)
  }
  joinPath(parts: string[], context: Context) {
    return this.files.joinPath(parts, context)
  }
  readTextFile(path: string, context: Context): Promise<Result<string, FileError>> {
    return this.guarded(path, (p) => this.files.readTextFile(p, context))
  }
  openTextLineReader(path: string, context: Context): Promise<Result<TextLineReader, FileError>> {
    return this.guarded(path, (p) => this.files.openTextLineReader(p, context))
  }
  readTextLines(path: string, options: { maxLines?: number } | undefined, context: Context): Promise<Result<string[], FileError>> {
    return this.guarded(path, (p) => this.files.readTextLines(p, options, context))
  }
  readBinaryFile(path: string, context: Context): Promise<Result<Uint8Array, FileError>> {
    return this.guarded(path, (p) => this.files.readBinaryFile(p, context))
  }
  openBinaryReader(path: string, options: { noFollow?: boolean } | undefined, context: Context): Promise<Result<BinaryReader, FileError>> {
    return this.guarded(path, (p) => this.files.openBinaryReader(p, options, context))
  }
  writeFile(path: string, content: string | Uint8Array, context: Context): Promise<Result<void, FileError>> {
    return this.guarded(path, (p) => this.files.writeFile(p, content, context))
  }
  appendFile(path: string, content: string | Uint8Array, context: Context): Promise<Result<void, FileError>> {
    return this.guarded(path, (p) => this.files.appendFile(p, content, context))
  }
  truncateFile(path: string, size: number, context: Context): Promise<Result<void, FileError>> {
    return this.guarded(path, (p) => this.files.truncateFile(p, size, context))
  }
  flushFile(path: string, context: Context): Promise<Result<void, FileError>> {
    return this.guarded(path, (p) => this.files.flushFile(p, context))
  }
  renameFile(sourcePath: string, destinationPath: string, context: Context): Promise<Result<void, FileError>> {
    return this.guarded(sourcePath, (source) => this.guarded(destinationPath, (destination) => this.files.renameFile(source, destination, context)))
  }
  fileInfo(path: string, context: Context): Promise<Result<FileInfo, FileError>> {
    return this.guarded(path, (p) => this.files.fileInfo(p, context))
  }
  async listDir(path: string, context: Context): Promise<Result<FileInfo[], FileError>> {
    const listed = await this.guarded(path, (p) => this.files.listDir(p, context))
    return listed.ok ? ok(listed.value.filter((entry) => this.check(entry.path).ok)) : listed
  }
  openDirReader(path: string, context: Context): Promise<Result<DirReader, FileError>> {
    return this.guarded(path, async (p) => {
      const opened = await this.files.openDirReader(p, context)
      if (!opened.ok) return opened
      const inner = opened.value
      return ok<DirReader, FileError>({
        next: async (maxEntries, nextContext) => {
          const batch = await inner.next(maxEntries, nextContext)
          return batch.ok ? ok({ ...batch.value, entries: batch.value.entries.filter((entry) => this.check(entry.path).ok) }) : batch
        },
        close: (closeContext) => inner.close(closeContext),
      })
    })
  }
  async watch(): Promise<Result<FileWatcher, FileError>> {
    return err(new FileError('not_supported', 'в верстаке наблюдение за файлами не поддерживается'))
  }
  canonicalPath(path: string, context: Context): Promise<Result<string, FileError>> {
    return this.guarded(path, (p) => this.files.canonicalPath(p, context))
  }
  exists(path: string, context: Context): Promise<Result<boolean, FileError>> {
    return this.guarded(path, (p) => this.files.exists(p, context))
  }
  createDir(path: string, options: { recursive?: boolean } | undefined, context: Context): Promise<Result<void, FileError>> {
    return this.guarded(path, (p) => this.files.createDir(p, options, context))
  }
  remove(path: string, options: { recursive?: boolean; force?: boolean } | undefined, context: Context): Promise<Result<void, FileError>> {
    return this.guarded(path, (p) => this.files.remove(p, options, context))
  }
  async createTempDir(prefix: string | undefined, context: Context): Promise<Result<string, FileError>> {
    const created = await this.files.createTempDir(prefix, context)
    if (created.ok) this.tempRoots.push(realpathSync(created.value))
    return created
  }
  async createTempFile(options: { prefix?: string; suffix?: string } | undefined, context: Context): Promise<Result<string, FileError>> {
    const created = await this.files.createTempFile(options, context)
    if (created.ok) this.tempRoots.push(realpathSync(created.value))
    return created
  }

  /**
   * Команда модели. Переменные — только постоянные верстака и явно переданные (`inheritEnv` не действует),
   * тайм-аут — заданный или по умолчанию, но не больше предела. Перелив вывода в файл не поддерживается:
   * модель получает хвост вывода.
   */
  async exec(command: string | readonly string[], options: ShellExecOptions | undefined, context: Context): Promise<Result<ShellExecResult, ExecutionError>> {
    const cwd = this.check(options?.cwd ?? '.')
    if (!cwd.ok) return err(new ExecutionError('spawn_error', cwd.error.message))
    const timeoutSeconds = Math.min(options?.timeout ?? this.options.defaultTimeoutSeconds, this.options.maxTimeoutSeconds)
    const result = await this.options.runner.run(command, {
      cwd: cwd.value,
      env: { ...this.options.env, ...options?.env },
      timeoutSeconds,
      ...(context.abortSignal ? { signal: context.abortSignal } : {}),
      onOutput: (text, stream) => options?.onOutput?.(text, context, { stream }),
    })
    if (result.timedOut) return err(new ExecutionError('timeout', `команда не уложилась в ${timeoutSeconds} с`))
    if (result.aborted) return err(new ExecutionError('aborted', 'команда отменена'))
    if (result.spawnError !== undefined || result.exitCode === null) {
      return err(new ExecutionError('spawn_error', result.spawnError ?? 'команда не запустилась'))
    }
    return ok({ exitCode: result.exitCode })
  }

  async cleanup(context: Context): Promise<void> {
    await this.files.cleanup(context)
  }
}
