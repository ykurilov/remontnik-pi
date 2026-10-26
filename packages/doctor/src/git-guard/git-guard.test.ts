import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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
})
