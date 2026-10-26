import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createGitGuard } from '../git-guard/index.js'
import { bashCallPolicy } from '../treatment/tools.js'
import { ContainerExecutionEnv, createDockerRunner, createLocalRunner, createWorkbench, type CommandRunner } from './index.js'

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

function envFor(path: string, options: { defaultTimeoutSeconds?: number; runner?: CommandRunner } = {}) {
  return new ContainerExecutionEnv({
    root: path,
    runner: options.runner ?? createLocalRunner(),
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

describe('запись через символьные ссылки', () => {
  it('висячая ссылка наружу: запись не проходит, файл вне копии не появляется', async () => {
    const b = await bench()
    const outside = join(b.root, 'outside')
    mkdirSync(outside)
    symlinkSync(join(outside, 'authorized_keys'), join(b.workbench.path, 'src', 'keys'))
    const env = envFor(b.workbench.path)
    for (const write of [
      () => env.writeFile('src/keys', 'x', BACKGROUND_CONTEXT),
      () => env.appendFile('src/keys', 'x', BACKGROUND_CONTEXT),
    ]) {
      expect((await write()).ok).toBe(false)
    }
    expect(existsSync(join(outside, 'authorized_keys'))).toBe(false)
  })

  it('ссылка на папку внутри пути: запись не проходит даже внутрь копии', async () => {
    const b = await bench()
    symlinkSync(join(b.workbench.path, 'src'), join(b.workbench.path, 'alias'))
    const env = envFor(b.workbench.path)
    expect((await env.writeFile('alias/new.ts', 'x', BACKGROUND_CONTEXT)).ok).toBe(false)
    expect((await env.writeFile('src/new.ts', 'x', BACKGROUND_CONTEXT)).ok).toBe(true)
  })
})

describe('HOME команд', () => {
  it('у каждой копии свой HOME, у одной копии — один и тот же', async () => {
    const runner = createLocalRunner()
    const root = mkdtempSync(join(tmpdir(), 'remontnik-home-test-'))
    dirs.push(root)
    const home = async (copyDir: string) => {
      mkdirSync(copyDir, { recursive: true })
      const result = await runner.run('printf %s "$HOME"', { cwd: copyDir, copyDir, timeoutSeconds: 10 })
      return result.output
    }
    const model = await home(join(root, 'case-1'))
    const candidate = await home(join(root, 'case-1-candidate'))
    const base = await home(join(root, 'case-1-base'))
    expect(new Set([model, candidate, base]).size).toBe(3)
    expect(await home(join(root, 'case-1'))).toBe(model)
  })
})

/** Подставной `docker`: записывает аргументы и печатает их, ничего не запуская. `sleep` в команде — висит. */
function fakeDocker(root: string) {
  const log = join(root, 'docker.log')
  const docker = join(root, 'docker')
  writeFileSync(
    docker,
    `#!/bin/sh\nfor a in "$@"; do printf '%s\\n' "$a"; done >> '${log}'\nprintf '%s\\n' '--end--' >> '${log}'\ncase "$*" in *sleep*) sleep 30;; esac\nexit 0\n`,
    { mode: 0o755 },
  )
  const calls = () =>
    readFileSync(log, 'utf8')
      .split('--end--\n')
      .filter(Boolean)
      .map((call) => call.split('\n').filter((line) => line !== ''))
  return { docker, calls }
}

function mountSources(args: string[]): string[] {
  return args.flatMap((arg, index) => (args[index - 1] === '--mount' ? [/source=([^,]+)/.exec(arg)![1]!] : []))
}

describe('исполнитель в контейнере', () => {
  it('каждая команда — свой контейнер: смонтированы только копия и её HOME, окружение только переданное', async () => {
    const b = await bench()
    const fake = fakeDocker(b.root)
    const homesDir = join(b.root, 'homes')
    const runner = createDockerRunner({ image: 'example.test/app-dev:1', homesDir, docker: fake.docker })
    expect(runner.isolation).toBe('container')
    process.env.DEEPSEEK_API_KEY = 'test-secret-should-not-leak'
    try {
      const result = await runner.run('pnpm test', { cwd: join(b.workbench.path, 'src'), copyDir: b.workbench.path, env: { CI: '1' }, timeoutSeconds: 5 })
      expect(result.exitCode).toBe(0)
    } finally {
      delete process.env.DEEPSEEK_API_KEY
    }
    const [args] = fake.calls()
    expect(args!.slice(0, 2)).toEqual(['run', '--rm'])
    expect(args).toEqual(expect.arrayContaining(['--cap-drop', 'ALL', '--security-opt', 'no-new-privileges']))
    const sources = mountSources(args!)
    expect(sources).toHaveLength(2)
    expect(sources[0]).toBe(b.workbench.path)
    expect(sources[1]!.startsWith(homesDir)).toBe(true)
    expect(args!.join('\n')).not.toContain(b.repoDir + '/.git')
    expect(args!.join('\n')).not.toContain('test-secret-should-not-leak')
    expect(args!.slice(-4)).toEqual(['example.test/app-dev:1', 'sh', '-c', 'pnpm test'])
    expect(args![args!.indexOf('-w') + 1]).toBe(join(b.workbench.path, 'src'))
  })

  it('папка вне копии не монтируется: команда не запускается', async () => {
    const b = await bench()
    const fake = fakeDocker(b.root)
    const runner = createDockerRunner({ image: 'example.test/app-dev:1', homesDir: join(b.root, 'homes'), docker: fake.docker })
    const result = await runner.run('ls', { cwd: b.repoDir, copyDir: b.workbench.path, timeoutSeconds: 5 })
    expect(result.spawnError).toBeDefined()
  })

  it('по тайм-ауту контейнер убивается по имени', async () => {
    const b = await bench()
    const fake = fakeDocker(b.root)
    const runner = createDockerRunner({ image: 'example.test/app-dev:1', homesDir: join(b.root, 'homes'), docker: fake.docker })
    const started = Date.now()
    const result = await runner.run('sleep 100', { cwd: b.workbench.path, copyDir: b.workbench.path, timeoutSeconds: 1 })
    expect(result.timedOut).toBe(true)
    expect(Date.now() - started).toBeLessThan(10_000)
    await vi.waitFor(() => expect(fake.calls()).toHaveLength(2))
    const [run, kill] = fake.calls()
    const name = run![run!.indexOf('--name') + 1]
    expect(kill).toEqual(['kill', name])
  })

  it.each(['"git" push origin +main', '\\git log --all -p', 'g""it show HEAD', 'sh -c "g\\it status"', 'python3 -c "import subprocess; subprocess.run([\'git\', \'log\'])"'])(
    'обход запрета git в тексте (%s) упирается в контейнер: gitdir основного репозитория в нём нет',
    async (command) => {
      // Шаблон запрета — лишь второй слой: такие команды он пропускает. Держит контейнер.
      expect(bashCallPolicy({ command }, { defaultTimeoutSeconds: 5, maxTimeoutSeconds: 5 })).toHaveProperty('arguments')
      const b = await bench()
      const fake = fakeDocker(b.root)
      const env = envFor(b.workbench.path, { runner: createDockerRunner({ image: 'example.test/app-dev:1', homesDir: join(b.root, 'homes'), docker: fake.docker }) })
      await run(env, command)
      const [args] = fake.calls()
      for (const source of mountSources(args!)) {
        expect(source.startsWith(b.repoDir)).toBe(false)
      }
      expect(args![args!.length - 1]).toBe(command)
    },
  )
})
