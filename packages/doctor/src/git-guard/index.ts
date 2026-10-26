import { spawn } from 'node:child_process'
import { chmodSync, existsSync, lstatSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { redactSecrets } from '@ykurilov/remontnik-core/redact'
import type { ChangedFile } from '../changed-files/index.js'

// Git-замок: единственный путь врача к git. Модель git не получает вовсе; врач зовёт git только отсюда.
// Разрешено немногое: забрать изменения, сделать копию в своей ветке `remontnik/…`, закоммитить, отправить
// свою ветку без перезаписи. В основную ветку — только при `mainline: "merge"` и только вперёд, без `--force`.
// Хуки репозитория выключены: их код написан приложением и не должен выполняться с правами врача.
//
// В копиях git врача не доверяет ничему, что лежит в самой копии: `.git` там — файл-указатель, который модель
// может подменить своей папкой с `core.fsmonitor` или фильтром. Поэтому перед каждой командой в копии указатель
// сверяется с ожидаемым gitdir, команда идёт с явными `--git-dir`/`--work-tree`, без глобального и системного
// конфига, а вложенные репозитории не принимаются. Подмена — это попытка выхода: ошибка `escape`.

export const TREATMENT_BRANCH_PREFIX = 'remontnik/'
const DEFAULT_TIMEOUT_MS = 120_000
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024

export type GitGuardErrorCode = 'forbidden' | 'failed' | 'timeout' | 'escape'

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
  /** Пересоздать копию начисто, если она уже есть (проверочные копии после перезапуска). */
  fresh?: boolean
}

export interface GitGuard {
  /** Рабочая копия основной ветки: здесь врач запускает свои команды выкатки. */
  readonly repoDir: string
  /** Любая разрешённая команда git. Возвращает stdout. */
  run(args: readonly string[], options?: { cwd?: string }): Promise<string>
  fetch(): Promise<void>
  resolve(ref: string, options?: { cwd?: string }): Promise<string>
  /** Копия от `base`. Если она уже есть (перезапуск врача), остаётся как есть, если не просили `fresh`. */
  addWorktree(options: AddWorktreeOptions): Promise<void>
  /** Удаляет копию вместе с мусором проверок. */
  removeWorktree(path: string): Promise<void>
  /** Все файлы коммита. */
  listFiles(commit: string): Promise<string[]>
  /** Пути, изменённые в `cwd` относительно `base` (по коммитам). */
  changedPaths(cwd: string, base: string): Promise<string[]>
  /** Изменённые файлы в `cwd` относительно `base`: статус, строки, дифф, режимы, полный текст `package.json`. */
  changedFiles(cwd: string, base: string): Promise<ChangedFile[]>
  /** Коммит всех изменений копии; `undefined`, если менять нечего. */
  commitAll(cwd: string, message: string): Promise<string | undefined>
  push(branch: string): Promise<void>
  /**
   * Метка `remontnik/…` на коммите `commit` и в origin: по ней человек найдёт версию, что работала до выкатки.
   * Повтор с тем же коммитом безопасен (перезапуск врача); та же метка на другом коммите — отказ.
   */
  tagPreDeploy(name: string, commit: string): Promise<void>
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

function isTreatmentTag(ref: string): boolean {
  return ref.startsWith('refs/tags/') && isTreatmentRef(ref.slice('refs/tags/'.length))
}

const COMMIT_ID = /^[0-9a-f]{40,64}$/

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
      return rest.every((arg) => arg === policy.remote || arg === '--quiet') ? undefined : 'fetch только своего origin, без --prune'
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
      if (target && branchIndex === -1 && !COMMIT_ID.test(target) && !isTreatmentRef(target)) return 'копия — на коммите или своей ветке'
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
        if (destination.startsWith('refs/tags/')) {
          if (isTreatmentTag(destination) && parts[0] === destination) continue
          return `метка ${destination} чужая`
        }
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
      if (!isTreatmentRef(rest[0] ?? '')) return 'метки только remontnik/…'
      return rest.length === 1 || (rest.length === 2 && COMMIT_ID.test(rest[1]!)) ? undefined : 'метка — на HEAD или на коммите по его полному id'
    default:
      return `git ${command} запрещён`
  }
}

