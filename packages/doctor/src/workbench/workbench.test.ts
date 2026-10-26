import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createGitGuard } from '../git-guard/index.js'
import { bashCallPolicy } from '../treatment/tools.js'
import type { CaseNetworks } from '../case-networks/index.js'
import { CONTAINER_LIFETIME_MARGIN_SECONDS, ContainerExecutionEnv, createDockerRunner, createLocalRunner, createWorkbench, removeOrphanWorkbenches, type CommandRunner } from './index.js'

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

/**
 * Подставной `docker`: записывает аргументы, ничего не запуская. `create` запоминает команду и копирует себе
 * файл окружения (права и содержимое), `start` висит, если в команде есть `sleep`. Файл `kill-fails` —
 * контейнер не убивается: `kill` падает, `inspect` говорит, что он ещё идёт.
 */
function fakeDocker(root: string) {
  const log = join(root, 'docker.log')
  const envLog = join(root, 'env-file.log')
  const docker = join(root, 'docker')
  writeFileSync(
    docker,
    [
      '#!/bin/sh',
      `for a in "$@"; do printf '%s\\n' "$a"; done >> '${log}'`,
      `printf '%s\\n' '--end--' >> '${log}'`,
      'prev=""',
      `for a in "$@"; do if [ "$prev" = "--env-file" ]; then ls -l "$a" | cut -c1-10 >> '${envLog}'; cat "$a" >> '${envLog}'; fi; prev="$a"; done`,
      'case "$1" in',
      `  create) for a in "$@"; do last="$a"; done; printf '%s' "$last" > '${root}/last-command'; echo created;;`,
      `  start) case "$(cat '${root}/last-command')" in *sleep*) sleep 30;; esac;;`,
      `  kill) [ -e '${root}/kill-fails' ] && exit 1; sleep 0.3; touch '${root}/killed';;`,
      `  inspect) if [ -e '${root}/kill-fails' ]; then echo true; else echo 'Error: No such object' >&2; exit 1; fi;;`,
      'esac',
      'exit 0',
      '',
    ].join('\n'),
    { mode: 0o755 },
  )
  const calls = () =>
    readFileSync(log, 'utf8')
      .split('--end--\n')
      .filter(Boolean)
      .map((call) => call.split('\n').filter((line) => line !== ''))
  const envFile = () => (existsSync(envLog) ? readFileSync(envLog, 'utf8') : '')
  return { docker, calls, envFile, killFails: () => writeFileSync(join(root, 'kill-fails'), ''), killed: () => existsSync(join(root, 'killed')) }
}

function mountSources(args: string[]): string[] {
  return args.flatMap((arg, index) => (args[index - 1] === '--mount' ? [/source=([^,]+)/.exec(arg)![1]!] : []))
}

function flagValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag)
  return index < 0 ? undefined : args[index + 1]
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
    const [args, start] = fake.calls()
    expect(args!.slice(0, 2)).toEqual(['create', '--rm'])
    expect(args).toEqual(expect.arrayContaining(['--cap-drop', 'ALL', '--security-opt', 'no-new-privileges']))
    const sources = mountSources(args!)
    expect(sources).toHaveLength(2)
    expect(sources[0]).toBe(b.workbench.path)
    expect(sources[1]!.startsWith(homesDir)).toBe(true)
    expect(args!.join('\n')).not.toContain(b.repoDir + '/.git')
    expect(args!.join('\n')).not.toContain('test-secret-should-not-leak')
    expect(fake.envFile()).not.toContain('test-secret-should-not-leak')
    expect(args!.slice(-7, -1)).toEqual(['example.test/app-dev:1', 'sh', '-c', expect.stringContaining('kill -KILL -1'), 'remontnik', String(5 + CONTAINER_LIFETIME_MARGIN_SECONDS)])
    expect(args!.at(-1)).toBe('pnpm test')
    expect(args![args!.indexOf('-w') + 1]).toBe(join(b.workbench.path, 'src'))
    expect(start).toEqual(['start', '--attach', flagValue(args!, '--name')])
  })

  it('контейнер ограничен: память, процессор, корневая система только для чтения, запись — копия, HOME и /tmp', async () => {
    const b = await bench()
    const fake = fakeDocker(b.root)
    const runner = createDockerRunner({ image: 'example.test/app-dev:1', homesDir: join(b.root, 'homes'), docker: fake.docker, memory: '3g', cpus: '1.5' })
    const outDir = join(b.root, 'eval-out')
    mkdirSync(outDir)
    await runner.run('pnpm eval', { cwd: b.workbench.path, copyDir: b.workbench.path, writableDirs: [outDir], timeoutSeconds: 5 })
    const [args] = fake.calls()
    expect(flagValue(args!, '--memory')).toBe('3g')
    expect(flagValue(args!, '--memory-swap')).toBe('3g')
    expect(flagValue(args!, '--cpus')).toBe('1.5')
    expect(args).toContain('--read-only')
    expect(flagValue(args!, '--tmpfs')).toMatch(/^\/tmp:/)
    expect(mountSources(args!)).toEqual([b.workbench.path, expect.stringContaining(join(b.root, 'homes')), outDir])
  })

  /** Подставные сети случая: выдают сеть по копии и виду, считают незакрытые аренды. */
  function fakeCaseNetworks(fail?: string) {
    const uses: string[] = []
    let open = 0
    const networks: CaseNetworks = {
      async use(copyDir, kind) {
        uses.push(`${kind} ${copyDir}`)
        if (fail) throw new Error(fail)
        open += 1
        const network = { id: `${kind}-id`, name: `remontnik-case-${kind}`, kind, gatewayIp: kind === 'workbench' ? '10.213.0.2' : '10.213.0.34' }
        return { network, done: () => void (open -= 1) }
      },
      removeStale: async () => {},
      close: async () => {},
    }
    return { networks, uses, open: () => open }
  }

  it('сети случая: установка — в сети верстака, проверки — в сети проверок; сеть по ID, врач — по имени remontnik-gateway', async () => {
    const b = await bench()
    const fake = fakeDocker(b.root)
    const caseNetworks = fakeCaseNetworks()
    const runner = createDockerRunner({ image: 'example.test/app-dev:1', homesDir: join(b.root, 'homes'), docker: fake.docker, caseNetworks: caseNetworks.networks })
    await runner.run('pnpm install', { cwd: b.workbench.path, copyDir: b.workbench.path, timeoutSeconds: 5 })
    await runner.run('pnpm test', { cwd: b.workbench.path, copyDir: b.workbench.path, timeoutSeconds: 5, network: 'internal' })
    expect(caseNetworks.uses).toEqual([`workbench ${b.workbench.path}`, `checks ${b.workbench.path}`])
    const creates = fake.calls().filter((call) => call[0] === 'create')
    expect(creates.map((args) => flagValue(args, '--network'))).toEqual(['workbench-id', 'checks-id'])
    expect(creates.map((args) => flagValue(args, '--add-host'))).toEqual(['remontnik-gateway:10.213.0.2', 'remontnik-gateway:10.213.0.34'])
    expect(caseNetworks.open()).toBe(0)
  })

  it('сеть не задана → у контейнера нет сети совсем', async () => {
    const b = await bench()
    const fake = fakeDocker(b.root)
    const runner = createDockerRunner({ image: 'example.test/app-dev:1', homesDir: join(b.root, 'homes'), docker: fake.docker })
    await runner.run('pnpm install', { cwd: b.workbench.path, copyDir: b.workbench.path, timeoutSeconds: 5 })
    expect(flagValue(fake.calls()[0]!, '--network')).toBe('none')
  })

  it('адрес зеркала реестра — только командам в сети верстака, не проверкам; модель его не подменит', async () => {
    const b = await bench()
    const fake = fakeDocker(b.root)
    const runner = createDockerRunner({
      image: 'example.test/app-dev:1',
      homesDir: join(b.root, 'homes'),
      docker: fake.docker,
      caseNetworks: fakeCaseNetworks().networks,
      workbenchEnv: { npm_config_registry: 'http://remontnik-gateway:7801/' },
    })
    await runner.run('pnpm install', { cwd: b.workbench.path, copyDir: b.workbench.path, env: { npm_config_registry: 'http://model.example.com/' }, timeoutSeconds: 5 })
    await runner.run('pnpm test', { cwd: b.workbench.path, copyDir: b.workbench.path, timeoutSeconds: 5, network: 'internal' })
    const [install, tests] = fake.envFile().split(/^-rw-------/m).filter(Boolean)
    expect(install).toContain('npm_config_registry=http://remontnik-gateway:7801/\n')
    expect(install).not.toContain('model.example.com')
    expect(tests).not.toContain('npm_config_registry')
  })

  it('сеть случая не прошла сверку → команда не запускается', async () => {
    const b = await bench()
    const fake = fakeDocker(b.root)
    const runner = createDockerRunner({ image: 'example.test/app-dev:1', homesDir: join(b.root, 'homes'), docker: fake.docker, caseNetworks: fakeCaseNetworks('сеть случая не закрыта').networks })
    const result = await runner.run('pnpm test', { cwd: b.workbench.path, copyDir: b.workbench.path, timeoutSeconds: 5, network: 'internal' })
    expect(result.exitCode).toBeNull()
    expect(result.spawnError).toContain('не закрыта')
    expect(existsSync(join(b.root, 'docker.log'))).toBe(false)
  })

  it('сетей случая нет → проверки не запускаются', async () => {
    const b = await bench()
    const fake = fakeDocker(b.root)
    const runner = createDockerRunner({ image: 'example.test/app-dev:1', homesDir: join(b.root, 'homes'), docker: fake.docker })
    const result = await runner.run('pnpm test', { cwd: b.workbench.path, copyDir: b.workbench.path, timeoutSeconds: 5, network: 'internal' })
    expect(result.exitCode).toBeNull()
    expect(result.spawnError).toContain('сет')
    expect(existsSync(join(b.root, 'docker.log'))).toBe(false)
  })

  it('по умолчанию лимиты тоже есть', async () => {
    const b = await bench()
    const fake = fakeDocker(b.root)
    const runner = createDockerRunner({ image: 'example.test/app-dev:1', homesDir: join(b.root, 'homes'), docker: fake.docker })
    await runner.run('ls', { cwd: b.workbench.path, copyDir: b.workbench.path, timeoutSeconds: 5 })
    const [args] = fake.calls()
    expect(flagValue(args!, '--memory')).toBeDefined()
    expect(flagValue(args!, '--cpus')).toBeDefined()
  })

  it('переменные — файлом 0600, который удаляется сразу после создания контейнера; в аргументах значений нет', async () => {
    const b = await bench()
    const fake = fakeDocker(b.root)
    const runner = createDockerRunner({ image: 'example.test/app-dev:1', homesDir: join(b.root, 'homes'), docker: fake.docker })
    await runner.run('pnpm eval', { cwd: b.workbench.path, copyDir: b.workbench.path, env: { RUN_TOKEN: 'run-token-example' }, timeoutSeconds: 5 })
    const [args] = fake.calls()
    expect(args).not.toContain('-e')
    expect(args!.join('\n')).not.toContain('run-token-example')
    const envFile = flagValue(args!, '--env-file')!
    expect(fake.envFile()).toContain('-rw-------')
    expect(fake.envFile()).toContain('RUN_TOKEN=run-token-example')
    expect(fake.envFile()).toContain('HOME=/home/remontnik')
    expect(existsSync(envFile)).toBe(false)
  })

  it('перевод строки в значении переменной — отказ: файл окружения его не передаст', async () => {
    const b = await bench()
    const fake = fakeDocker(b.root)
    const runner = createDockerRunner({ image: 'example.test/app-dev:1', homesDir: join(b.root, 'homes'), docker: fake.docker })
    const result = await runner.run('ls', { cwd: b.workbench.path, copyDir: b.workbench.path, env: { X: 'a\nB=1' }, timeoutSeconds: 5 })
    expect(result.spawnError).toBeDefined()
    expect(existsSync(join(b.root, 'docker.log'))).toBe(false)
  })

  it('папка вне копии не монтируется: команда не запускается', async () => {
    const b = await bench()
    const fake = fakeDocker(b.root)
    const runner = createDockerRunner({ image: 'example.test/app-dev:1', homesDir: join(b.root, 'homes'), docker: fake.docker })
    const result = await runner.run('ls', { cwd: b.repoDir, copyDir: b.workbench.path, timeoutSeconds: 5 })
    expect(result.spawnError).toBeDefined()
  })

  it('по тайм-ауту контейнер убивается по имени, и итог приходит только после docker kill', async () => {
    const b = await bench()
    const fake = fakeDocker(b.root)
    const runner = createDockerRunner({ image: 'example.test/app-dev:1', homesDir: join(b.root, 'homes'), docker: fake.docker })
    const started = Date.now()
    const result = await runner.run('sleep 100', { cwd: b.workbench.path, copyDir: b.workbench.path, timeoutSeconds: 1 })
    expect(result.timedOut).toBe(true)
    expect(result.stillRunning).toBeFalsy()
    expect(fake.killed()).toBe(true)
    expect(Date.now() - started).toBeLessThan(10_000)
    const [create, , kill] = fake.calls()
    expect(kill).toEqual(['kill', flagValue(create!, '--name')])
    expect(runner.spoiled(b.workbench.path)).toBe(false)
  })

  it('контейнер не убился → итог «ещё идёт», копия испорчена: новых команд в ней нет', async () => {
    const b = await bench()
    const fake = fakeDocker(b.root)
    fake.killFails()
    const runner = createDockerRunner({ image: 'example.test/app-dev:1', homesDir: join(b.root, 'homes'), docker: fake.docker })
    const result = await runner.run('sleep 100', { cwd: b.workbench.path, copyDir: b.workbench.path, timeoutSeconds: 1 })
    expect(result.stillRunning).toBe(true)
    expect(runner.spoiled(b.workbench.path)).toBe(true)
    const calls = fake.calls().length
    const next = await runner.run('ls', { cwd: b.workbench.path, copyDir: b.workbench.path, timeoutSeconds: 5 })
    expect(next.spawnError).toMatch(/испорчена/)
    expect(fake.calls()).toHaveLength(calls)
    // Отметка переживает перезапуск врача: новый исполнитель над той же папкой HOME видит её же.
    const again = createDockerRunner({ image: 'example.test/app-dev:1', homesDir: join(b.root, 'homes'), docker: fake.docker })
    expect(again.spoiled(b.workbench.path)).toBe(true)
  })

  it('команда модели в испорченной копии — ошибка с объяснением', async () => {
    const b = await bench()
    const fake = fakeDocker(b.root)
    fake.killFails()
    const env = envFor(b.workbench.path, { runner: createDockerRunner({ image: 'example.test/app-dev:1', homesDir: join(b.root, 'homes'), docker: fake.docker }) })
    const result = await env.exec('sleep 100', { timeout: 1 }, BACKGROUND_CONTEXT)
    expect(result.ok).toBe(false)
    expect(!result.ok && result.error.message).toMatch(/не остановлен/)
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

describe('контейнеры верстака после падения врача', () => {
  it('у контейнера свой срок жизни: врач упал — команда внутри всё равно умрёт чуть позже своего тайм-аута', async () => {
    const b = await bench()
    const fake = fakeDocker(b.root)
    const runner = createDockerRunner({ image: 'example.test/app-dev:1', homesDir: join(b.root, 'homes'), docker: fake.docker })
    await runner.run('pnpm test', { cwd: b.workbench.path, copyDir: b.workbench.path, timeoutSeconds: 40 })
    const [args] = fake.calls()
    const wrapper = args![args!.indexOf('-c') + 1]!
    expect(args!.slice(args!.indexOf('-c') + 2)).toEqual(['remontnik', String(40 + CONTAINER_LIFETIME_MARGIN_SECONDS), 'pnpm test'])
    // Обёртка — первый процесс контейнера: по сроку убивает все остальные, и контейнер кончается.
    expect(wrapper).toContain('date +%s')
    expect(wrapper).toContain('kill -KILL -1')
  })

  /** Подставной docker со «старыми» контейнерами верстака: `ps` их выдаёт, `rm` записывает; `stuck` не удаляются. */
  function orphanDocker(root: string, rows: string[], stuck: string[] = []) {
    const log = join(root, 'orphan-docker.log')
    const docker = join(root, 'orphan-docker')
    const stuckCases = stuck.map((id) => `  "rm -f ${id}") echo 'Error response from daemon: could not kill' >&2; exit 1;;`)
    writeFileSync(
      docker,
      ['#!/bin/sh', `echo "$*" >> '${log}'`, 'case "$*" in', ...stuckCases, 'esac', 'case "$1" in', `  ps) printf '%s\n' ${rows.map((row) => `'${row}'`).join(' ')};;`, 'esac', 'exit 0', ''].join('\n'),
      { mode: 0o755 },
    )
    return { docker, calls: () => (existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean) : []) }
  }

  it('на старте врача контейнеры с меткой верстака удаляются: оборванная команда копию не портит, лечение продолжается в ней', async () => {
    const b = await bench()
    const homesDir = join(b.root, 'homes')
    // Метку копии ставит сам исполнитель: берём её из настоящего `docker create`.
    const fake = fakeDocker(b.root)
    await createDockerRunner({ image: 'example.test/app-dev:1', homesDir, docker: fake.docker }).run('ls', { cwd: b.workbench.path, copyDir: b.workbench.path, timeoutSeconds: 5 })
    const label = fake.calls()[0]!.find((arg) => arg.startsWith('remontnik.copy='))!
    const copy = label.slice('remontnik.copy='.length)
    const other = '0123456789abcdef'
    const orphans = orphanDocker(b.root, [`aaa running ${copy}`, `bbb created ${other}`])
    const removed = await removeOrphanWorkbenches({ homesDir, docker: orphans.docker })
    expect(orphans.calls()[0]).toBe('ps -a --filter label=remontnik.workbench=1 --format {{.ID}} {{.State}} {{.Label "remontnik.copy"}}')
    expect(orphans.calls()).toEqual(expect.arrayContaining(['rm -f aaa', 'rm -f bbb']))
    expect(removed).toEqual(['aaa', 'bbb'])
    // Контейнера больше нет — команда в копии мертва: модель увидит её прерванной и продолжит в той же копии.
    const runner = createDockerRunner({ image: 'example.test/app-dev:1', homesDir, docker: fake.docker })
    expect(runner.spoiled(b.workbench.path)).toBe(false)
    expect(existsSync(join(homesDir, `${other}.spoiled`))).toBe(false)
  })

  it('старый контейнер с идущей командой не удалился → его копия испорчена: команда, возможно, ещё пишет в неё', async () => {
    const b = await bench()
    const homesDir = join(b.root, 'homes')
    const fake = fakeDocker(b.root)
    await createDockerRunner({ image: 'example.test/app-dev:1', homesDir, docker: fake.docker }).run('ls', { cwd: b.workbench.path, copyDir: b.workbench.path, timeoutSeconds: 5 })
    const copy = fake.calls()[0]!.find((arg) => arg.startsWith('remontnik.copy='))!.slice('remontnik.copy='.length)
    const lines: string[] = []
    const orphans = orphanDocker(b.root, [`aaa running ${copy}`], ['aaa'])
    expect(await removeOrphanWorkbenches({ homesDir, docker: orphans.docker, log: (line) => lines.push(line) })).toEqual([])
    expect(createDockerRunner({ image: 'example.test/app-dev:1', homesDir, docker: fake.docker }).spoiled(b.workbench.path)).toBe(true)
    expect(lines.join('\n')).toContain('aaa')
  })

  it('старых контейнеров нет — ничего не удаляется', async () => {
    const b = await bench()
    const orphans = orphanDocker(b.root, [])
    expect(await removeOrphanWorkbenches({ homesDir: join(b.root, 'homes'), docker: orphans.docker })).toEqual([])
    expect(orphans.calls()).toHaveLength(1)
  })
})
