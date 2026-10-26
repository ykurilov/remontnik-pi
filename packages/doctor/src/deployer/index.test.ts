import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { RemontnikConfig } from '@ykurilov/remontnik-core/config'
import { createGitGuard } from '../git-guard/index.js'
import { createMemoryRecordStore } from '../records/index.js'
import { testRemontnikConfig } from '../testing/config.js'
import { createServerDeployer, type Deployment, type DeployRequest } from './index.js'

// Серверная сборка выкатки: настоящие команды приложения через `sh`, настоящий git-замок с меткой прежней версии
// и файл замка рядом с рабочей копией.

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'remontnik-server-deploy-'))
  dirs.push(root)
  const origin = join(root, 'origin.git')
  const repoDir = join(root, 'main')
  const appDir = join(root, 'app')
  mkdirSync(appDir)
  git(root, 'init', '--bare', '--initial-branch=main', origin)
  git(root, 'clone', origin, repoDir)
  git(repoDir, 'config', 'user.email', 'doctor@example.com')
  git(repoDir, 'config', 'user.name', 'Doctor')
  writeFileSync(join(repoDir, 'app.ts'), 'export const answer = 1\n')
  git(repoDir, 'add', '-A')
  git(repoDir, 'commit', '-m', 'начало')
  git(repoDir, 'push', 'origin', 'main')
  const running = git(repoDir, 'rev-parse', 'HEAD')
  writeFileSync(join(appDir, 'running'), running)
  const guard = createGitGuard({
    repoDir,
    worktreesDir: join(root, 'worktrees'),
    mainBranch: 'main',
    mainline: 'pull-request',
    author: { name: 'Ремонтник', email: 'doctor@example.invalid' },
  })
  const base = testRemontnikConfig()
  // Папочная выкатка в миниатюре: `running`/`previous` — что работает и куда откатываться.
  const config: RemontnikConfig = {
    ...base,
    deploy: {
      commands: {
        build: 'echo "$REMONTNIK_VERSION" > "$APP_DIR/candidate"',
        promote: 'cp "$APP_DIR/running" "$APP_DIR/previous" && cp "$APP_DIR/candidate" "$APP_DIR/running"',
        confirm: 'touch "$APP_DIR/confirmed"',
        rollback: 'cp "$APP_DIR/previous" "$APP_DIR/running" && rm "$APP_DIR/previous"',
        current:
          'p=null; [ -f "$APP_DIR/previous" ] && p="\\"$(cat "$APP_DIR/previous")\\""; printf \'{"version":"%s","previous":%s}\\n\' "$(cat "$APP_DIR/running")" "$p"',
        health: 'true',
      },
      lockFile: '.remontnik/deploy.lock',
    },
    observe: { ...base.observe, windowMinutes: 2 },
  }
  const env = { PATH: process.env.PATH ?? '/usr/bin:/bin', APP_DIR: appDir }
  return { root, origin, repoDir, appDir, running, guard, config, env }
}

async function drive(deployer: ReturnType<typeof createServerDeployer>, request: DeployRequest): Promise<Deployment> {
  const store = createMemoryRecordStore()
  let clock = Date.parse('2026-10-26T12:00:00Z')
  for (let steps = 0; steps < 50; steps += 1) {
    const step = await deployer.step(request, { store, now: () => clock })
    if (step.kind === 'done') return step.deployment
    clock = Math.max(clock, step.until)
  }
  throw new Error('выкатка не закончилась')
}

describe('серверная выкатка', () => {
  it('выкатывает кандидата командами приложения, метит прежнюю версию в origin и снимает замок', async () => {
    const s = setup()
    const deployer = createServerDeployer({ guard: s.guard, loadConfig: async () => s.config, env: s.env })
    const candidate = 'c'.repeat(40)

    const deployment = await drive(deployer, { caseId: 5, appName: 'patient', fingerprint: 'fp', candidateVersion: candidate, candidateDir: s.root })

    expect(deployment).toMatchObject({ outcome: 'holding', previousVersion: s.running })
    expect(execFileSync('cat', [join(s.appDir, 'running')], { encoding: 'utf8' }).trim()).toBe(candidate)
    expect(existsSync(join(s.appDir, 'confirmed'))).toBe(true)
    expect(git(s.origin, 'rev-parse', `refs/tags/${deployment.preDeployTag}^{commit}`)).toBe(s.running)
    expect(existsSync(join(s.repoDir, '.remontnik', 'deploy.lock'))).toBe(false)
  })

  it('версия из `current`, похожая на ключ git, — отказ с меткой, а не команда git', async () => {
    const s = setup()
    writeFileSync(join(s.appDir, 'running'), '--upload-pack=touch')
    const deployer = createServerDeployer({ guard: s.guard, loadConfig: async () => s.config, env: s.env })

    const deployment = await drive(deployer, { caseId: 6, appName: 'patient', fingerprint: 'fp', candidateVersion: 'c'.repeat(40), candidateDir: s.root })

    expect(deployment).toMatchObject({ outcome: 'refused', refusal: 'tag_failed' })
    expect(existsSync(join(s.appDir, 'candidate'))).toBe(false)
  })
})
