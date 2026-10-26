import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createAppCommands, type DeployCommands } from './app-commands.js'

const A = 'a'.repeat(40)
const B = 'b'.repeat(40)
const commands = (overrides: Partial<DeployCommands> = {}): DeployCommands => ({
  build: 'true',
  promote: 'true',
  confirm: 'true',
  rollback: 'true',
  current: `echo '{"version":"${A}","previous":"${B}"}'`,
  health: 'true',
  ...overrides,
})

describe('команды выкатки приложения', () => {
  it('current: версия и прежняя сборка из stdout; stderr не мешает; мусор — не ответ', async () => {
    const repoDir = mkdtempSync(join(tmpdir(), 'remontnik-app-'))
    const ok = createAppCommands({ repoDir, commands: commands({ current: `echo шум >&2; echo '{"version":"${A}","previous":null}'` }) })
    expect(await ok.current()).toEqual({ ok: true, version: A, previous: null })
    expect(await createAppCommands({ repoDir, commands: commands() }).current()).toEqual({ ok: true, version: A, previous: B })

    const broken = createAppCommands({ repoDir, commands: commands({ current: 'echo not-json' }) })
    expect(await broken.current()).toMatchObject({ ok: false })
    const failed = createAppCommands({ repoDir, commands: commands({ current: 'exit 3' }) })
    expect(await failed.current()).toMatchObject({ ok: false })
    const empty = createAppCommands({ repoDir, commands: commands({ current: `echo '{"version":""}'` }) })
    expect(await empty.current()).toMatchObject({ ok: false })
    const never = createAppCommands({ repoDir, commands: commands({ current: `echo '{"version":null,"previous":null}'` }) })
    expect(await never.current()).toEqual({ ok: true, version: null, previous: null })
  })

  it('current: версия — только полный коммит из 40 знаков; сокращённый, ветка или ключ git — неизвестная версия', async () => {
    const repoDir = mkdtempSync(join(tmpdir(), 'remontnik-app-'))
    for (const version of ['aaa', 'main', '--upload-pack=touch', A.toUpperCase(), `${A}0`]) {
      const app = createAppCommands({ repoDir, commands: commands({ current: `echo '{"version":"${version}","previous":null}'` }) })
      expect(await app.current(), version).toMatchObject({ ok: false })
    }
    const badPrevious = createAppCommands({ repoDir, commands: commands({ current: `echo '{"version":"${A}","previous":"HEAD~1"}'` }) })
    expect(await badPrevious.current()).toMatchObject({ ok: false })
  })

  it('health: код 0 — здоров, иначе причина из вывода; тайм-аут — нездоров', async () => {
    const repoDir = mkdtempSync(join(tmpdir(), 'remontnik-app-'))
    expect(await createAppCommands({ repoDir, commands: commands() }).health()).toEqual({ ok: true })
    expect(await createAppCommands({ repoDir, commands: commands({ health: 'echo база недоступна; exit 1' }) }).health()).toEqual({
      ok: false,
      reason: 'база недоступна',
    })
    const slow = createAppCommands({ repoDir, commands: commands({ health: 'sleep 5' }), timeoutsSeconds: { health: 0.2 } })
    expect(await slow.health()).toMatchObject({ ok: false })
  })

  it('build идёт в копии правки и видит только PATH, свой HOME, REMONTNIK_VERSION и перечисленное в buildEnv', async () => {
    const repoDir = mkdtempSync(join(tmpdir(), 'remontnik-app-'))
    const copyDir = mkdtempSync(join(tmpdir(), 'remontnik-copy-'))
    const out = join(copyDir, 'env.txt')
    const env = {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      HOME: '/home/doctor',
      APP_DEPLOY_ROOT: '/srv/app',
      REGISTRY_HOST: 'registry.example.com',
      REMONTNIK_SHARED_SECRET: 'doctor-secret',
      DEEPSEEK_API_KEY: 'model-key',
      TELEGRAM_BOT_TOKEN: 'bot-token',
      REMONTNIK_VERSION: 'подмена',
    }
    const app = createAppCommands({
      repoDir,
      commands: commands({ build: `pwd > ${out}; env >> ${out}`, promote: `env > ${join(copyDir, 'promote-env.txt')}` }),
      env,
      buildEnv: ['APP_DEPLOY_ROOT', 'REMONTNIK_SHARED_SECRET'],
    })
    expect(await app.build(copyDir, 'c0ffee')).toMatchObject({ ok: true })
    const seen = readFileSync(out, 'utf8')
    const names = seen
      .split('\n')
      .slice(1)
      .filter((line) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(line))
      .map((line) => line.slice(0, line.indexOf('=')))
    expect(seen.split('\n')[0]).toContain(copyDir.split('/').pop())
    expect(seen).toContain('REMONTNIK_VERSION=c0ffee')
    expect(seen).toContain('APP_DEPLOY_ROOT=/srv/app')
    expect(seen).not.toContain('registry.example.com')
    expect(seen).not.toContain('doctor-secret')
    expect(seen).not.toContain('model-key')
    expect(seen).not.toContain('bot-token')
    expect(seen).not.toContain('HOME=/home/doctor')
    expect(names.filter((name) => !['PWD', 'SHLVL', '_', 'OLDPWD'].includes(name)).sort()).toEqual(['APP_DEPLOY_ROOT', 'HOME', 'PATH', 'REMONTNIK_VERSION'])

    // Остальные команды — команды владельца: им окружение врача без его секретов.
    expect(await app.promote()).toMatchObject({ ok: true })
    const promoteEnv = readFileSync(join(copyDir, 'promote-env.txt'), 'utf8')
    expect(promoteEnv).toContain('REGISTRY_HOST=registry.example.com')
    expect(promoteEnv).not.toContain('doctor-secret')
  })

  it('promote, rollback, confirm идут в рабочей копии основной ветки; код не 0 — неудача с хвостом вывода', async () => {
    const repoDir = mkdtempSync(join(tmpdir(), 'remontnik-app-'))
    const app = createAppCommands({ repoDir, commands: commands({ promote: 'pwd', rollback: 'echo нет прежней; exit 2' }) })
    const promoted = await app.promote()
    expect(promoted.ok).toBe(true)
    expect(promoted.output).toContain(repoDir.split('/').pop())
    expect(await app.rollback()).toMatchObject({ ok: false, output: expect.stringContaining('нет прежней') })
    expect(await app.confirm()).toMatchObject({ ok: true })
  })
})
