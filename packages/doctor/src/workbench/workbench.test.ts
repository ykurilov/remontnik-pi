import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { afterEach, describe, expect, it } from 'vitest'
import { createGitGuard } from '../git-guard/index.js'
import { ContainerExecutionEnv, createLocalRunner, createWorkbench, dockerExecArgs } from './index.js'

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

function repo() {
  const root = mkdtempSync(join(tmpdir(), 'remontnik-bench-'))
  dirs.push(root)
  const repoDir = join(root, 'main')
  mkdirSync(join(repoDir, 'secrets'), { recursive: true })
  mkdirSync(join(repoDir, 'src'), { recursive: true })
  git(root, 'init', '--initial-branch=main', repoDir)
  git(repoDir, 'config', 'user.email', 'doctor@example.com')
  git(repoDir, 'config', 'user.name', 'Doctor')
  writeFileSync(join(repoDir, 'src', 'app.ts'), 'export const version = 1\n')
  writeFileSync(join(repoDir, 'secrets', 'key.txt'), 'не для модели\n')
  writeFileSync(join(repoDir, '.env.production'), 'TOKEN=test-only\n')
  git(repoDir, 'add', '-A')
  git(repoDir, 'commit', '-m', 'основа')
  const baseCommit = git(repoDir, 'rev-parse', 'HEAD')
  writeFileSync(join(repoDir, 'src', 'app.ts'), 'export const version = 2\n')
  git(repoDir, 'commit', '-am', 'после основы')
  const guard = createGitGuard({
    repoDir,
    worktreesDir: join(root, 'worktrees'),
    mainBranch: 'main',
    mainline: 'pull-request',
    author: { name: 'Ремонтник', email: 'doctor@example.invalid' },
  })
  return { root, repoDir, baseCommit, guard, worktreesDir: join(root, 'worktrees') }
}

async function bench() {
  const r = repo()
  const workbench = await createWorkbench({
    guard: r.guard,
    worktreesDir: r.worktreesDir,
    caseId: 7,
    slug: 'price-crash',
    baseCommit: r.baseCommit,
    closedPaths: ['secrets/**', '.env*'],
  })
  return { ...r, workbench }
}

function envFor(path: string, options: { defaultTimeoutSeconds?: number } = {}) {
  return new ContainerExecutionEnv({
    root: path,
    runner: createLocalRunner(),
    closedPaths: ['secrets/**', '.env*'],
    defaultTimeoutSeconds: options.defaultTimeoutSeconds ?? 30,
    maxTimeoutSeconds: 60,
  })
}

async function run(env: ContainerExecutionEnv, command: string, timeout?: number) {
  let output = ''
  const result = await env.exec(
    command,
    { ...(timeout === undefined ? {} : { timeout }), onOutput: (text) => (output += text) },
    BACKGROUND_CONTEXT,
  )
  return { result, output }
}

describe('верстак', () => {
  it('копия стоит на baseCommit в ветке remontnik/<caseId>-<slug>', async () => {
    const b = await bench()
    expect(b.workbench.branch).toBe('remontnik/7-price-crash')
    expect(readFileSync(join(b.workbench.path, 'src', 'app.ts'), 'utf8')).toContain('version = 1')
    expect(git(b.workbench.path, 'rev-parse', 'HEAD')).toBe(b.baseCommit)
  })

  it('закрытых путей в копии физически нет', async () => {
    const b = await bench()
    expect(existsSync(join(b.workbench.path, 'secrets'))).toBe(false)
    expect(existsSync(join(b.workbench.path, '.env.production'))).toBe(false)
    expect(existsSync(join(b.workbench.path, 'src', 'app.ts'))).toBe(true)
  })

  it('повторное открытие той же копии (перезапуск врача) отдаёт её же', async () => {
    const b = await bench()
    writeFileSync(join(b.workbench.path, 'src', 'app.ts'), 'export const version = 99\n')
    const again = await createWorkbench({
      guard: b.guard,
      worktreesDir: b.worktreesDir,
      caseId: 7,
      slug: 'price-crash',
      baseCommit: b.baseCommit,
      closedPaths: ['secrets/**', '.env*'],
    })
    expect(again.path).toBe(b.workbench.path)
    expect(readFileSync(join(again.path, 'src', 'app.ts'), 'utf8')).toContain('99')
  })
})

describe('окружение выполнения верстака', () => {
  it('в окружении команды нет секретов врача', async () => {
    const b = await bench()
    process.env.DEEPSEEK_API_KEY = 'test-secret-should-not-leak'
    process.env.REMONTNIK_GIT_TOKEN = 'test-git-token-should-not-leak'
    try {
      const { result, output } = await run(envFor(b.workbench.path), 'env')
      expect(result.ok).toBe(true)
      expect(output).not.toContain('test-secret-should-not-leak')
      expect(output).not.toContain('test-git-token-should-not-leak')
      expect(output).toContain('PATH=')
    } finally {
      delete process.env.DEEPSEEK_API_KEY
      delete process.env.REMONTNIK_GIT_TOKEN
    }
  })

  it('команда, которая висит, обрывается по тайм-ауту', async () => {
    const b = await bench()
    const started = Date.now()
    const { result } = await run(envFor(b.workbench.path), 'sleep 20', 1)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('timeout')
    expect(Date.now() - started).toBeLessThan(5_000)
  })

  it('без указанного тайм-аута действует тайм-аут по умолчанию', async () => {
    const b = await bench()
    const { result } = await run(envFor(b.workbench.path, { defaultTimeoutSeconds: 1 }), 'sleep 20')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('timeout')
  })

  it('команды выполняются в копии и видят код', async () => {
    const b = await bench()
    const { result, output } = await run(envFor(b.workbench.path), 'cat src/app.ts; exit 3')
    expect(result.ok && result.value.exitCode).toBe(3)
    expect(output).toContain('version = 1')
  })

  it('файлы вне копии, в .git и по закрытым путям недоступны', async () => {
    const b = await bench()
    const env = envFor(b.workbench.path)
    for (const path of ['../main/secrets/key.txt', '/etc/hosts', '.git', 'secrets/key.txt', '.env.production']) {
      const result = await env.readTextFile(path, BACKGROUND_CONTEXT)
      expect(result.ok, path).toBe(false)
    }
    const write = await env.writeFile('secrets/new.txt', 'x', BACKGROUND_CONTEXT)
    expect(write.ok).toBe(false)
    const ok = await env.readTextFile('src/app.ts', BACKGROUND_CONTEXT)
    expect(ok.ok && ok.value).toContain('version = 1')
  })
})

describe('docker exec', () => {
  it('команда уходит в контейнер с рабочей папкой и только переданными переменными', () => {
    expect(
      dockerExecArgs({ container: 'remontnik-bench-7', workdir: '/work', env: { CI: '1' }, command: 'pnpm test' }),
    ).toEqual(['exec', '-i', '-w', '/work', '-e', 'CI=1', 'remontnik-bench-7', 'sh', '-c', 'pnpm test'])
  })
})
