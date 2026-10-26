import { spawn } from 'node:child_process'
import { existsSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
import { redactSecrets } from '@ykurilov/remontnik-core/redact'

// Git-замок: единственный путь врача к git. Модель git не получает вовсе; врач зовёт git только отсюда.
// Разрешено немногое: забрать изменения, сделать копию в своей ветке `remontnik/…`, закоммитить, отправить
// свою ветку без перезаписи. В основную ветку — только при `mainline: "merge"` и только вперёд, без `--force`.
// Хуки репозитория выключены: их код написан приложением и не должен выполняться с правами врача.

export const TREATMENT_BRANCH_PREFIX = 'remontnik/'
const DEFAULT_TIMEOUT_MS = 120_000
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024

export type GitGuardErrorCode = 'forbidden' | 'failed' | 'timeout'

export class GitGuardError extends Error {
  readonly code: GitGuardErrorCode

  constructor(code: GitGuardErrorCode, message: string) {
    super(message)
    this.name = 'GitGuardError'
    this.code = code
  }
}

export interface GitGuardOptions {
  /** Рабочая копия основной ветки приложения. */
  repoDir: string
  /** Папка, где живут копии врача (верстаки и проверочные копии). */
  worktreesDir: string
  mainBranch: string
  mainline: 'merge' | 'pull-request'
  author: { name: string; email: string }
  remote?: string
  timeoutMs?: number
  /** Для проверок: другой исполняемый файл вместо `git`. */
  gitBinary?: string
  /** Дополнительные переменные для git, например доступ к origin. Значения вырезаются из текстов ошибок. */
  env?: Record<string, string>
}

export interface AddWorktreeOptions {
  path: string
  /** Ветка врача; без неё копия стоит на коммите без ветки (проверочная копия). */
  branch?: string
  base: string
  /** Файлы основы, которых в копии быть не должно (sparse checkout). */
  exclude?: readonly string[]
}

export interface GitGuard {
  /** Любая разрешённая команда git. Возвращает stdout. */
  run(args: readonly string[], options?: { cwd?: string }): Promise<string>
  fetch(): Promise<void>
  resolve(ref: string, options?: { cwd?: string }): Promise<string>
  /** Копия от `base`. Если она уже есть (перезапуск врача), остаётся как есть. */
  addWorktree(options: AddWorktreeOptions): Promise<void>
  removeWorktree(path: string): Promise<void>
  /** Все файлы коммита. */
  listFiles(commit: string): Promise<string[]>
  /** Пути, изменённые в `cwd` относительно `base` (по коммитам). */
  changedPaths(cwd: string, base: string): Promise<string[]>
  /** Коммит всех изменений копии; `undefined`, если менять нечего. */
  commitAll(cwd: string, message: string): Promise<string | undefined>
  push(branch: string): Promise<void>
  /** Влить ветку врача в основную вперёд (`--ff-only`). Только при `mainline: "merge"`. */
  mergeIntoMain(branch: string): Promise<void>
}

const TRANSLIT: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm',
  н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sch',
  ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
}

/** Короткая метка ветки: латиница, цифры и дефисы, не длиннее 40 знаков. */
export function slugify(text: string): string {
  const latin = [...text.toLowerCase()].map((char) => TRANSLIT[char] ?? char).join('')
  const slug = latin
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '')
  return slug || 'fix'
}

export function treatmentBranch(caseId: number, slug: string): string {
  return `${TREATMENT_BRANCH_PREFIX}${caseId}-${slugify(slug)}`
}

const ALWAYS_FORBIDDEN_FLAGS = new Set([
  '--force',
  '-f',
  '--force-with-lease',
  '--force-if-includes',
  '--mirror',
  '--all',
  '--delete',
  '-d',
  '-D',
  '--amend',
  '--no-verify',
  '--tags',
])
const DANGEROUS_PATTERN = /upload-pack|receive-pack|--exec|--config|core\.|--template/i
const READ_ONLY = new Set(['status', 'diff', 'log', 'show', 'rev-parse', 'ls-tree', 'ls-files', 'merge-base', 'cat-file'])

interface Policy {
  repoDir: string
  worktreesDir: string
  mainBranch: string
  mainline: 'merge' | 'pull-request'
  remote: string
}

