import { execFileSync, spawnSync } from 'node:child_process'
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

// Живая проверка своего хранилища: настоящий sshd и git-shell в контейнере, хранилище по рецепту
// (own-storage/setup-storage.sh — те же шаги, что в docs/security.md), хук и принудительная команда из deploy/.
// Врач — его образ из deploy/doctor.Dockerfile, как в compose: только чтение, uid 10001, HOME=/tmp, путь к SSH
// хоста через host.docker.internal (host-gateway). Человек — отдельный контейнер со своим ключом. Рядом — второе
// хранилище other.git, а sftp у sshd — internal-sftp: ключи не должны дойти ни туда, ни туда.
// Запуск: pnpm exec vitest run -c vitest.live.config.ts packages/doctor/test/live/own-storage.live.test.ts

const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url))
const fixtures = fileURLToPath(new URL('./own-storage/', import.meta.url))
const DOCTOR_IMAGE = 'remontnik-doctor:own-storage-live'
const STORAGE_IMAGE = 'remontnik-live-storage:local'
const STORAGE = 'remontnik-live-storage'
const DOCTOR = 'remontnik-live-storage-doctor'
const OWNER = 'remontnik-live-storage-owner'
const REPO = '/srv/git/app.git'
const OTHER = '/srv/git/other.git'
const DOCTOR_KEY_LINE = `restrict,command="remontnik-git doctor ${REPO}"`
const PORT = 22_422
const BASE_IMAGE = 'node:22-bookworm-slim@sha256:de170b39439eb0e5a3444ad7d60b015614a381e10fecae2e30ec9e735122f38d'

const dockerReady = spawnSync('docker', ['info'], { stdio: 'ignore' }).status === 0

function docker(args: string[]): string {
  return execFileSync('docker', args, { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 })
}

