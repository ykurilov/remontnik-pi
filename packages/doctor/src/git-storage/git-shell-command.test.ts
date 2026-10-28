import { spawnSync } from 'node:child_process'
import { realpathSync, symlinkSync } from 'node:fs'
import { join, relative } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fakeSsh, GIT_ENV, removeGitStorageFixtures, storage, type FakeSsh } from '../../test/git-storage-fixtures.js'

// Принудительная команда deploy/git-shell-remontnik-git: ключ ходит только в свои хранилища, в каком бы виде git-shell
// ни получил путь (с .git и без, относительный к дому, через ссылку), и только к git. Сам git-shell — подставной:
// он записывает, какой путь и роль получил git.

vi.setConfig({ testTimeout: 30_000 })

afterEach(removeGitStorageFixtures)

/** `git ls-remote` по SSH через подставной ssh; адрес — как в origin. */
function lsRemote(ssh: FakeSsh, url: string) {
  const result = spawnSync('git', ['ls-remote', url], { encoding: 'utf8', env: { ...process.env, ...GIT_ENV, GIT_SSH_COMMAND: ssh.ssh, GIT_SSH_VARIANT: 'ssh' } })
  return { ok: result.status === 0, out: `${result.stdout}${result.stderr}` }
}

/** Команда в обход git — как `ssh git@сервер '<команда>'` или запрос подсистемы sftp. */
function raw(ssh: FakeSsh, command: string) {
  const result = spawnSync(ssh.ssh, ['git@storage.invalid', command], { encoding: 'utf8' })
  return { ok: result.status === 0, out: `${result.stdout}${result.stderr}` }
}

describe('принудительная команда remontnik-git', () => {
  it('ключ врача: своё хранилище в любом написании пути — git получает путь из authorized_keys и роль врача', () => {
    const store = storage()
    const real = realpathSync(store.bare)
    const link = join(store.root, 'link.git')
    symlinkSync(store.bare, link)
    const ssh = fakeSsh({ home: store.home, forced: ['doctor', store.bare] })
    const fromHome = relative(store.home, store.bare)
    for (const url of [
      `ssh://git@storage.invalid${store.bare}`,
      `ssh://git@storage.invalid${store.bare.replace(/\.git$/, '')}`,
      `ssh://git@storage.invalid${store.bare}/`,
      `ssh://git@storage.invalid${store.home}/../app.git`,
      `ssh://git@storage.invalid${link}`,
      `git@storage.invalid:${fromHome}`,
      `git@storage.invalid:${fromHome.replace(/\.git$/, '')}`,
    ]) {
      const result = lsRemote(ssh, url)
      expect(result.ok, `${url}\n${result.out}`).toBe(true)
      expect(result.out).toMatch(/refs\/heads\/main/)
    }
    expect(new Set(ssh.gitShellCalls())).toEqual(new Set([`upload-pack ${real} doctor`]))
  })

  it('ключ врача в чужое хранилище — отказ в любом написании пути, до git', () => {
    const store = storage()
    const other = storage()
    const ssh = fakeSsh({ home: store.home, forced: ['doctor', store.bare] })
    for (const url of [
      `ssh://git@storage.invalid${other.bare}`,
      `ssh://git@storage.invalid${other.bare.replace(/\.git$/, '')}`,
      `ssh://git@storage.invalid${store.bare}/../../${relative(store.root, other.bare).split('/').slice(1).join('/')}`,
      `ssh://git@storage.invalid${store.root}/../${relative(join(store.root, '..'), other.bare)}`,
      `git@storage.invalid:${relative(store.home, other.bare)}`,
      'ssh://git@storage.invalid/~/app.git',
      `ssh://git@storage.invalid${store.root}/missing.git`,
    ]) {
      const result = lsRemote(ssh, url)
      expect(result.ok, url).toBe(false)
      expect(result.out).toMatch(/remontnik-guard: отказ foreign-repo/)
    }
    expect(ssh.gitShellCalls()).toEqual([])
  })

  it('ключ человека: свои хранилища списком, без роли врача; чужое — отказ', () => {
    const first = storage()
    const second = storage()
    const other = storage()
    const ssh = fakeSsh({ home: first.home, forced: ['person', first.bare, second.bare] })
    expect(lsRemote(ssh, `ssh://git@storage.invalid${first.bare}`).ok).toBe(true)
    expect(lsRemote(ssh, `ssh://git@storage.invalid${second.bare}`).ok).toBe(true)
    expect(lsRemote(ssh, `ssh://git@storage.invalid${other.bare}`).out).toMatch(/отказ foreign-repo/)
    expect(ssh.gitShellCalls()).toEqual([`upload-pack ${realpathSync(first.bare)} `, `upload-pack ${realpathSync(second.bare)} `])
  })

  it('кроме git — ничего: оболочка, scp, sftp (и internal-sftp) — отказ', () => {
    const store = storage()
    const ssh = fakeSsh({ home: store.home, forced: ['person', store.bare] })
    for (const command of ['sh -c id', `scp -t ${store.bare}/config`, 'internal-sftp', '/usr/lib/openssh/sftp-server', `git-receive-pack '${store.bare}' ; id`, '']) {
      const result = raw(ssh, command)
      expect(result.ok, command).toBe(false)
      expect(result.out).toMatch(/remontnik-guard: отказ command/)
    }
    expect(ssh.gitShellCalls()).toEqual([])
  })

  it('строка authorized_keys без пути, с двумя путями у врача или без роли — отказ любому запросу', () => {
    const store = storage()
    for (const forced of [['doctor'], ['doctor', store.bare, store.bare], ['admin', store.bare], [], ['person']]) {
      const result = lsRemote(fakeSsh({ home: store.home, forced }), `ssh://git@storage.invalid${store.bare}`)
      expect(result.ok, forced.join(' ')).toBe(false)
      expect(result.out).toMatch(/remontnik-guard: отказ setup/)
    }
  })
})
