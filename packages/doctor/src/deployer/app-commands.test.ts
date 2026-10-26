import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createAppCommands, type DeployCommands } from './app-commands.js'

const commands = (overrides: Partial<DeployCommands> = {}): DeployCommands => ({
  build: 'true',
  promote: 'true',
  confirm: 'true',
  rollback: 'true',
  current: `echo '{"version":"aaa","previous":"bbb"}'`,
  health: 'true',
  ...overrides,
})

describe('команды выкатки приложения', () => {
  it('current: версия и прежняя сборка из stdout; stderr не мешает; мусор — не ответ', async () => {
    const repoDir = mkdtempSync(join(tmpdir(), 'remontnik-app-'))
    const ok = createAppCommands({ repoDir, commands: commands({ current: `echo шум >&2; echo '{"version":"aaa","previous":null}'` }) })
    expect(await ok.current()).toEqual({ ok: true, version: 'aaa', previous: null })

    const broken = createAppCommands({ repoDir, commands: commands({ current: 'echo not-json' }) })
    expect(await broken.current()).toMatchObject({ ok: false })
    const failed = createAppCommands({ repoDir, commands: commands({ current: 'exit 3' }) })
    expect(await failed.current()).toMatchObject({ ok: false })
    const empty = createAppCommands({ repoDir, commands: commands({ current: `echo '{"version":""}'` }) })
    expect(await empty.current()).toMatchObject({ ok: false })
    const never = createAppCommands({ repoDir, commands: commands({ current: `echo '{"version":null,"previous":null}'` }) })
    expect(await never.current()).toEqual({ ok: true, version: null, previous: null })
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

  it('build идёт в копии правки с REMONTNIK_VERSION; секреты врача команды не видят, остальное окружение — видят', async () => {
    const repoDir = mkdtempSync(join(tmpdir(), 'remontnik-app-'))
    const copyDir = mkdtempSync(join(tmpdir(), 'remontnik-copy-'))
    const out = join(copyDir, 'env.txt')
    const app = createAppCommands({
      repoDir,
      commands: commands({ build: `pwd > ${out}; env >> ${out}` }),
      env: {
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        APP_DEPLOY_ROOT: '/srv/app',
        REMONTNIK_SHARED_SECRET: 'doctor-secret',
        DEEPSEEK_API_KEY: 'model-key',
        TELEGRAM_BOT_TOKEN: 'bot-token',
        REMONTNIK_VERSION: 'подмена',
      },
    })
    expect(await app.build(copyDir, 'c0ffee')).toMatchObject({ ok: true })
    const seen = readFileSync(out, 'utf8')
    expect(seen.split('\n')[0]).toContain(copyDir.split('/').pop())
    expect(seen).toContain('REMONTNIK_VERSION=c0ffee')
    expect(seen).toContain('APP_DEPLOY_ROOT=/srv/app')
    expect(seen).not.toContain('doctor-secret')
    expect(seen).not.toContain('model-key')
    expect(seen).not.toContain('bot-token')
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