/** Команда оболочки в контейнере: код выхода не важен, важен вывод. */
function sh(container: string, script: string, options: { user?: string; env?: Record<string, string> } = {}): { ok: boolean; out: string } {
  const env = Object.entries(options.env ?? {}).flatMap(([name, value]) => ['-e', `${name}=${value}`])
  const result = spawnSync('docker', ['exec', ...(options.user ? ['-u', options.user] : []), ...env, container, 'sh', '-c', script], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
  return { ok: result.status === 0, out: `${result.stdout}${result.stderr}` }
}

function must(container: string, script: string, options: { user?: string; env?: Record<string, string> } = {}): string {
  const result = sh(container, script, options)
  if (!result.ok) throw new Error(`${container}: ${script}\n${result.out}`)
  return result.out.trim()
}

const refs = () => must(STORAGE, `git -C ${REPO} for-each-ref --format='%(refname) %(objectname)'`)
const storageFiles = () => must(STORAGE, `cd ${REPO} && sha256sum config HEAD hooks/update && stat -c '%U:%G %a %n' . config HEAD hooks hooks/update objects refs`)

/** Git врача: команда ssh из его же кода (`gitSshAccess`), записана в /tmp при первом шаге. */
const doctorGit = (script: string) => sh(DOCTOR, `export GIT_SSH_COMMAND="$(cat /tmp/git-ssh-command)"; cd /tmp/app && ${script}`)
/** Git человека: свой ключ, тот же known_hosts. */
const ownerGit = (script: string) => sh(OWNER, `cd /tmp/owner && ${script}`)

/** Строки [хранилище] из вывода check-config врача. */
function checkConfig(): { lines: string[]; out: string } {
  const result = sh(DOCTOR, 'remontnik-doctor check-config', { env: { REMONTNIK_CONFIG_REPO_DIR: '/tmp/app' } })
  return { lines: result.out.split('\n').filter((line) => /^\S \[хранилище\]/.test(line)), out: result.out }
}

let work: string
let origin: string

beforeAll(() => {
  if (!dockerReady) return
  work = mkdtempSync(join(tmpdir(), 'remontnik-own-storage-'))
  for (const name of ['git-update-hook', 'git-shell-remontnik-git']) copyFileSync(join(repoRoot, 'deploy', name), join(work, name))
  for (const name of ['setup-storage.sh', 'entry.sh']) copyFileSync(join(fixtures, name), join(work, name))
  writeFileSync(
    join(work, 'Dockerfile'),
    `FROM ${BASE_IMAGE}
RUN apt-get update && apt-get install -y --no-install-recommends git openssh-server && rm -rf /var/lib/apt/lists/*
COPY git-update-hook git-shell-remontnik-git setup-storage.sh entry.sh /opt/remontnik/
RUN sh /opt/remontnik/setup-storage.sh && REPO_NAME=other sh /opt/remontnik/setup-storage.sh
ENTRYPOINT ["sh", "/opt/remontnik/entry.sh"]
`,
  )
  docker(['build', '-q', '-t', STORAGE_IMAGE, work])
  docker(['build', '-q', '-f', 'deploy/doctor.Dockerfile', '-t', DOCTOR_IMAGE, '.'])

  // raw — ключ без принудительной команды: только чтобы показать, что он открыл бы.
  for (const role of ['doctor', 'owner', 'raw']) execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', `${role}-live`, '-f', join(work, role)])
  const doctorPub = readFileSync(join(work, 'doctor.pub'), 'utf8').trim()
  const ownerPub = readFileSync(join(work, 'owner.pub'), 'utf8').trim()
  const rawPub = readFileSync(join(work, 'raw.pub'), 'utf8').trim()
  for (const name of [STORAGE, DOCTOR, OWNER]) spawnSync('docker', ['rm', '-f', name], { stdio: 'ignore' })

  // SSH хранилища опубликован на хосте Docker, как sshd сервера, к которому врач идёт по host.docker.internal
  // (host-gateway). В Colima этот адрес — сам Mac, и порт до него доходит через переброс портов Colima.
  docker([
    'run', '-d', '--name', STORAGE, '-p', `${PORT}:22`,
    '-e', `AUTHORIZED_KEYS=${DOCTOR_KEY_LINE} ${doctorPub}\nrestrict,command="remontnik-git person ${REPO}" ${ownerPub}\nrestrict ${rawPub}`,
    STORAGE_IMAGE,
  ])
  for (let attempt = 0; attempt < 50 && !sh(STORAGE, 'test -s /etc/ssh/ssh_host_ed25519_key.pub && pgrep sshd').ok; attempt++) execFileSync('sleep', ['0.2'])
  const hostKey = must(STORAGE, 'cut -d" " -f1,2 /etc/ssh/ssh_host_ed25519_key.pub')
  const knownHosts = `[host.docker.internal]:${PORT} ${hostKey}`
  origin = `ssh://git@host.docker.internal:${PORT}${REPO}`

  docker([
    'run', '-d', '--name', DOCTOR, '--read-only', '--tmpfs', '/tmp', '--user', '10001:10001', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true',
    '--add-host', 'host.docker.internal:host-gateway', '-e', 'HOME=/tmp',
    '-e', `REMONTNIK_GIT_SSH_KEY=${readFileSync(join(work, 'doctor')).toString('base64')}`,
    '-e', `REMONTNIK_GIT_KNOWN_HOSTS=${knownHosts}`,
    '--entrypoint', 'sleep', DOCTOR_IMAGE, 'infinity',
  ])
  docker(['run', '-d', '--name', OWNER, '--add-host', 'host.docker.internal:host-gateway', '--entrypoint', 'sleep', STORAGE_IMAGE, 'infinity'])
  must(
    OWNER,
    'mkdir -p /root/.ssh && printf "%s" "$KEY" | base64 -d > /root/.ssh/id_ed25519 && printf "%s" "$RAW" | base64 -d > /root/.ssh/raw && chmod 600 /root/.ssh/id_ed25519 /root/.ssh/raw && printf "%s\\n" "$KNOWN" > /root/.ssh/known_hosts',
    { env: { KEY: readFileSync(join(work, 'owner')).toString('base64'), RAW: readFileSync(join(work, 'raw')).toString('base64'), KNOWN: knownHosts } },
  )

  // Человек кладёт приложение в пустое хранилище со своего компьютера.
  must(
    OWNER,
    `git config --global user.name Человек && git config --global user.email person@example.invalid && git config --global core.sshCommand "ssh -o BatchMode=yes -o StrictHostKeyChecking=yes"
     git init --quiet --initial-branch=main /tmp/owner && cd /tmp/owner && echo один > app.txt && git add -A && git commit --quiet -m первый
     echo два > app.txt && git commit --quiet -am второй && git remote add origin '${origin}' && git push --quiet origin main`,
  )
}, 600_000)

afterAll(() => {
  if (!dockerReady) return
  for (const name of [STORAGE, DOCTOR, OWNER]) spawnSync('docker', ['rm', '-f', name], { stdio: 'ignore' })
  if (work) rmSync(work, { recursive: true, force: true })
})

describe.skipIf(!dockerReady)('своё хранилище: живой sshd, git-shell, хук и образ врача', () => {
  it('врач своим кодом: клон, своя ветка, метка и основная ветка вперёд — по ключу из окружения, ключ только в /tmp', () => {
    const script = String.raw`
import { execFileSync } from 'node:child_process'
import { statSync, writeFileSync } from 'node:fs'
import { gitSshAccess, writeGitSshFiles } from '/app/dist/git-storage/index.js'
import { createGitGuard } from '/app/dist/git-guard/index.js'
const access = gitSshAccess(process.env, '/tmp/remontnik-git-ssh')
await writeGitSshFiles(access)
writeFileSync('/tmp/git-ssh-command', access.env.GIT_SSH_COMMAND)
execFileSync('git', ['clone', '--quiet', process.env.ORIGIN, '/tmp/app'], { env: { ...process.env, ...access.env }, stdio: 'inherit' })
const guard = createGitGuard({ repoDir: '/tmp/app', worktreesDir: '/tmp/wt', mainBranch: 'main', mainline: 'merge', author: { name: 'Ремонтник', email: 'remontnik@example.invalid' }, env: access.env })
await guard.fetch()
const base = await guard.mainlineHead()
await guard.addWorktree({ path: '/tmp/wt/7', base, branch: 'remontnik/7-fix' })
writeFileSync('/tmp/wt/7/fix.txt', 'правка врача\n')
const commit = await guard.commitAll('/tmp/wt/7', 'правка врача')
await guard.push('remontnik/7-fix')
await guard.tagPreDeploy('remontnik/pre-deploy/7', base)
await guard.mergeIntoMain('remontnik/7-fix', commit)
console.log(JSON.stringify({ base, commit, keyMode: (statSync('/tmp/remontnik-git-ssh/key').mode & 0o777).toString(8), dirMode: (statSync('/tmp/remontnik-git-ssh').mode & 0o777).toString(8) }))
`
    const result = JSON.parse(must(DOCTOR, `node --input-type=module -e "$SCRIPT"`, { env: { SCRIPT: script, ORIGIN: origin } }).split('\n').at(-1)!)
    expect(result).toMatchObject({ keyMode: '600', dirMode: '700' })
    const after = refs()
    expect(after).toContain(`refs/heads/main ${result.commit}`)
    expect(after).toContain(`refs/heads/remontnik/7-fix ${result.commit}`)
    expect(after).toContain(`refs/tags/remontnik/pre-deploy/7 ${result.base}`)
    // Ключ — только в tmpfs врача и в его окружении; в образе его нет.
    const keyLine = readFileSync(join(work, 'doctor'), 'utf8').split('\n')[1]!
    expect(sh(DOCTOR, 'grep -rlF -e "$LINE" /app /etc /home 2>/dev/null', { env: { LINE: keyLine } }).out.trim()).toBe('')
  })

  it('отказы ключу врача: перезапись и удаление ветки, перезапись и удаление метки remontnik/**, чужая ветка; ссылки не изменились', () => {
    expect(doctorGit('git fetch --quiet origin').ok).toBe(true)
    const before = refs()
    const rewrite = doctorGit('git push --porcelain --force origin origin/main~1:refs/heads/main')
    expect(rewrite.ok).toBe(false)
    expect(rewrite.out).toMatch(/non-fast-forward/)
    const removal = doctorGit('git push --porcelain origin :refs/heads/remontnik/7-fix')
    expect(removal.ok).toBe(false)
    expect(removal.out).toMatch(/deletion prohibited/)
    const moved = doctorGit('git push --porcelain --force origin origin/main:refs/tags/remontnik/pre-deploy/7')
    expect(moved.ok).toBe(false)
    expect(moved.out).toMatch(/remontnik-guard: отказ tag-immutable/)
    const tagRemoval = doctorGit('git push --porcelain origin :refs/tags/remontnik/pre-deploy/7')
    expect(tagRemoval.ok).toBe(false)
    expect(tagRemoval.out).toMatch(/remontnik-guard: отказ tag-immutable/)
    const foreign = doctorGit('git push --porcelain origin origin/main:refs/heads/feature')
    expect(foreign.ok).toBe(false)
    expect(foreign.out).toMatch(/remontnik-guard: отказ doctor-ref/)
    expect(refs()).toBe(before)
  })

  it('человек своим ключом: вперёд и своя ветка — можно; перезапись, удаление и метки врача — отказ', () => {
    expect(ownerGit('git pull --quiet --ff-only origin main && echo три > app.txt && git commit --quiet -am третий && git push --porcelain origin main').ok).toBe(true)
    expect(ownerGit('git push --porcelain origin HEAD:refs/heads/feature').ok).toBe(true)
    const before = refs()
    expect(ownerGit('git push --porcelain --force origin HEAD~2:refs/heads/main').out).toMatch(/non-fast-forward/)
    expect(ownerGit('git push --porcelain origin :refs/heads/feature').out).toMatch(/deletion prohibited/)
    expect(ownerGit('git push --porcelain --force origin HEAD:refs/tags/remontnik/pre-deploy/7').out).toMatch(/remontnik-guard: отказ tag-immutable/)
    expect(ownerGit('git push --porcelain origin :refs/tags/remontnik/pre-deploy/7').out).toMatch(/remontnik-guard: отказ tag-immutable/)
    expect(refs()).toBe(before)
  })

  it('ключи привязаны к своему хранилищу: в соседнее — отказ в любом написании пути; своё — и без .git', () => {
    // В соседнем хранилище есть что читать и куда писать.
    must(STORAGE, `git -C ${REPO} bundle create /tmp/app.bundle main && runuser -u git -- git -C ${OTHER} fetch --quiet /tmp/app.bundle main:main`)
    const otherBefore = must(STORAGE, `git -C ${OTHER} for-each-ref --format='%(refname) %(objectname)'`)
    expect(otherBefore).toMatch(/refs\/heads\/main/)
    const url = (path: string) => `ssh://git@host.docker.internal:${PORT}${path}`
    for (const path of [OTHER, '/srv/git/other', `${REPO}/../other.git`, '/srv/git/./other.git/']) {
      const read = doctorGit(`git ls-remote ${url(path)}`)
      expect(read.ok, path).toBe(false)
      expect(read.out).toMatch(/remontnik-guard: отказ foreign-repo/)
      expect(doctorGit(`git push --porcelain ${url(path)} origin/main:refs/heads/main`).out).toMatch(/remontnik-guard: отказ foreign-repo/)
      expect(ownerGit(`git push --porcelain ${url(path)} HEAD:refs/heads/feature`).out).toMatch(/remontnik-guard: отказ foreign-repo/)
    }
    expect(doctorGit(`git ls-remote ${url('/srv/git/app')}`).out).toMatch(/refs\/heads\/main/)
    expect(ownerGit(`git ls-remote ${url('/srv/git/app/')}`).out).toMatch(/refs\/heads\/main/)
    expect(must(STORAGE, `git -C ${OTHER} for-each-ref --format='%(refname) %(objectname)'`)).toBe(otherBefore)
  })

  it('sftp при internal-sftp: ключ без принудительной команды прошёл бы к файлам ссылок, ключи врача и человека — отказ', () => {
    const sftp = (key: string) => sh(OWNER, `printf 'ls ${REPO}/refs/heads\n' | sftp -b - -o BatchMode=yes -i ${key} -P ${PORT} git@host.docker.internal`)
    const raw = sftp('/root/.ssh/raw')
    expect(raw.ok, raw.out).toBe(true)
    expect(raw.out).toMatch(/main/)
    const person = sftp('/root/.ssh/id_ed25519')
    expect(person.ok).toBe(false)
    expect(person.out).not.toMatch(/main/)
    // Врач — тот же запрос подсистемы sftp своей командой ssh.
    const doctor = sh(DOCTOR, `eval "set -- $(cat /tmp/git-ssh-command)"; "$@" -p ${PORT} -s git@host.docker.internal sftp < /dev/null`)
    expect(doctor.ok).toBe(false)
    // Текст ошибок подсистемы sshd клиенту не отдаёт; что запрос ушёл в принудительную команду — по журналу sshd.
    const log = spawnSync('docker', ['logs', STORAGE], { encoding: 'utf8' })
    const sessions = `${log.stdout}${log.stderr}`
    expect(sessions).toMatch(/Starting session: subsystem 'sftp' for git/)
    expect(sessions).toContain(`Starting session: forced-command (key-option) 'remontnik-git person ${REPO}' for git`)
    expect(sessions).toContain(`Starting session: forced-command (key-option) 'remontnik-git doctor ${REPO}' for git`)
  })

  it('пользователь git не меняет хук и config: ни по SSH, ни с оболочкой на сервере', () => {
    const before = storageFiles()
    // По SSH ключи врача и человека пускают только к git.
    const shellCommand = { CMD: `sh -c 'echo x >> ${REPO}/config'` }
    expect(sh(DOCTOR, `eval "set -- $(cat /tmp/git-ssh-command)"; "$@" -p ${PORT} git@host.docker.internal "$CMD"`, { env: shellCommand }).out).toMatch(/remontnik-guard: отказ command/)
    expect(sh(OWNER, `ssh -o BatchMode=yes -p ${PORT} git@host.docker.internal "$CMD"`, { env: shellCommand }).out).toMatch(/remontnik-guard: отказ command/)
    // Даже с оболочкой пользователя git на самом сервере.
    for (const attempt of [`echo x >> ${REPO}/config`, `rm -f ${REPO}/config`, `mv ${REPO}/HEAD ${REPO}/HEAD.old`, `echo x >> ${REPO}/hooks/update`, `rm -f ${REPO}/hooks/update`, `echo x > ${REPO}/hooks/pre-receive`]) {
      const result = sh(STORAGE, attempt, { user: 'git' })
      expect(result.ok, attempt).toBe(false)
      expect(result.out).toMatch(/Permission denied|Operation not permitted/)
    }
    expect(storageFiles()).toBe(before)
    expect(before).toMatch(/root:git 1775 \.\n/)
    expect(before).toMatch(/root:root 644 config/)
    expect(before).toMatch(/root:root 755 hooks\/update/)
  })

  it('check-config врача: исправное хранилище — без ошибок, с честным предупреждением; сломанное — ошибки по каждой поломке; ничего не записано', () => {
    const before = refs()
    const healthy = checkConfig()
    expect(healthy.lines.filter((line) => line.startsWith('✗'))).toEqual([])
    expect(healthy.lines.some((line) => line.startsWith('✓'))).toBe(true)
    expect(healthy.lines.filter((line) => line.startsWith('!'))).toEqual([expect.stringMatching(/по SSH не проверить/)])
    expect(refs()).toBe(before)

    // Владелец ошибся: выключил запрет удаления, отдал хук пользователю git, снял принудительную команду с ключа врача.
    must(STORAGE, `git -C ${REPO} config receive.denyDeletes false && chown git ${REPO}/hooks/update && sed -i 's|^${DOCTOR_KEY_LINE} |restrict |' /srv/git/.ssh/authorized_keys`)
    try {
      const broken = checkConfig()
      const problems = broken.lines.filter((line) => line.startsWith('✗')).join('\n')
      expect(problems).toMatch(/receive\.denyDeletes/)
      expect(problems).toMatch(/может писать: hooks\/update/)
      expect(problems).toMatch(/другие хранилища на сервере: у него нет принудительной команды/)
      expect(refs()).toBe(before)
      for (const leak of [REPO, 'host.docker.internal:', String(PORT), 'OPENSSH']) expect(broken.out).not.toContain(leak)
    } finally {
      must(STORAGE, `git -C ${REPO} config receive.denyDeletes true && chown root ${REPO}/hooks/update`)
    }
  })

  it('аварийный путь из рецепта: root удаляет ветку прямо в хранилище от имени git, хук не вызывается', () => {
    expect(refs()).toContain('refs/heads/feature ')
    must(STORAGE, `runuser -u git -- git -C ${REPO} update-ref -d refs/heads/feature`)
    expect(refs()).not.toContain('refs/heads/feature ')
    expect(must(STORAGE, `find ${REPO}/refs ${REPO}/objects ! -user git | wc -l`)).toBe('0')
  })
})
