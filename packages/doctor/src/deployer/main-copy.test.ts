import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createGitGuard } from '../git-guard/index.js'
import { testRemontnikConfig } from '../testing/config.js'
import { createMainCopy, mainCopyChange } from './main-copy.js'

// Рабочая копия основной ветки на сервере: из неё идут команды выкатки, поэтому перед promote, rollback, current и
// health врач сверяет её со снимком начала выкатки: чистая, тот же коммит, настройка и скрипты выкатки те же.

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()

function setup() {
  const repoDir = mkdtempSync(join(tmpdir(), 'remontnik-main-copy-'))
  git(repoDir, 'init', '--initial-branch=main')
  git(repoDir, 'config', 'user.email', 'doctor@example.com')
  git(repoDir, 'config', 'user.name', 'Doctor')
  mkdirSync(join(repoDir, 'scripts'))
  writeFileSync(join(repoDir, 'app.ts'), 'export const answer = 1\n')
  writeFileSync(join(repoDir, 'remontnik.config.ts'), 'export default {}\n')
  writeFileSync(join(repoDir, 'scripts', 'deploy.sh'), 'echo deploy\n')
  writeFileSync(join(repoDir, '.gitignore'), 'remontnik.config.local.ts\n')
  writeFileSync(join(repoDir, 'remontnik.config.local.ts'), 'export default {}\n')
  git(repoDir, 'add', '-A')
  git(repoDir, 'commit', '-m', 'начало')
  const guard = createGitGuard({
    repoDir,
    worktreesDir: join(repoDir, '..', 'worktrees'),
    mainBranch: 'main',
    mainline: 'pull-request',
    author: { name: 'Ремонтник', email: 'doctor@example.invalid' },
  })
  const base = testRemontnikConfig().deploy
  const deploy = { ...base, commands: { ...base.commands, promote: 'sh ./scripts/deploy.sh promote', current: 'sh "scripts/deploy.sh" current' } }
  return { repoDir, mainCopy: createMainCopy({ guard, deploy }) }
}

describe('рабочая копия основной ветки', () => {
  it('снимок: коммит, чистота и отпечатки настройки и скриптов из команд; файл замка не считается правкой', async () => {
    const { repoDir, mainCopy } = setup()
    mkdirSync(join(repoDir, '.remontnik'))
    writeFileSync(join(repoDir, '.remontnik', 'deploy.lock'), 'remontnik deployment 1 t 2026-10-26T12:00:00.000Z\n')

    const snapshot = await mainCopy.snapshot()
    expect(snapshot.commit).toBe(git(repoDir, 'rev-parse', 'HEAD'))
    expect(snapshot.dirty).toEqual([])
    expect(Object.keys(snapshot.files).sort()).toEqual(['remontnik.config.local.ts', 'remontnik.config.ts', 'scripts/deploy.sh'])
    expect(mainCopyChange(snapshot, await mainCopy.snapshot())).toBeUndefined()
  })

  it('правка файла, новый коммит или правка игнорируемой настройки — изменение с понятной причиной', async () => {
    const { repoDir, mainCopy } = setup()
    const before = await mainCopy.snapshot()

    writeFileSync(join(repoDir, 'remontnik.config.local.ts'), 'export default { hacked: true }\n')
    expect(mainCopyChange(before, await mainCopy.snapshot())).toContain('remontnik.config.local.ts')

    writeFileSync(join(repoDir, 'app.ts'), 'export const answer = 2\n')
    expect(mainCopyChange(before, await mainCopy.snapshot())).toContain('app.ts')

    git(repoDir, 'commit', '-am', 'чужой коммит')
    expect(mainCopyChange(before, await mainCopy.snapshot())).toContain(before.commit.slice(0, 12))
  })
})
