import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createGitGuard, GitGuardError, slugify, treatmentBranch, type GitGuardOptions } from './index.js'

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' } }).trim()
}

/** Пустой репозиторий-«origin» и рабочая копия основной ветки рядом. */
function repo() {
  const root = mkdtempSync(join(tmpdir(), 'remontnik-guard-'))
  dirs.push(root)
  const origin = join(root, 'origin.git')
  const repoDir = join(root, 'main')
  git(root, 'init', '--bare', '--initial-branch=main', origin)
  git(root, 'clone', origin, repoDir)
  git(repoDir, 'config', 'user.email', 'doctor@example.com')
  git(repoDir, 'config', 'user.name', 'Doctor')
  writeFileSync(join(repoDir, 'app.ts'), 'export const answer = 1\n')
  git(repoDir, 'add', '-A')
  git(repoDir, 'commit', '-m', 'начало')
  git(repoDir, 'push', 'origin', 'main')
  return { root, origin, repoDir, worktreesDir: join(root, 'worktrees') }
}

function guardFor(r: ReturnType<typeof repo>, overrides: Partial<GitGuardOptions> = {}) {
  return createGitGuard({
    repoDir: r.repoDir,
    worktreesDir: r.worktreesDir,
    mainBranch: 'main',
    mainline: 'pull-request',
    author: { name: 'Ремонтник', email: 'doctor@example.invalid' },
    ...overrides,
  })
}

async function rejection(promise: Promise<unknown>): Promise<GitGuardError> {
  const error = await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  )
  expect(error).toBeInstanceOf(GitGuardError)
  return error as GitGuardError
}

describe('имя ветки врача', () => {
  it('remontnik/<caseId>-<slug>', () => {
    expect(treatmentBranch(7, 'price-crash')).toBe('remontnik/7-price-crash')
  })

  it('slug из любого текста — короткий, латиница и дефисы', () => {
    expect(slugify('TypeError: Cannot read properties of undefined (reading "price")')).toMatch(/^[a-z0-9-]{1,40}$/)
    expect(slugify('Цена падает!')).toMatch(/^[a-z0-9-]{1,40}$/)
    expect(slugify('')).toBe('fix')
  })
})

