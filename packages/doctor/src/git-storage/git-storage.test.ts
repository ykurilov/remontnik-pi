import { execFileSync } from 'node:child_process'
import { readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { asRoot, fakeSsh, fixtureDir as tempDir, GIT_ENV, mustGit, push, removeGitStorageFixtures, storage, TEST_SSH_KEY as PEM, type FakeSsh, type Storage } from '../../test/git-storage-fixtures.js'
import { createGitGuard } from '../git-guard/index.js'
import { decodeSshKey, gitSshAccess, parseSshRemote, probeGitStorage, writeGitSshFiles } from './index.js'

// Своё хранилище: хук update из deploy/, настройки receive.* и пробы check-config против настоящего bare-репозитория.
// ssh подставной: он запускает git-receive-pack локально, как git-shell на сервере, с ролью врача или без.

vi.setConfig({ testTimeout: 30_000 })

afterEach(removeGitStorageFixtures)

function probe(store: Storage, ssh: FakeSsh) {
  return probeGitStorage({
    remote: { user: 'git', host: 'storage.invalid', path: store.bare },
    sshOptions: ['-o', 'BatchMode=yes'],
    mainBranch: 'main',
    olderCommit: async (head) => mustGit(store.clone, ['rev-parse', `${head}^`]),
    ssh: ssh.ssh,
  })
}

describe('хук update и настройки хранилища', () => {
  it('push вперёд проходит; перезапись и удаление ветки, перезапись и удаление метки remontnik/** — отказ', () => {
    const store = storage()
    writeFileSync(join(store.clone, 'app.txt'), 'три\n')
    mustGit(store.clone, ['commit', '--quiet', '-am', 'третий'])
    expect(push(store.clone, store.bare, ['main']).ok).toBe(true)

    mustGit(store.clone, ['reset', '--quiet', '--hard', 'HEAD~2'])
    const rewrite = push(store.clone, store.bare, ['+main'])
    expect(rewrite.ok).toBe(false)
    expect(rewrite.out).toMatch(/non-fast-forward/)

    expect(push(store.clone, store.bare, ['HEAD:refs/heads/feature']).ok).toBe(true)
    const removal = push(store.clone, store.bare, [':refs/heads/feature'])
    expect(removal.ok).toBe(false)
    expect(removal.out).toMatch(/deletion prohibited|denying ref deletion/)

    mustGit(store.clone, ['tag', '-f', 'remontnik/pre-deploy/one', 'HEAD'])
    const moved = push(store.clone, store.bare, ['+refs/tags/remontnik/pre-deploy/one'])
    expect(moved.ok).toBe(false)
    expect(moved.out).toMatch(/remontnik-guard: отказ tag-immutable/)
    const tagRemoval = push(store.clone, store.bare, [':refs/tags/remontnik/pre-deploy/one'])
    expect(tagRemoval.ok).toBe(false)
    expect(tagRemoval.out).toMatch(/remontnik-guard: отказ tag-immutable/)

    mustGit(store.clone, ['tag', 'remontnik/pre-deploy/two'])
    expect(push(store.clone, store.bare, ['refs/tags/remontnik/pre-deploy/two']).ok).toBe(true)
  })

  it('без receive.denyNonFastForwards и receive.denyDeletes хук сам не даёт перезаписать и удалить ветку', () => {
    const store = storage({ denyNonFastForwards: false, denyDeletes: false })
    expect(push(store.clone, store.bare, ['HEAD:refs/heads/feature']).ok).toBe(true)
    const before = store.refs()
    mustGit(store.clone, ['reset', '--quiet', '--hard', 'HEAD~1'])
    expect(push(store.clone, store.bare, ['+main']).out).toMatch(/remontnik-guard: отказ non-fast-forward/)
    expect(push(store.clone, store.bare, [':refs/heads/feature']).out).toMatch(/remontnik-guard: отказ delete/)
    expect(store.refs()).toBe(before)
  })

  it('ключ врача пишет в основную ветку и ссылки remontnik/**, в чужую ветку — отказ; человеку чужая ветка можно', () => {
    const store = storage()
    writeFileSync(join(store.clone, 'app.txt'), 'правка врача\n')
    mustGit(store.clone, ['commit', '--quiet', '-am', 'правка'])
    expect(push(store.clone, store.bare, ['HEAD:refs/heads/remontnik/7-fix'], 'doctor').ok).toBe(true)
    mustGit(store.clone, ['tag', 'remontnik/pre-deploy/7'])
    expect(push(store.clone, store.bare, ['refs/tags/remontnik/pre-deploy/7'], 'doctor').ok).toBe(true)
    expect(push(store.clone, store.bare, ['main'], 'doctor').ok).toBe(true)

    const foreign = push(store.clone, store.bare, ['HEAD:refs/heads/feature'], 'doctor')
    expect(foreign.ok).toBe(false)
    expect(foreign.out).toMatch(/remontnik-guard: отказ doctor-ref/)
    expect(push(store.clone, store.bare, ['HEAD:refs/heads/feature']).ok).toBe(true)
  })
})

describe('пробы check-config', () => {
  it.skipIf(asRoot)('исправное хранилище: git сам отклоняет перезапись и удаление, хук — метки и чужую ветку врача; записи нет', async () => {
    const store = storage({ locked: true })
    const before = store.refs()
    const result = await probe(store, fakeSsh({ home: store.home, forced: ['doctor', store.bare] }))
    expect(result.failure).toBeUndefined()
    expect(result.status).toEqual({ version: 1, writable: [] })
    expect(result.outcomes).toEqual({
      status: { kind: 'hook', code: 'probe' },
      nonFastForward: { kind: 'git', reason: 'non-fast-forward' },
      deleteBranch: { kind: 'git', reason: 'deletion prohibited' },
      moveTag: { kind: 'hook', code: 'tag-immutable' },
      deleteTag: { kind: 'hook', code: 'tag-immutable' },
      foreignBranch: { kind: 'hook', code: 'doctor-ref' },
    })
    expect(result.foreignRepository).toBe('refused')
    expect(store.refs()).toBe(before)
  })

  it('принудительная команда без пути хранилища: соседнее хранилище не закрыто — так и видно', async () => {
    const store = storage()
    expect((await probe(store, fakeSsh({ home: store.home, role: 'doctor' }))).foreignRepository).toBe('open')
    expect((await probe(store, fakeSsh({ home: store.home }))).foreignRepository).toBe('open')
  })

  it('ключ врача привязан к другому хранилищу — причина, пробы не отправлены', async () => {
    const store = storage()
    const other = storage()
    const result = await probe(store, fakeSsh({ home: store.home, forced: ['doctor', other.bare] }))
    expect(result).toEqual({ failure: 'foreign-repository', outcomes: {} })
  })

  it('хук сообщает, куда пользователь git может писать', async () => {
    const store = storage()
    const result = await probe(store, fakeSsh({ home: store.home, forced: ['doctor', store.bare] }))
    if (!asRoot) expect(result.status?.writable).toEqual(expect.arrayContaining(['repo', 'config', 'hooks', 'hooks/update', '~']))
  })

  it('без config: перезапись и удаление ловит только хук — так и видно', async () => {
    const store = storage({ denyNonFastForwards: false, denyDeletes: false })
    const result = await probe(store, fakeSsh({ home: store.home, forced: ['doctor', store.bare] }))
    expect(result.outcomes.nonFastForward).toEqual({ kind: 'hook', code: 'non-fast-forward' })
    expect(result.outcomes.deleteBranch).toEqual({ kind: 'hook', code: 'delete' })
  })

  it('ключ врача без роли: чужая ветка доходит до последней преграды хука', async () => {
    const store = storage()
    const result = await probe(store, fakeSsh({ home: store.home }))
    expect(result.outcomes.foreignBranch).toEqual({ kind: 'hook', code: 'probe' })
  })

  it('ни хука, ни config: ни одна проба ничего не записала', async () => {
    const store = storage({ hook: false, denyNonFastForwards: false, denyDeletes: false })
    const before = store.refs()
    const result = await probe(store, fakeSsh({ home: store.home, forced: ['doctor', store.bare] }))
    expect(result.status).toBeUndefined()
    for (const outcome of Object.values(result.outcomes)) expect(outcome.kind).toBe('git')
    expect(Object.keys(result.outcomes)).toHaveLength(6)
    expect(store.refs()).toBe(before)
  })

  it('ssh не пустил или не узнал сервер — причина без текста ssh', async () => {
    const store = storage()
    expect((await probe(store, fakeSsh({ home: store.home, failure: 'git@storage.invalid: Permission denied (publickey).' }))).failure).toBe('denied')
    expect((await probe(store, fakeSsh({ home: store.home, failure: 'Host key verification failed.' }))).failure).toBe('host-key')
    expect((await probe(store, fakeSsh({ home: store.home, failure: 'ssh: connect to host storage.invalid port 22: Connection refused' }))).failure).toBe('network')
  })

  it('в хранилище нет основной ветки — пробы не отправляются', async () => {
    const root = tempDir()
    const bare = join(root, 'empty.git')
    mustGit(root, ['init', '--quiet', '--bare', '--initial-branch=main', bare])
    const result = await probeGitStorage({ remote: { host: 'storage.invalid', path: bare }, sshOptions: [], mainBranch: 'main', olderCommit: async () => undefined, ssh: fakeSsh({ home: root }).ssh })
    expect(result).toEqual({ outcomes: {} })
  })
})

describe('доступ врача по SSH-ключу', () => {
  it('адрес хранилища: ssh:// и короткая запись; https и локальный путь — не SSH', () => {
    expect(parseSshRemote('ssh://git@host.docker.internal:2222/srv/git/app.git')).toEqual({ user: 'git', host: 'host.docker.internal', port: '2222', path: '/srv/git/app.git' })
    expect(parseSshRemote('git@host.docker.internal:/srv/git/app.git')).toEqual({ user: 'git', host: 'host.docker.internal', path: '/srv/git/app.git' })
    expect(parseSshRemote('https://github.com/example-owner/example-app.git')).toBeUndefined()
    expect(parseSshRemote('/srv/git/app.git')).toBeUndefined()
    expect(parseSshRemote('ssh://-oProxyCommand=x/srv/git/app.git')).toBeUndefined()
  })

  it('ключ — файлом целиком, с \\n или в base64; не ключ — ошибка без значения', () => {
    expect(decodeSshKey(PEM)).toBe(`${PEM}\n`)
    expect(decodeSshKey(PEM.replace(/\n/g, '\\n'))).toBe(`${PEM}\n`)
    expect(decodeSshKey(Buffer.from(PEM).toString('base64'))).toBe(`${PEM}\n`)
    expect(() => decodeSshKey('не-ключ-секрет')).toThrow(/REMONTNIK_GIT_SSH_KEY/)
    expect(() => decodeSshKey('не-ключ-секрет')).not.toThrow(/не-ключ-секрет/)
  })

  it('без known_hosts — ошибка; файлы — 0600 в папке 0700, в окружении git только пути', async () => {
    const dir = join(tempDir(), 'ssh')
    expect(gitSshAccess({}, dir)).toBeUndefined()
    expect(() => gitSshAccess({ REMONTNIK_GIT_SSH_KEY: PEM }, dir)).toThrow(/REMONTNIK_GIT_KNOWN_HOSTS/)
    const access = gitSshAccess({ REMONTNIK_GIT_SSH_KEY: Buffer.from(PEM).toString('base64'), REMONTNIK_GIT_KNOWN_HOSTS: 'host.docker.internal ssh-ed25519 AAAA' }, dir)!
    await writeGitSshFiles(access)
    expect(statSync(dir).mode & 0o777).toBe(0o700)
    expect(statSync(join(dir, 'key')).mode & 0o777).toBe(0o600)
    expect(readFileSync(join(dir, 'key'), 'utf8')).toBe(`${PEM}\n`)
    expect(readFileSync(join(dir, 'known_hosts'), 'utf8')).toBe('host.docker.internal ssh-ed25519 AAAA\n')
    expect(access.env.GIT_SSH_COMMAND).toContain(`'${join(dir, 'key')}'`)
    expect(access.env.GIT_SSH_COMMAND).toContain("'StrictHostKeyChecking=yes'")
    expect(JSON.stringify(access.env)).not.toContain(PEM.split('\n')[1]!)
  })

  it('врач через ssh: fetch, своя ветка, метка и основная ветка вперёд; ключ ssh взял из файла', async () => {
    const store = storage()
    const ssh = fakeSsh({ home: store.home, forced: ['doctor', store.bare] })
    const root = tempDir()
    const repoDir = join(root, 'app')
    mustGit(root, ['clone', '--quiet', store.bare, repoDir])
    mustGit(repoDir, ['remote', 'set-url', 'origin', `ssh://git@storage.invalid${store.bare}`])
    const access = gitSshAccess({ REMONTNIK_GIT_SSH_KEY: PEM, REMONTNIK_GIT_KNOWN_HOSTS: 'storage.invalid ssh-ed25519 AAAA' }, join(root, 'ssh'))!
    await writeGitSshFiles(access)
    const guard = createGitGuard({ repoDir, worktreesDir: join(root, 'worktrees'), mainBranch: 'main', mainline: 'merge', author: { name: 'Ремонтник', email: 'remontnik@example.invalid' }, env: access.env })

    const savedPath = process.env.PATH
    process.env.PATH = `${resolve(ssh.ssh, '..')}:${savedPath}`
    try {
      await guard.fetch()
      const head = mustGit(repoDir, ['rev-parse', 'origin/main'])
      execFileSync('git', ['-C', repoDir, 'branch', 'remontnik/9-fix', head], { env: { ...process.env, ...GIT_ENV } })
      await guard.push('remontnik/9-fix')
      expect(mustGit(store.bare, ['rev-parse', 'refs/heads/remontnik/9-fix'])).toBe(head)
    } finally {
      process.env.PATH = savedPath
    }
    const calls = ssh.calls()
    expect(calls.length).toBeGreaterThan(0)
    for (const call of calls) {
      expect(call.key).toBe(`${PEM}\n`)
      expect(call.args).toContain('StrictHostKeyChecking=yes')
    }
  })
})