function isTreatmentRef(ref: string): boolean {
  const name = ref.replace(/^refs\/heads\//, '')
  return name.startsWith(TREATMENT_BRANCH_PREFIX) && !name.includes('..') && name.length > TREATMENT_BRANCH_PREFIX.length
}

function isMainRef(ref: string, policy: Policy): boolean {
  return ref.replace(/^refs\/heads\//, '') === policy.mainBranch
}

function inside(parent: string, child: string): boolean {
  const path = relative(parent, child)
  return path === '' || (!path.startsWith('..') && !isAbsolute(path))
}

/** Причина отказа или `undefined`, если команда разрешена. */
export function checkGitCommand(args: readonly string[], cwd: string, policy: Policy): string | undefined {
  const [command, ...rest] = args
  if (!command || command.startsWith('-')) return 'общие ключи git (-c, --git-dir, -C …) запрещены'
  for (const arg of rest) {
    if (ALWAYS_FORBIDDEN_FLAGS.has(arg) || /^--force/.test(arg)) return `ключ ${arg} запрещён`
    if (arg.startsWith('-') && DANGEROUS_PATTERN.test(arg)) return `ключ ${arg} запрещён`
  }
  const inMainCheckout = resolve(cwd) === resolve(policy.repoDir)
  if (READ_ONLY.has(command)) return undefined
  switch (command) {
    case 'fetch':
      return rest.every((arg) => arg === policy.remote || arg === '--prune' || arg === '--quiet') ? undefined : 'fetch только своего origin'
    case 'worktree': {
      const [action, ...options] = rest
      if (action === 'list' || action === 'prune') return undefined
      if (action === 'remove') return options.length === 1 && inside(policy.worktreesDir, resolve(options[0]!)) ? undefined : 'удалять можно только свои копии'
      if (action !== 'add') return `worktree ${action ?? ''} запрещён`
      const branchIndex = options.indexOf('-b')
      if (branchIndex !== -1 && !isTreatmentRef(options[branchIndex + 1] ?? '')) return 'ветка копии — только remontnik/…'
      const positional = options.filter((arg, index) => !arg.startsWith('-') && options[index - 1] !== '-b')
      const path = positional[0]
      if (!path || !inside(policy.worktreesDir, resolve(path))) return 'копия — только в папке врача'
      const target = positional[1]
      if (target && branchIndex === -1 && !/^[0-9a-f]{40,64}$/.test(target) && !isTreatmentRef(target)) return 'копия — на коммите или своей ветке'
      return undefined
    }
    case 'sparse-checkout':
      return !inMainCheckout && (rest[0] === 'set' || rest[0] === 'init' || rest[0] === 'list') ? undefined : 'sparse-checkout только в копии врача'
    case 'checkout':
      return !inMainCheckout && rest.length === 0 ? undefined : 'checkout только без аргументов и в копии врача'
    case 'add':
      return !inMainCheckout && rest.length === 1 && rest[0] === '-A' ? undefined : 'add только -A в копии врача'
    case 'commit':
      return !inMainCheckout && rest.length === 2 && rest[0] === '-m' ? undefined : 'commit только -m в копии врача'
    case 'push': {
      const [remote, ...refspecs] = rest
      if (remote !== policy.remote) return 'push только в свой origin'
      if (refspecs.length === 0) return 'push только с явной веткой'
      for (const refspec of refspecs) {
        if (refspec.startsWith('-')) return `ключ ${refspec} запрещён`
        if (refspec.startsWith('+')) return 'перезапись (+) запрещена'
        const parts = refspec.split(':')
        if (parts.length > 2 || parts[0] === '') return 'удаление веток запрещено'
        const destination = parts[1] ?? parts[0]!
        if (isTreatmentRef(destination)) continue
        if (isMainRef(destination, policy) && policy.mainline === 'merge') continue
        return isMainRef(destination, policy) ? 'в основную ветку врач пишет только при mainline: "merge"' : `ветка ${destination} чужая`
      }
      return undefined
    }
    case 'merge': {
      if (policy.mainline !== 'merge') return 'вливать в основную ветку можно только при mainline: "merge"'
      if (!inMainCheckout) return 'вливать можно только в рабочей копии основной ветки'
      return rest.length === 2 && rest[0] === '--ff-only' && isTreatmentRef(rest[1]!) ? undefined : 'merge только --ff-only своей ветки'
    }
    case 'tag':
      return rest.length === 1 && isTreatmentRef(rest[0]!) ? undefined : 'метки только remontnik/…'
    default:
      return `git ${command} запрещён`
  }
}

export function createGitGuard(options: GitGuardOptions): GitGuard {
  const remote = options.remote ?? 'origin'
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const repoDir = resolve(options.repoDir)
  const worktreesDir = resolve(options.worktreesDir)
  const policy: Policy = { repoDir, worktreesDir, mainBranch: options.mainBranch, mainline: options.mainline, remote }
  const knownSecrets = Object.values(options.env ?? {}).filter((value) => value.length >= 6)
  const clean = (text: string) => redactSecrets(text, { knownSecrets })

  function canonical(path: string): string {
    // Ссылки не должны уводить проверку пути в сторону: сравниваем настоящие пути.
    let current = resolve(path)
    const tail: string[] = []
    while (!existsSync(current) && dirname(current) !== current) {
      tail.unshift(current.slice(dirname(current).length + 1))
      current = dirname(current)
    }
    return resolve(realpathSync(current), ...tail)
  }

  function allowedCwd(cwd: string): boolean {
    const real = canonical(cwd)
    return real === canonical(repoDir) || inside(canonical(worktreesDir), real)
  }

  function exec(args: readonly string[], cwd: string, input?: string): Promise<string> {
    return new Promise((resolvePromise, reject) => {
      const child = spawn(
        options.gitBinary ?? 'git',
        [
          '-c', 'core.hooksPath=/dev/null',
          '-c', `user.name=${options.author.name}`,
          '-c', `user.email=${options.author.email}`,
          '-c', 'commit.gpgSign=false',
          '-c', 'tag.gpgSign=false',
          ...args,
        ],
        {
          cwd,
          detached: true,
          stdio: ['pipe', 'pipe', 'pipe'],
          env: {
            PATH: process.env.PATH ?? '/usr/bin:/bin',
            ...(process.env.HOME ? { HOME: process.env.HOME } : {}),
            GIT_TERMINAL_PROMPT: '0',
            LC_ALL: 'C',
            ...options.env,
          },
        },
      )
      let stdout = ''
      let stderr = ''
      let timedOut = false
      const timer = setTimeout(() => {
        timedOut = true
        try {
          process.kill(-child.pid!, 'SIGKILL')
        } catch {
          child.kill('SIGKILL')
        }
      }, timeoutMs)
      child.stdout.on('data', (chunk: Buffer) => {
        if (stdout.length < MAX_OUTPUT_BYTES) stdout += chunk.toString('utf8')
      })
      child.stderr.on('data', (chunk: Buffer) => {
        if (stderr.length < MAX_OUTPUT_BYTES) stderr += chunk.toString('utf8')
      })
      child.on('error', (error) => {
        clearTimeout(timer)
        reject(new GitGuardError('failed', clean(`git ${args[0]}: ${error.message}`)))
      })
      child.on('close', (code) => {
        clearTimeout(timer)
        if (timedOut) return reject(new GitGuardError('timeout', `git ${args[0]}: тайм-аут ${timeoutMs} мс`))
        if (code !== 0) return reject(new GitGuardError('failed', clean(`git ${args.join(' ')}: ${stderr.trim().slice(-2000)}`)))
        resolvePromise(stdout)
      })
      child.stdin.end(input ?? '')
    })
  }

  async function run(args: readonly string[], runOptions: { cwd?: string } = {}, input?: string): Promise<string> {
    const cwd = runOptions.cwd ?? repoDir
    if (!allowedCwd(cwd)) throw new GitGuardError('forbidden', `git вне своих папок: ${cwd}`)
    const reason = checkGitCommand(args, canonical(cwd) === canonical(repoDir) ? repoDir : cwd, policy)
    if (reason) throw new GitGuardError('forbidden', `git-замок: ${reason}`)
    return exec(args, cwd, input)
  }

  async function branchExists(branch: string): Promise<boolean> {
    try {
      await run(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])
      return true
    } catch {
      return false
    }
  }

  return {
    run: (args, runOptions) => run(args, runOptions),

    async fetch() {
      await run(['fetch', remote])
    },

    async resolve(ref, resolveOptions) {
      return (await run(['rev-parse', '--verify', `${ref}^{commit}`], resolveOptions)).trim()
    },

    async addWorktree(add) {
      const path = resolve(add.path)
      if (existsSync(resolve(path, '.git'))) return
      const target =
        add.branch === undefined
          ? ['--detach', path, add.base]
          : (await branchExists(add.branch))
            ? [path, add.branch]
            : ['-b', add.branch, path, add.base]
      await run(['worktree', 'add', '--no-checkout', ...target])
      const patterns = ['/*', ...(add.exclude ?? []).map((file) => `!/${escapeSparsePath(file)}`)]
      await run(['sparse-checkout', 'set', '--no-cone', '--stdin'], { cwd: path }, `${patterns.join('\n')}\n`)
      await run(['checkout'], { cwd: path })
    },

    async removeWorktree(path) {
      await run(['worktree', 'remove', resolve(path)])
    },

    async listFiles(commit) {
      const out = await run(['ls-tree', '-r', '--name-only', '-z', commit])
      return out.split('\0').filter(Boolean)
    },

    async changedPaths(cwd, base) {
      const out = await run(['diff', '--name-only', '-z', `${base}`, 'HEAD'], { cwd })
      return out.split('\0').filter(Boolean)
    },

    async commitAll(cwd, message) {
      await run(['add', '-A'], { cwd })
      const status = await run(['status', '--porcelain'], { cwd })
      if (status.trim() === '') return undefined
      await run(['commit', '-m', message], { cwd })
      return (await run(['rev-parse', 'HEAD'], { cwd })).trim()
    },

    async push(branch) {
      await run(['push', remote, `refs/heads/${branch}:refs/heads/${branch}`])
    },

    async mergeIntoMain(branch) {
      if (options.mainline !== 'merge') throw new GitGuardError('forbidden', 'git-замок: вливать в основную ветку можно только при mainline: "merge"')
      await run(['merge', '--ff-only', branch])
    },
  }
}

/** Путь файла как шаблон sparse checkout: служебные знаки шаблонов экранируются. */
function escapeSparsePath(path: string): string {
  return path.replace(/[\\*?[\]!#]/g, (char) => `\\${char}`).replace(/^ | $/g, (char) => `\\${char}`)
}