describe('git-замок', () => {
  it('разрешённый путь: копия от основы, коммит, пуш своей ветки', async () => {
    const r = repo()
    const guard = guardFor(r)
    await guard.fetch()
    const base = await guard.resolve('origin/main')
    const branch = treatmentBranch(1, 'answer')
    const path = join(r.worktreesDir, '1')
    await guard.addWorktree({ path, branch, base })
    writeFileSync(join(path, 'app.ts'), 'export const answer = 42\n')
    const commit = await guard.commitAll(path, 'Ремонтник: случай 1')
    expect(commit).toMatch(/^[0-9a-f]{40}$/)
    expect(await guard.commitAll(path, 'пусто')).toBeUndefined()
    await guard.push(branch)
    expect(git(r.origin, 'rev-parse', branch)).toBe(commit)
    expect(git(r.origin, 'rev-parse', 'main')).toBe(base)
  })

  it('повторное создание той же копии после перезапуска не падает', async () => {
    const r = repo()
    const guard = guardFor(r)
    const base = await guard.resolve('HEAD')
    const path = join(r.worktreesDir, '2')
    await guard.addWorktree({ path, branch: treatmentBranch(2, 'x'), base })
    await guard.addWorktree({ path, branch: treatmentBranch(2, 'x'), base })
  })

  it.each([
    [['push', '--force', 'origin', 'remontnik/1-x']],
    [['push', '-f', 'origin', 'remontnik/1-x']],
    [['push', '--force-with-lease', 'origin', 'remontnik/1-x']],
    [['push', 'origin', '+remontnik/1-x']],
    [['push', '--delete', 'origin', 'remontnik/1-x']],
    [['push', 'origin', ':remontnik/1-x']],
    [['push', 'origin', 'feature/other']],
    [['push', 'origin', 'remontnik/1-x:main']],
    [['push', '--mirror', 'origin']],
    [['push', '--all', 'origin']],
    [['reset', '--hard', 'HEAD~1']],
    [['config', 'user.name', 'x']],
    [['branch', '-D', 'main']],
    [['update-ref', 'refs/heads/main', 'HEAD']],
    [['filter-branch']],
    [['-c', 'core.sshCommand=sh', 'fetch']],
    [['--git-dir=/tmp', 'status']],
  ])('отклоняет %j', async (args) => {
    const r = repo()
    const error = await rejection(guardFor(r).run(args))
    expect(error.code).toBe('forbidden')
  })

  it('в основную ветку при mainline "pull-request" не пишет', async () => {
    const r = repo()
    const guard = guardFor(r)
    expect((await rejection(guard.push('main'))).code).toBe('forbidden')
    expect((await rejection(guard.mergeIntoMain('remontnik/1-x'))).code).toBe('forbidden')
  })

  it('при mainline "merge" вливает ветку врача в основную без --force', async () => {
    const r = repo()
    const guard = guardFor(r, { mainline: 'merge' })
    const base = await guard.resolve('HEAD')
    const branch = treatmentBranch(3, 'merge')
    const path = join(r.worktreesDir, '3')
    await guard.addWorktree({ path, branch, base })
    writeFileSync(join(path, 'app.ts'), 'export const answer = 3\n')
    const commit = await guard.commitAll(path, 'Ремонтник: случай 3')
    await guard.mergeIntoMain(branch)
    await guard.push('main')
    expect(git(r.origin, 'rev-parse', 'main')).toBe(commit)
    expect((await rejection(guard.run(['push', '--force', 'origin', 'main']))).code).toBe('forbidden')
  })

  it('команды вне своих папок отклонены', async () => {
    const r = repo()
    const error = await rejection(guardFor(r).run(['status'], { cwd: r.root }))
    expect(error.code).toBe('forbidden')
  })

  it('у каждой команды тайм-аут', async () => {
    const r = repo()
    // Медленный «git»: обёртка, которая спит дольше тайм-аута.
    const slowGit = join(r.root, 'slow-git.sh')
    writeFileSync(slowGit, '#!/bin/sh\nsleep 5\n', { mode: 0o755 })
    const guard = guardFor(r, { timeoutMs: 200, gitBinary: slowGit })
    const started = Date.now()
    const error = await rejection(guard.run(['status']))
    expect(error.code).toBe('timeout')
    expect(Date.now() - started).toBeLessThan(3_000)
  })

  it('fetch --prune отклонён: чужие ветки origin врач не удаляет даже у себя', async () => {
    const r = repo()
    expect((await rejection(guardFor(r).run(['fetch', '--prune', 'origin']))).code).toBe('forbidden')
  })

  it('существующую метку не перезаписывает', async () => {
    const r = repo()
    const guard = guardFor(r)
    await guard.run(['tag', 'remontnik/pre-deploy/1'])
    const before = git(r.repoDir, 'rev-parse', 'remontnik/pre-deploy/1')
    writeFileSync(join(r.repoDir, 'app.ts'), 'export const answer = 2\n')
    git(r.repoDir, 'commit', '-am', 'дальше')
    expect((await rejection(guard.run(['tag', 'remontnik/pre-deploy/1']))).code).toBe('forbidden')
    expect(git(r.repoDir, 'rev-parse', 'remontnik/pre-deploy/1')).toBe(before)
  })

  it('метка прежней версии: на заданном коммите и в origin; повтор безопасен, другой коммит под той же меткой — отказ', async () => {
    const r = repo()
    const guard = guardFor(r)
    const running = await guard.resolve('HEAD')
    writeFileSync(join(r.repoDir, 'app.ts'), 'export const answer = 2\n')
    git(r.repoDir, 'commit', '-am', 'дальше')
    const later = await guard.resolve('HEAD')

    await guard.tagPreDeploy('remontnik/pre-deploy/2026-10-26-7-1', running)
    await guard.tagPreDeploy('remontnik/pre-deploy/2026-10-26-7-1', running)

    expect(git(r.origin, 'rev-parse', 'refs/tags/remontnik/pre-deploy/2026-10-26-7-1^{commit}')).toBe(running)
    expect((await rejection(guard.tagPreDeploy('remontnik/pre-deploy/2026-10-26-7-1', later))).code).toBe('forbidden')
    expect((await rejection(guard.tagPreDeploy('release-1', running))).code).toBe('forbidden')
    expect((await rejection(guard.tagPreDeploy('remontnik/pre-deploy/x', 'main'))).code).toBe('forbidden')
    // Чужие метки в origin врач не трогает.
    expect((await rejection(guard.run(['push', 'origin', 'refs/tags/v1:refs/tags/v1']))).code).toBe('forbidden')
    expect((await rejection(guard.run(['push', 'origin', '+refs/tags/remontnik/x:refs/tags/remontnik/x']))).code).toBe('forbidden')
  })

  it('проверочная копия с fresh пересоздаётся начисто: мусор прошлого прогона пропадает', async () => {
    const r = repo()
    const guard = guardFor(r)
    const first = await guard.resolve('HEAD')
    const path = join(r.worktreesDir, 'case-1-candidate')
    await guard.addWorktree({ path, base: first, fresh: true })
    writeFileSync(join(path, 'leftover.txt'), 'от прошлого прогона\n')
    writeFileSync(join(path, 'app.ts'), 'испорчено\n')
    writeFileSync(join(r.repoDir, 'app.ts'), 'export const answer = 5\n')
    git(r.repoDir, 'commit', '-am', 'дальше')
    const second = git(r.repoDir, 'rev-parse', 'HEAD')
    await guard.addWorktree({ path, base: second, fresh: true })
    expect(existsSync(join(path, 'leftover.txt'))).toBe(false)
    expect(readFileSync(join(path, 'app.ts'), 'utf8')).toBe('export const answer = 5\n')
    expect(git(path, 'rev-parse', 'HEAD')).toBe(second)
    await guard.removeWorktree(path)
    expect(existsSync(path)).toBe(false)
  })

  it('копию с закрытыми правами (папки 000) удаляет целиком, следующий fresh не падает', async () => {
    const r = repo()
    const guard = guardFor(r)
    const base = await guard.resolve('HEAD')
    const path = join(r.worktreesDir, 'case-2-candidate')
    await guard.addWorktree({ path, base, fresh: true })
    const locked = join(path, 'build', 'cache')
    mkdirSync(locked, { recursive: true })
    writeFileSync(join(locked, 'x.bin'), 'x')
    chmodSync(locked, 0o000)
    chmodSync(join(path, 'build'), 0o500)
    await guard.addWorktree({ path, base, fresh: true })
    expect(existsSync(join(path, 'build'))).toBe(false)
    await guard.removeWorktree(path)
    expect(existsSync(path)).toBe(false)
  })

  it('изменённые файлы правки: статус, строки, дифф, режим', async () => {
    const r = repo()
    const guard = guardFor(r)
    const base = await guard.resolve('HEAD')
    const path = join(r.worktreesDir, 'case-4')
    await guard.addWorktree({ path, branch: treatmentBranch(4, 'files'), base })
    writeFileSync(join(path, 'app.ts'), 'export const answer = 42\n')
    writeFileSync(join(path, 'app.test.ts'), 'test\n')
    await guard.commitAll(path, 'правка')
    const files = await guard.changedFiles(path, base)
    expect(files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'app.ts', status: 'modified', added: 1, removed: 1, mode: '100644', previousMode: '100644' }),
        expect.objectContaining({ path: 'app.test.ts', status: 'added', added: 1, removed: 0 }),
      ]),
    )
    expect(files.find((file) => file.path === 'app.ts')?.patch).toContain('+export const answer = 42')
  })
})