/**
 * `chmod -R u+rwx` без перехода по ссылкам: команды в копии могли закрыть папки (режим 000), и тогда удаление
 * копии падает на полпути, а следующая проверочная копия на том же месте не создаётся.
 */
function restoreOwnerAccess(path: string): void {
  let stat
  try {
    stat = lstatSync(path)
  } catch {
    return
  }
  if (stat.isSymbolicLink()) return
  try {
    chmodSync(path, (stat.mode & 0o7777) | 0o700)
  } catch {
    return
  }
  if (!stat.isDirectory()) return
  for (const name of readdirSync(path)) restoreOwnerAccess(join(path, name))
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

  const commonGitDir = (() => {
    try {
      return realpathSync(join(repoDir, '.git'))
    } catch {
      return resolve(repoDir, '.git')
    }
  })()

  function escape(path: string, why: string): GitGuardError {
    return new GitGuardError('escape', `git-замок: копия ${path} подменена (${why}) — похоже на попытку выхода из верстака`)
  }

  /**
   * Gitdir копии, если её `.git` — нетронутый файл-указатель врача: обычный файл (не папка, не ссылка),
   * ведёт в `<repo>/.git/worktrees/<имя>`, и тот gitdir ведёт обратно в эту копию.
   */
  function verifiedGitDir(copy: string): string {
    const pointer = join(copy, '.git')
    let stat
    try {
      stat = lstatSync(pointer)
    } catch {
      throw escape(copy, 'нет .git')
    }
    if (!stat.isFile()) throw escape(copy, stat.isDirectory() ? '.git — папка' : '.git — не обычный файл')
    const match = /^gitdir: (.+)\n?$/.exec(readFileSync(pointer, 'utf8'))
    if (!match) throw escape(copy, 'в .git не указатель')
    let gitDir: string
    try {
      gitDir = realpathSync(resolve(copy, match[1]!))
    } catch {
      throw escape(copy, '.git ведёт в несуществующую папку')
    }
    if (dirname(gitDir) !== join(commonGitDir, 'worktrees')) throw escape(copy, '.git ведёт в чужой gitdir')
    let back: string
    try {
      back = realpathSync(dirname(readFileSync(join(gitDir, 'gitdir'), 'utf8').trim()))
    } catch {
      throw escape(copy, 'gitdir копии не ведёт обратно')
    }
    if (back !== canonical(copy)) throw escape(copy, 'gitdir принадлежит другой копии')
    return gitDir
  }

  function exec(args: readonly string[], cwd: string, input?: string, copy?: { gitDir: string; workTree: string }): Promise<string> {
    return new Promise((resolvePromise, reject) => {
      const child = spawn(
        options.gitBinary ?? 'git',
        [
          ...(copy ? [`--git-dir=${copy.gitDir}`, `--work-tree=${copy.workTree}`] : []),
          '-c', 'core.hooksPath=/dev/null',
          '-c', 'core.fsmonitor=false',
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
            // Конфиг git — только репозитория и врача (`-c`): глобальный и системный могли бы подсунуть фильтры.
            GIT_CONFIG_NOSYSTEM: '1',
            GIT_CONFIG_GLOBAL: '/dev/null',
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

  /** Корень копии, в которой лежит `cwd`, или `undefined` для рабочей копии основной ветки. */
  function copyRootOf(cwd: string): string | undefined {
    const real = canonical(cwd)
    if (real === canonical(repoDir)) return undefined
    const [first] = relative(canonical(worktreesDir), real).split(/[\\/]/)
    return join(canonical(worktreesDir), first!)
  }

  async function run(args: readonly string[], runOptions: { cwd?: string } = {}, input?: string): Promise<string> {
    const cwd = runOptions.cwd ?? repoDir
    if (!allowedCwd(cwd)) throw new GitGuardError('forbidden', `git вне своих папок: ${cwd}`)
    const reason = checkGitCommand(args, canonical(cwd) === canonical(repoDir) ? repoDir : cwd, policy)
    if (reason) throw new GitGuardError('forbidden', `git-замок: ${reason}`)
    const copyRoot = copyRootOf(cwd)
    const copy = copyRoot === undefined ? undefined : { gitDir: verifiedGitDir(copyRoot), workTree: copyRoot }
    return exec(args, cwd, input, copy)
  }

  async function tagExists(name: string): Promise<boolean> {
    try {
      await run(['rev-parse', '--verify', '--quiet', `refs/tags/${name}`])
      return true
    } catch {
      return false
    }
  }

  /** Подмодули (`160000`) в индексе копии, которых не было в последнем коммите: вложенный репозиторий модели. */
  async function newGitlinks(cwd: string): Promise<string[]> {
    const gitlinks = (out: string) =>
      out
        .split('\0')
        .filter((entry) => entry.startsWith('160000 '))
        .map((entry) => entry.slice(entry.indexOf('\t') + 1))
    const staged = gitlinks(await run(['ls-files', '--stage', '-z'], { cwd }))
    const committed = new Set(gitlinks(await run(['ls-tree', '-r', '-z', 'HEAD'], { cwd })))
    return staged.filter((path) => !committed.has(path))
  }

  /** Удаляет копию целиком (с мусором проверок) и забывает её в git. Только внутри папки копий. */
  async function removeCopy(path: string): Promise<void> {
    const real = canonical(path)
    if (real === canonical(worktreesDir) || !inside(canonical(worktreesDir), real)) throw new GitGuardError('forbidden', 'git-замок: удалять можно только свои копии')
    restoreOwnerAccess(path)
    rmSync(path, { recursive: true, force: true })
    await run(['worktree', 'prune'])
  }

  /**
   * Есть ли в рабочем дереве `.git` кроме указателя копии: вложенный репозиторий со своим конфигом.
   * Смотрит везде, и в `node_modules` тоже: законному `.git` внутри копии взяться неоткуда.
   */
  function nestedGitDirs(copyRoot: string): string[] {
    const found: string[] = []
    const walk = (dir: string, depth: number) => {
      if (depth > 64) return
      let entries
      try {
        entries = readdirSync(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const entry of entries) {
        const path = join(dir, entry.name)
        if (entry.name === '.git' && dir !== copyRoot) found.push(relative(copyRoot, path))
        else if (entry.isDirectory() && entry.name !== '.git') walk(path, depth + 1)
      }
    }
    walk(copyRoot, 0)
    return found
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
    repoDir,

    run: async (args, runOptions) => {
      // Метка не перезаписывается: git сам откажет, но отказ замка понятнее и не зависит от версии git.
      if (args[0] === 'tag' && args.length === 2 && (await tagExists(args[1]!))) throw new GitGuardError('forbidden', `git-замок: метка ${args[1]} уже есть`)
      return run(args, runOptions)
    },

    async fetch() {
      await run(['fetch', remote])
    },

    async resolve(ref, resolveOptions) {
      return (await run(['rev-parse', '--verify', `${ref}^{commit}`], resolveOptions)).trim()
    },

    async addWorktree(add) {
      const path = resolve(add.path)
      if (add.fresh) await removeCopy(path)
      else if (existsSync(path)) {
        verifiedGitDir(path)
        return
      }
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

    removeWorktree: (path) => removeCopy(resolve(path)),

    async listFiles(commit) {
      const out = await run(['ls-tree', '-r', '--name-only', '-z', commit])
      return out.split('\0').filter(Boolean)
    },

    async changedPaths(cwd, base) {
      const out = await run(['diff', '--name-only', '-z', `${base}`, 'HEAD'], { cwd })
      return out.split('\0').filter(Boolean)
    },

    async changedFiles(cwd, base) {
      return readChangedFiles((args) => run(args, { cwd }), base)
    },

    async commitAll(cwd, message) {
      const copyRoot = copyRootOf(cwd)
      if (copyRoot !== undefined) {
        verifiedGitDir(copyRoot)
        const nested = nestedGitDirs(copyRoot)
        if (nested.length > 0) throw escape(copyRoot, `вложенный репозиторий: ${nested.slice(0, 3).join(', ')}`)
      }
      await run(['add', '-A'], { cwd })
      const gitlinks = await newGitlinks(cwd)
      if (gitlinks.length > 0) throw escape(copyRoot ?? cwd, `вложенный репозиторий: ${gitlinks.slice(0, 3).join(', ')}`)
      // Не `status`: он заходит во вложенные репозитории и читает их конфиг. Сравнение индекса с коммитом — нет.
      const staged = await run(['diff', '--cached', '--name-only', '-z', '--ignore-submodules=all', '--no-ext-diff'], { cwd })
      if (staged === '') return undefined
      await run(['commit', '-m', message], { cwd })
      return (await run(['rev-parse', 'HEAD'], { cwd })).trim()
    },

    async push(branch) {
      await run(['push', remote, `refs/heads/${branch}:refs/heads/${branch}`])
    },

    async tagPreDeploy(name, commit) {
      if (!isTreatmentRef(name) || name.startsWith('refs/')) throw new GitGuardError('forbidden', 'git-замок: метки только remontnik/…')
      if (!COMMIT_ID.test(commit)) throw new GitGuardError('forbidden', 'git-замок: метка — на коммите по его полному id')
      if (await tagExists(name)) {
        const tagged = (await run(['rev-parse', `refs/tags/${name}^{commit}`])).trim()
        if (tagged !== commit) throw new GitGuardError('forbidden', `git-замок: метка ${name} уже стоит на другом коммите`)
      } else {
        await run(['tag', name, commit])
      }
      await run(['push', remote, `refs/tags/${name}:refs/tags/${name}`])
    },

    async mergeIntoMain(branch) {
      if (options.mainline !== 'merge') throw new GitGuardError('forbidden', 'git-замок: вливать в основную ветку можно только при mainline: "merge"')
      await run(['merge', '--ff-only', branch])
    },
  }
}

const STATUS: Record<string, ChangedFile['status']> = { A: 'added', M: 'modified', D: 'deleted', R: 'renamed', C: 'added', T: 'modified' }
const MANIFEST = /(^|\/)package\.json$/

/** Изменённые файлы от `base` до `HEAD`: `--raw` даёт режимы и статус, `--numstat` — строки, дифф — по файлу. */
async function readChangedFiles(git: (args: readonly string[]) => Promise<string>, base: string): Promise<ChangedFile[]> {
  const common = ['-M', '--no-ext-diff', '--no-textconv', '--ignore-submodules=none', base, 'HEAD']
  const raw = (await git(['diff', '--raw', '-z', ...common])).split('\0')
  const files: ChangedFile[] = []
  for (let index = 0; index < raw.length - 1; ) {
    const header = raw[index++]!
    const [oldMode, newMode, , , statusField] = header.slice(1).split(' ')
    const letter = statusField!.charAt(0)
    const status = STATUS[letter] ?? 'modified'
    const first = raw[index++]!
    const second = letter === 'R' || letter === 'C' ? raw[index++]! : undefined
    const path = second ?? first
    files.push({
      path,
      ...(letter === 'R' ? { previousPath: first } : {}),
      status,
      added: 0,
      removed: 0,
      ...(newMode !== '000000' ? { mode: newMode! } : {}),
      ...(oldMode !== '000000' ? { previousMode: oldMode! } : {}),
    })
  }
  const numstat = (await git(['diff', '--numstat', '-z', ...common])).split('\0')
  for (let index = 0; index < numstat.length - 1; ) {
    const [added, removed, inlinePath] = numstat[index++]!.split('\t')
    const path = inlinePath === '' ? (index++, numstat[index++]!) : inlinePath!
    const file = files.find((candidate) => candidate.path === path)
    if (!file) continue
    // Двоичный файл: `-` вместо чисел. Размер неизвестен — `NaN`, осмотр диффа это поймает.
    file.added = added === '-' ? Number.NaN : Number(added)
    file.removed = removed === '-' ? Number.NaN : Number(removed)
  }
  for (const file of files) {
    const paths = file.previousPath ? [file.previousPath, file.path] : [file.path]
    const patch = await git(['diff', '-M', '--no-ext-diff', '--no-textconv', base, 'HEAD', '--', ...paths])
    if (patch !== '' && !/^Binary files /m.test(patch)) file.patch = patch
    if (MANIFEST.test(file.path)) {
      if (file.status !== 'added') file.contentBefore = await git(['show', `${base}:${file.previousPath ?? file.path}`])
      if (file.status !== 'deleted') file.contentAfter = await git(['show', `HEAD:${file.path}`])
    }
  }
  return files
}

/** Путь файла как шаблон sparse checkout: служебные знаки шаблонов экранируются. */
function escapeSparsePath(path: string): string {
  return path.replace(/[\\*?[\]!#]/g, (char) => `\\${char}`).replace(/^ | $/g, (char) => `\\${char}`)
}
