import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RemontnikConfigError } from '@ykurilov/remontnik-core/config'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ConfigSourceError, loadMainBranchConfig } from './config-source.js'

function configObject(overrides: { timeoutMs?: number; moneyMask?: string; mainBranch?: string } = {}) {
  return {
    app: { name: 'demo' },
    repo: { mainBranch: overrides.mainBranch ?? 'main' },
    workbench: { image: 'node:22', install: 'pnpm install --frozen-lockfile', bashTimeoutMs: overrides.timeoutMs ?? 600_000 },
    checks: { test: 'pnpm test' },
    evalScope: [],
    closedPaths: [],
    forbidden: { schema: ['<нет>'], money: [overrides.moneyMask ?? 'src/payments/**'], access: ['src/auth/**'] },
    deploy: {
      commands: { build: 'b', promote: 'p', confirm: 'c', rollback: 'r', current: 'cur', health: 'h' },
      lockFile: '.deploy/deploy.lock',
    },
    reports: { telegram: { botTokenEnv: 'ALERT_BOT_TOKEN' } },
  }
}

function moduleText(config: object): string {
  return `export default ${JSON.stringify(config)}\n`
}

function git(directory: string, ...args: string[]): void {
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', ...args], {
    cwd: directory,
    stdio: 'pipe',
  })
}

let root: string
let mainCheckout: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'remontnik-config-source-'))
  mainCheckout = join(root, 'main')
  mkdirSync(mainCheckout)
  git(mainCheckout, 'init', '-b', 'main')
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function commitAll(directory: string, message: string): void {
  git(directory, 'add', '-A')
  git(directory, 'commit', '-m', message)
}

describe('loadMainBranchConfig: чтение из основной ветки', () => {
  it('читает и проверяет настройку из рабочей копии основной ветки', async () => {
    writeFileSync(join(mainCheckout, 'remontnik.config.mjs'), moduleText(configObject()))
    commitAll(mainCheckout, 'config')

    const loaded = await loadMainBranchConfig({ mainCheckoutDirectory: mainCheckout })

    expect(loaded.file).toBe(join(mainCheckout, 'remontnik.config.mjs'))
    expect(loaded.config.app.name).toBe('demo')
    expect(loaded.config.workbench.bashTimeoutMs).toBe(600_000)
    expect(loaded.config.forbidden.access).toContain('**/.env*')
    expect(loaded.config.forbidden.builtIn.accessMasks).toContain('**/.env*')
  })

  it('читает JSON-настройку', async () => {
    writeFileSync(join(mainCheckout, 'remontnik.config.json'), JSON.stringify(configObject()))
    commitAll(mainCheckout, 'config')
    const loaded = await loadMainBranchConfig({ mainCheckoutDirectory: mainCheckout })
    expect(loaded.config.app.name).toBe('demo')
  })

  it('правка настройки в ветке врача не действует', async () => {
    writeFileSync(join(mainCheckout, 'remontnik.config.mjs'), moduleText(configObject({ moneyMask: 'src/payments/**' })))
    commitAll(mainCheckout, 'config')

    const doctorCheckout = join(root, 'doctor')
    git(mainCheckout, 'worktree', 'add', '-b', 'remontnik/7-fix', doctorCheckout)
    // Врач в своей ветке «ослабил» настройку: убрал деньги из запретных зон.
    writeFileSync(join(doctorCheckout, 'remontnik.config.mjs'), moduleText(configObject({ moneyMask: 'nothing/**', timeoutMs: 1 })))
    commitAll(doctorCheckout, 'ослабить настройку')

    const loaded = await loadMainBranchConfig({ mainCheckoutDirectory: mainCheckout })

    expect(loaded.config.forbidden.money).toEqual(['src/payments/**'])
    expect(loaded.config.workbench.bashTimeoutMs).toBe(600_000)
  })

  it('ошибка, если вместо основной ветки передана рабочая копия ветки врача', async () => {
    writeFileSync(join(mainCheckout, 'remontnik.config.mjs'), moduleText(configObject()))
    commitAll(mainCheckout, 'config')
    const doctorCheckout = join(root, 'doctor')
    git(mainCheckout, 'worktree', 'add', '-b', 'remontnik/7-fix', doctorCheckout)

    await expect(loadMainBranchConfig({ mainCheckoutDirectory: doctorCheckout })).rejects.toMatchObject({
      name: 'ConfigSourceError',
      code: 'branch_mismatch',
    })
  })

  it('перечитывает файл после обновления основной ветки', async () => {
    const file = join(mainCheckout, 'remontnik.config.mjs')
    writeFileSync(file, moduleText(configObject({ timeoutMs: 1000 })))
    commitAll(mainCheckout, 'first')
    expect((await loadMainBranchConfig({ mainCheckoutDirectory: mainCheckout })).config.workbench.bashTimeoutMs).toBe(1000)

    writeFileSync(file, moduleText(configObject({ timeoutMs: 2000 })))
    commitAll(mainCheckout, 'second')
    expect((await loadMainBranchConfig({ mainCheckoutDirectory: mainCheckout })).config.workbench.bashTimeoutMs).toBe(2000)
  })

  it('принимает уже собранную defineRemontnikConfig настройку (со встроенными запретами)', async () => {
    const { defineRemontnikConfig } = await import('@ykurilov/remontnik-core/config')
    const resolved = defineRemontnikConfig(configObject())
    writeFileSync(join(mainCheckout, 'remontnik.config.mjs'), moduleText(resolved))
    commitAll(mainCheckout, 'config')

    const loaded = await loadMainBranchConfig({ mainCheckoutDirectory: mainCheckout })

    expect(loaded.config.forbidden.access).toEqual(resolved.forbidden.access)
  })

  it('встроенные запреты из файла не подменяют встроенные запреты врача', async () => {
    const tampered = { ...configObject(), forbidden: { ...configObject().forbidden, builtIn: { accessMasks: [] } } }
    writeFileSync(join(mainCheckout, 'remontnik.config.mjs'), moduleText(tampered))
    commitAll(mainCheckout, 'config')

    const loaded = await loadMainBranchConfig({ mainCheckoutDirectory: mainCheckout })

    expect(loaded.config.forbidden.builtIn.accessMasks).toContain('**/.env*')
    expect(loaded.config.forbidden.access).toContain('**/.env*')
  })
})