describe('git-замок: выход из копии через .git', () => {
  /** Команда, которая оставляет след, если git врача её выполнит. */
  function trap(r: ReturnType<typeof repo>) {
    const marker = join(r.root, 'PWNED')
    const hook = join(r.root, 'hook.sh')
    writeFileSync(hook, `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 })
    return { marker, hook }
  }

  async function copyOf(r: ReturnType<typeof repo>, guard = guardFor(r)) {
    const base = await guard.resolve('HEAD')
    const path = join(r.worktreesDir, 'case-9')
    await guard.addWorktree({ path, branch: treatmentBranch(9, 'escape'), base })
    writeFileSync(join(path, 'app.ts'), 'export const answer = 9\n')
    return { guard, path }
  }

  it('папка .git вместо файла-указателя с core.fsmonitor — отказ «escape», команда не выполнена', async () => {
    const r = repo()
    const { marker, hook } = trap(r)
    const { guard, path } = await copyOf(r)
    rmSync(join(path, '.git'))
    git(path, 'init', '--quiet')
    git(path, 'config', 'core.fsmonitor', hook)
    const error = await rejection(guard.commitAll(path, 'правка'))
    expect(error.code).toBe('escape')
    expect(existsSync(marker)).toBe(false)
  })

  it('файл .git, ведущий в чужой gitdir, — отказ «escape»', async () => {
    const r = repo()
    const { marker, hook } = trap(r)
    const { guard, path } = await copyOf(r)
    const foreign = join(r.root, 'foreign')
    git(r.root, 'init', '--quiet', foreign)
    git(foreign, 'config', 'core.fsmonitor', hook)
    writeFileSync(join(path, '.git'), `gitdir: ${join(foreign, '.git')}\n`)
    expect((await rejection(guard.commitAll(path, 'правка'))).code).toBe('escape')
    expect((await rejection(guard.changedPaths(path, 'HEAD'))).code).toBe('escape')
    expect(existsSync(marker)).toBe(false)
  })

  it('.git — ссылка на чужую папку — отказ «escape»', async () => {
    const r = repo()
    const { guard, path } = await copyOf(r)
    const foreign = join(r.root, 'foreign')
    git(r.root, 'init', '--quiet', foreign)
    rmSync(join(path, '.git'))
    execFileSync('ln', ['-s', join(foreign, '.git'), join(path, '.git')])
    expect((await rejection(guard.commitAll(path, 'правка'))).code).toBe('escape')
  })

  it('вложенный репозиторий в копии с fsmonitor и фильтром — отказ «escape», команда не выполнена', async () => {
    const r = repo()
    const { marker, hook } = trap(r)
    const { guard, path } = await copyOf(r)
    const nested = join(path, 'vendor', 'lib')
    mkdirSync(nested, { recursive: true })
    git(nested, 'init', '--quiet')
    git(nested, 'config', 'core.fsmonitor', hook)
    git(nested, 'config', 'filter.evil.clean', `touch '${marker}'; cat`)
    writeFileSync(join(nested, '.gitattributes'), '* filter=evil\n')
    writeFileSync(join(nested, 'x.txt'), 'x\n')
    git(nested, 'add', '-A')
    git(nested, '-c', 'user.email=a@example.com', '-c', 'user.name=a', 'commit', '--quiet', '-m', 'x')
    rmSync(marker, { force: true })
    writeFileSync(join(nested, 'x.txt'), 'y\n')
    const error = await rejection(guard.commitAll(path, 'правка'))
    expect(error.code).toBe('escape')
    expect(existsSync(marker)).toBe(false)
  })

  it('вложенный репозиторий в node_modules — тоже «escape»', async () => {
    const r = repo()
    const { marker, hook } = trap(r)
    const { guard, path } = await copyOf(r)
    const nested = join(path, 'node_modules', 'evil')
    mkdirSync(nested, { recursive: true })
    git(nested, 'init', '--quiet')
    git(nested, 'config', 'core.fsmonitor', hook)
    expect((await rejection(guard.commitAll(path, 'правка'))).code).toBe('escape')
    expect(existsSync(marker)).toBe(false)
  })

  it('повторное открытие подменённой копии — тоже «escape»', async () => {
    const r = repo()
    const { guard, path } = await copyOf(r)
    rmSync(join(path, '.git'))
    git(path, 'init', '--quiet')
    const base = await guard.resolve('HEAD')
    expect((await rejection(guard.addWorktree({ path, branch: treatmentBranch(9, 'escape'), base }))).code).toBe('escape')
  })

  it('чужой глобальный и системный конфиг git врачу в копии не читаются', async () => {
    const r = repo()
    const { marker } = trap(r)
    const home = join(r.root, 'home')
    mkdirSync(home)
    writeFileSync(join(home, '.gitconfig'), `[filter "evil"]\n\tclean = touch '${marker}'; cat\n`)
    const { guard, path } = await copyOf(r)
    writeFileSync(join(path, '.gitattributes'), '* filter=evil\n')
    const savedHome = process.env.HOME
    process.env.HOME = home
    try {
      await guard.commitAll(path, 'правка')
    } finally {
      process.env.HOME = savedHome
    }
    expect(existsSync(marker)).toBe(false)
  })
})

