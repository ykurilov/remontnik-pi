import { spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// Заготовки для тестов своего хранилища: настоящий bare-репозиторий с хуком из deploy/ и подставной ssh,
// который, как git-shell на сервере, запускает git-receive-pack или git-upload-pack локально.

export const HOOK = fileURLToPath(new URL('../../../deploy/git-update-hook', import.meta.url))
export const asRoot = process.getuid?.() === 0

/** Закрытый ключ для тестов: не настоящий, собран по частям, чтобы проверка открытости репозитория не путала его с ключом. */
export const TEST_SSH_KEY = ['-----BEGIN ', 'OPENSSH PRIVATE KEY-----\n', 'b3BlbnNzaC1rZXktdjEAAAAA\n', '-----END ', 'OPENSSH PRIVATE KEY-----'].join('')

const dirs: string[] = []

/** Вызывать в afterEach: хранилища закрыты от записи, сначала права, потом удаление. */
export function removeGitStorageFixtures(): void {
  for (const dir of dirs.splice(0)) {
    spawnSync('chmod', ['-R', 'u+w', dir])
    rmSync(dir, { recursive: true, force: true })
  }
}

export function fixtureDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'remontnik-git-storage-'))
  dirs.push(dir)
  return dir
}

export const GIT_ENV = { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' }

export function git(cwd: string, args: string[], env: Record<string, string> = {}): { ok: boolean; out: string } {
  const result = spawnSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false', ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...GIT_ENV, ...env },
  })
  return { ok: result.status === 0, out: `${result.stdout}${result.stderr}` }
}

export function mustGit(cwd: string, args: string[], env: Record<string, string> = {}): string {
  const result = git(cwd, args, env)
  if (!result.ok) throw new Error(result.out)
  return result.out.trim()
}

export interface StorageOptions {
  hook?: boolean
  denyNonFastForwards?: boolean
  denyDeletes?: boolean
  /** Закрыть хук, config, HEAD и само хранилище от записи, как у root-владельца на сервере. */
  locked?: boolean
  /** Репозиторий с main хотя бы из двух коммитов: он и станет клоном человека. Нет — свой клон с двумя коммитами. */
  source?: string
}

export interface Storage {
  root: string
  bare: string
  home: string
  clone: string
  refs: () => string
}

/** Хранилище с main и меткой врача remontnik/pre-deploy/one; клон человека — рядом или `source`. */
export function storage(options: StorageOptions = {}): Storage {
  const root = fixtureDir()
  const bare = join(root, 'app.git')
  const home = join(root, 'home')
  mkdirSync(home)
  mustGit(root, ['init', '--quiet', '--bare', '--initial-branch=main', bare])
  let clone = options.source
  if (!clone) {
    clone = join(root, 'clone')
    mustGit(root, ['clone', '--quiet', bare, clone])
    writeFileSync(join(clone, 'app.txt'), 'один\n')
    mustGit(clone, ['add', '-A'])
    mustGit(clone, ['commit', '--quiet', '-m', 'первый'])
    writeFileSync(join(clone, 'app.txt'), 'два\n')
    mustGit(clone, ['commit', '--quiet', '-am', 'второй'])
  }
  mustGit(clone, ['tag', 'remontnik/pre-deploy/one'])
  mustGit(clone, ['push', '--quiet', bare, 'main', 'refs/tags/remontnik/pre-deploy/one'])
  if (options.denyNonFastForwards ?? true) mustGit(bare, ['config', 'receive.denyNonFastForwards', 'true'])
  if (options.denyDeletes ?? true) mustGit(bare, ['config', 'receive.denyDeletes', 'true'])
  mkdirSync(join(bare, 'hooks'), { recursive: true })
  if (options.hook ?? true) {
    copyFileSync(HOOK, join(bare, 'hooks', 'update'))
    chmodSync(join(bare, 'hooks', 'update'), 0o755)
  }
  if (options.locked) {
    chmodSync(join(bare, 'config'), 0o444)
    chmodSync(join(bare, 'HEAD'), 0o444)
    if (options.hook ?? true) chmodSync(join(bare, 'hooks', 'update'), 0o555)
    chmodSync(join(bare, 'hooks'), 0o555)
    chmodSync(bare, 0o555)
    chmodSync(home, 0o555)
  }
  const refs = () => mustGit(bare, ['for-each-ref', '--format=%(refname) %(objectname)'])
  return { root, bare, home, clone, refs }
}

/** Push человека или врача прямо в хранилище: локальный receive-pack с тем же хуком. */
export function push(clone: string, bare: string, refspecs: string[], role?: 'doctor') {
  return git(clone, ['push', '--porcelain', bare, ...refspecs], role ? { REMONTNIK_GIT_ROLE: role } : {})
}

export interface FakeSsh {
  ssh: string
  /** Аргументы каждого вызова и ключ, который ssh нашёл по `-i`. */
  calls: () => Array<{ args: string[]; key?: string }>
}

/**
 * Подставной ssh: как git-shell на сервере, запускает git-receive-pack или git-upload-pack из команды.
 * `role` — что поставила бы принудительная команда ключа врача; `failure` — текст ssh, который не дошёл до сервера.
 */
export function fakeSsh(options: { home: string; role?: 'doctor'; failure?: string }): FakeSsh {
  const dir = fixtureDir()
  const log = join(dir, 'calls.jsonl')
  const file = join(dir, 'ssh')
  writeFileSync(
    file,
    `#!/usr/bin/env node
const fs = require('node:fs')
const { spawnSync } = require('node:child_process')
const args = process.argv.slice(2)
const keyAt = args.indexOf('-i')
let key
try { key = keyAt === -1 ? undefined : fs.readFileSync(args[keyAt + 1], 'utf8') } catch {}
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args, key }) + '\\n')
const failure = ${JSON.stringify(options.failure ?? null)}
if (failure) { process.stderr.write(failure + '\\n'); process.exit(255) }
const match = /^git-(receive-pack|upload-pack) '(.*)'$/.exec(args.at(-1))
if (!match) { process.stderr.write("fatal: unrecognized command '" + args.at(-1) + "'\\n"); process.exit(128) }
const env = { ...process.env, HOME: ${JSON.stringify(options.home)}, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' }
delete env.REMONTNIK_GIT_ROLE
${options.role ? `env.REMONTNIK_GIT_ROLE = ${JSON.stringify(options.role)}` : ''}
const result = spawnSync('git', [match[1], match[2]], { stdio: 'inherit', env })
process.exit(result.status === null ? 1 : result.status)
`,
    { mode: 0o755 },
  )
  return {
    ssh: file,
    calls: () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line)) : []),
  }
}