describe('loadMainBranchConfig: ошибки', () => {
  it('нет файла настройки', async () => {
    await expect(loadMainBranchConfig({ mainCheckoutDirectory: mainCheckout })).rejects.toMatchObject({ code: 'not_found' })
  })

  it('два файла настройки — неоднозначно', async () => {
    writeFileSync(join(mainCheckout, 'remontnik.config.mjs'), moduleText(configObject()))
    writeFileSync(join(mainCheckout, 'remontnik.config.json'), JSON.stringify(configObject()))
    await expect(loadMainBranchConfig({ mainCheckoutDirectory: mainCheckout })).rejects.toMatchObject({ code: 'ambiguous' })
  })

  it('настройка с ошибками — понятная ошибка проверки', async () => {
    writeFileSync(join(mainCheckout, 'remontnik.config.mjs'), moduleText({ app: { name: 'demo' } }))
    commitAll(mainCheckout, 'broken')
    await expect(loadMainBranchConfig({ mainCheckoutDirectory: mainCheckout })).rejects.toBeInstanceOf(RemontnikConfigError)
  })

  it('файл не читается как модуль', async () => {
    writeFileSync(join(mainCheckout, 'remontnik.config.mjs'), 'export default {{{')
    commitAll(mainCheckout, 'broken')
    await expect(loadMainBranchConfig({ mainCheckoutDirectory: mainCheckout })).rejects.toMatchObject({ code: 'unreadable' })
  })

  it('имя основной ветки в настройке не совпадает с веткой рабочей копии', async () => {
    writeFileSync(join(mainCheckout, 'remontnik.config.mjs'), moduleText(configObject({ mainBranch: 'trunk' })))
    commitAll(mainCheckout, 'config')
    await expect(loadMainBranchConfig({ mainCheckoutDirectory: mainCheckout })).rejects.toMatchObject({ code: 'branch_mismatch' })
  })

  it('файл настройки — ссылка за пределы рабочей копии', async () => {
    const outside = join(root, 'outside.mjs')
    writeFileSync(outside, moduleText(configObject()))
    symlinkSync(outside, join(mainCheckout, 'remontnik.config.mjs'))
    await expect(loadMainBranchConfig({ mainCheckoutDirectory: mainCheckout })).rejects.toMatchObject({ code: 'outside_checkout' })
  })

  it('ConfigSourceError — обычная ошибка с кодом', () => {
    const error = new ConfigSourceError('not_found', 'нет файла')
    expect(error).toBeInstanceOf(Error)
    expect(error.code).toBe('not_found')
  })

  it('рабочая копия без git: ветку проверить нечем, настройка читается', async () => {
    const plain = join(root, 'plain')
    mkdirSync(plain)
    writeFileSync(join(plain, 'remontnik.config.mjs'), moduleText(configObject()))
    const loaded = await loadMainBranchConfig({ mainCheckoutDirectory: plain })
    expect(loaded.config.app.name).toBe('demo')
  })
})
