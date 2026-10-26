import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { testRemontnikConfig } from '../testing/config.js'
import { CONFIG_READ_LABEL, configReadDockerArgs, containerConfigReader } from './config-reader.js'
import { loadMainBranchConfig } from './config-source.js'

// Чтение настройки в контейнере: чего нет в аргументах `docker run`, того у кода настройки нет.
// Живая проверка с настоящим Docker — `test/live/config-reader.live.test.ts`.

describe('configReadDockerArgs: контейнер для кода настройки', () => {
  const args = configReadDockerArgs({
    name: 'remontnik-config-test',
    image: 'sha256:doctor-image',
    copyDir: '/state/config-read/config-abc',
    user: '10001:10001',
    env: { REMONTNIK_RESULT_MARKER: '@@m@@' },
    args: ['--input-type=module', '-e', 'code'],
  })
  const valueOf = (flag: string) => args[args.indexOf(flag) + 1]

  it('без сети, без прав, с корнем только для чтения и пределами', () => {
    expect(valueOf('--network')).toBe('none')
    expect(valueOf('--cap-drop')).toBe('ALL')
    expect(valueOf('--security-opt')).toBe('no-new-privileges')
    expect(valueOf('--user')).toBe('10001:10001')
    expect(args).toContain('--read-only')
    expect(args).toContain('--rm')
    expect(valueOf('--label')).toBe(`${CONFIG_READ_LABEL}=1`)
    expect(valueOf('--pids-limit')).toBe('64')
    expect(valueOf('--memory')).toBe('512m')
  })

  it('единственная папка — копия файлов настройки, только для чтения; ни сокета Docker, ни окружения врача', () => {
    expect(args.filter((arg) => arg === '--mount')).toHaveLength(1)
    expect(valueOf('--mount')).toBe('type=bind,source=/state/config-read/config-abc,target=/state/config-read/config-abc,readonly')
    expect(args).not.toContain('-v')
    expect(args).not.toContain('--volume')
    expect(args).not.toContain('--volumes-from')
    expect(args).not.toContain('--privileged')
    expect(args.join(' ')).not.toContain('docker.sock')
    expect(args.filter((arg, index) => args[index - 1] === '--env')).toEqual(['REMONTNIK_RESULT_MARKER=@@m@@'])
    expect(args).not.toContain('--env-file')
    expect(args.slice(args.indexOf('--entrypoint'), args.indexOf('sha256:doctor-image') + 4)).toEqual([
      '--entrypoint',
      'node',
      'sha256:doctor-image',
      '--input-type=module',
      '-e',
      'code',
    ])
  })

  it('путь с запятой не монтируется: запятая разделяет поля --mount', () => {
    expect(() => configReadDockerArgs({ name: 'n', image: 'i', copyDir: '/state/a,readonly=false', env: {}, args: [] })).toThrow(/запятой/)
  })
})

/**
 * Подставной docker: `inspect` отдаёт образ, `run` выполняет `node` с аргументами после образа в папке `-w` только с
 * переменными из `--env`, `rm -f` пишет в журнал. Все вызовы — в `calls.jsonl`.
 */
function fakeDocker(dir: string): string {
  const file = join(dir, 'docker')
  writeFileSync(
    file,
    `#!/usr/bin/env node
const { appendFileSync } = require('node:fs')
const { spawnSync } = require('node:child_process')
const a = process.argv.slice(2)
appendFileSync(${JSON.stringify(join(dir, 'calls.jsonl'))}, JSON.stringify(a) + '\\n')
if (a[0] === 'inspect') { process.stdout.write('sha256:doctor-image\\n'); process.exit(0) }
if (a[0] === 'rm') process.exit(0)
if (a[0] === 'run') {
  const image = a.indexOf('sha256:doctor-image')
  const env = { PATH: process.env.PATH }
  a.forEach((arg, i) => { if (a[i - 1] === '--env') { const at = arg.indexOf('='); env[arg.slice(0, at)] = arg.slice(at + 1) } })
  const result = spawnSync(process.execPath, a.slice(image + 1), { cwd: a[a.indexOf('-w') + 1], env, encoding: 'utf8' })
  process.stdout.write(result.stdout)
  process.stderr.write(result.stderr)
  process.exit(result.status ?? 1)
}
process.exit(1)
`,
    { mode: 0o755 },
  )
  return file
}

describe('containerConfigReader: чтение настройки через docker', () => {
  let root: string
  let repoDir: string
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'remontnik-config-reader-'))
    repoDir = join(root, 'app')
    mkdirSync(repoDir)
    execFileSync('git', ['init', '--quiet', '--initial-branch=main'], { cwd: repoDir })
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  function commitConfig(text: string) {
    writeFileSync(join(repoDir, 'remontnik.config.mjs'), text)
    execFileSync('git', ['add', '-A'], { cwd: repoDir })
    execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'настройка'], { cwd: repoDir })
  }
  const calls = () =>
    readFileSync(join(root, 'calls.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as string[])

  it('образ — от контейнера врача; копия видна по тому же пути и удаляется после чтения', async () => {
    commitConfig(`export default ${JSON.stringify(testRemontnikConfig())}\n`)
    const reader = containerConfigReader({ gatewayContainer: 'remontnik-doctor', scratchDir: join(root, 'state', 'config-read'), docker: fakeDocker(root) })

    const first = await loadMainBranchConfig({ mainCheckoutDirectory: repoDir, mainBranch: 'main', reader })
    await loadMainBranchConfig({ mainCheckoutDirectory: repoDir, mainBranch: 'main', reader })

    expect(first.config.app.name).toBe(testRemontnikConfig().app.name)
    const [inspect, run, again] = calls()
    expect(inspect).toEqual(['inspect', '--format', '{{.Image}}', 'remontnik-doctor'])
    expect(run![0]).toBe('run')
    expect(run).toContain('sha256:doctor-image')
    expect(run![run!.indexOf('--mount') + 1]).toMatch(/^type=bind,source=.*\/state\/config-read\/config-[^,]+,target=.*,readonly$/)
    expect(again![0]).toBe('run')
    expect(calls()).toHaveLength(3)
    expect(readdirSync(join(root, 'state', 'config-read'))).toEqual([])
  })

  it('чтение упало — контейнер удаляется по имени, ошибка настройки понятна', async () => {
    commitConfig(`throw new Error('сломанная настройка')\n`)
    const reader = containerConfigReader({ gatewayContainer: 'remontnik-doctor', scratchDir: join(root, 'state', 'config-read'), docker: fakeDocker(root) })

    const failure = await loadMainBranchConfig({ mainCheckoutDirectory: repoDir, mainBranch: 'main', reader }).catch((error: unknown) => error)

    expect(failure).toMatchObject({ code: 'unreadable' })
    expect((failure as Error).message).toContain('сломанная настройка')
    const run = calls().find((call) => call[0] === 'run')!
    const name = run[run.indexOf('--name') + 1]!
    expect(name).toMatch(/^remontnik-config-[0-9a-f]{12}$/)
    expect(calls().at(-1)).toEqual(['rm', '-f', name])
  })
})
