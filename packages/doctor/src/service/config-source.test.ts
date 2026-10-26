import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RemontnikConfigError } from '@ykurilov/remontnik-core/config'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { localConfigReaderForTests, type ConfigCodeReader } from './config-reader.js'
import { ConfigSourceError, createMainBranchConfigSource, loadMainBranchConfig } from './config-source.js'

function configObject(overrides: { timeoutMs?: number; moneyMask?: string; mainBranch?: string; fixablePaths?: string[] } = {}) {
  return {
    app: { name: 'demo' },
    repo: { mainBranch: overrides.mainBranch ?? 'main' },
    workbench: { image: 'node:22', install: 'pnpm install --frozen-lockfile', bashTimeoutMs: overrides.timeoutMs ?? 600_000 },
    checks: { test: 'pnpm test' },
    evalScope: [],
    closedPaths: [],
    ...(overrides.fixablePaths ? { fixablePaths: overrides.fixablePaths } : {}),
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

// Без фонового обслуживания git после коммита: оно пишет в .git, пока тест уже удаляет папку (ENOTEMPTY).
function git(directory: string, ...args: string[]): void {
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'maintenance.auto=false', '-c', 'gc.auto=0', ...args], {
    cwd: directory,
    stdio: 'pipe',
  })
}

function loadMain(directory: string, mainBranch = 'main') {
  return loadMainBranchConfig({ mainCheckoutDirectory: directory, mainBranch, reader: localConfigReaderForTests({ scratchDir: join(root, 'scratch') }) })
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

    const loaded = await loadMain(mainCheckout)

    expect(loaded.file).toBe(join(mainCheckout, 'remontnik.config.mjs'))
    expect(loaded.config.app.name).toBe('demo')
    expect(loaded.config.workbench.bashTimeoutMs).toBe(600_000)
    expect(loaded.config.forbidden.access).toContain('**/.env*')
    expect(loaded.config.forbidden.builtIn.accessMasks).toContain('**/.env*')
  })

  it('читает JSON-настройку', async () => {
    writeFileSync(join(mainCheckout, 'remontnik.config.json'), JSON.stringify(configObject()))
    commitAll(mainCheckout, 'config')
    const loaded = await loadMain(mainCheckout)
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

    const loaded = await loadMain(mainCheckout)

    expect(loaded.config.forbidden.money).toEqual(['src/payments/**'])
    expect(loaded.config.workbench.bashTimeoutMs).toBe(600_000)
  })

  it('ошибка, если вместо основной ветки передана рабочая копия ветки врача', async () => {
    writeFileSync(join(mainCheckout, 'remontnik.config.mjs'), moduleText(configObject()))
    commitAll(mainCheckout, 'config')
    const doctorCheckout = join(root, 'doctor')
    git(mainCheckout, 'worktree', 'add', '-b', 'remontnik/7-fix', doctorCheckout)

    await expect(loadMain(doctorCheckout)).rejects.toMatchObject({
      name: 'ConfigSourceError',
      code: 'branch_mismatch',
    })
  })

  it('перечитывает файл после обновления основной ветки', async () => {
    const file = join(mainCheckout, 'remontnik.config.mjs')
    writeFileSync(file, moduleText(configObject({ timeoutMs: 1000 })))
    commitAll(mainCheckout, 'first')
    expect((await loadMain(mainCheckout)).config.workbench.bashTimeoutMs).toBe(1000)

    writeFileSync(file, moduleText(configObject({ timeoutMs: 2000 })))
    commitAll(mainCheckout, 'second')
    expect((await loadMain(mainCheckout)).config.workbench.bashTimeoutMs).toBe(2000)
  })

  it('принимает уже собранную defineRemontnikConfig настройку (со встроенными запретами)', async () => {
    const { defineRemontnikConfig } = await import('@ykurilov/remontnik-core/config')
    const resolved = defineRemontnikConfig(configObject())
    writeFileSync(join(mainCheckout, 'remontnik.config.mjs'), moduleText(resolved))
    commitAll(mainCheckout, 'config')

    const loaded = await loadMain(mainCheckout)

    expect(loaded.config.forbidden.access).toEqual(resolved.forbidden.access)
  })

  it('встроенные запреты из файла не подменяют встроенные запреты врача', async () => {
    const tampered = { ...configObject(), forbidden: { ...configObject().forbidden, builtIn: { accessMasks: [] } } }
    writeFileSync(join(mainCheckout, 'remontnik.config.mjs'), moduleText(tampered))
    commitAll(mainCheckout, 'config')

    const loaded = await loadMain(mainCheckout)

    expect(loaded.config.forbidden.builtIn.accessMasks).toContain('**/.env*')
    expect(loaded.config.forbidden.access).toContain('**/.env*')
  })
})

describe('loadMainBranchConfig: ошибки', () => {
  it('нет файла настройки', async () => {
    await expect(loadMain(mainCheckout)).rejects.toMatchObject({ code: 'not_found' })
  })

  it('два файла настройки — неоднозначно', async () => {
    writeFileSync(join(mainCheckout, 'remontnik.config.mjs'), moduleText(configObject()))
    writeFileSync(join(mainCheckout, 'remontnik.config.json'), JSON.stringify(configObject()))
    await expect(loadMain(mainCheckout)).rejects.toMatchObject({ code: 'ambiguous' })
  })

  it('файл служб для тестов попадает в fixablePaths — отказ с понятным текстом', async () => {
    const config = { ...configObject({ fixablePaths: ['src/**', 'ci/**'] }), checks: { test: 'pnpm test', services: 'ci/services.yml' } }
    writeFileSync(join(mainCheckout, 'remontnik.config.mjs'), moduleText(config))
    commitAll(mainCheckout, 'services in fixable')
    const error = await loadMain(mainCheckout).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(ConfigSourceError)
    expect((error as ConfigSourceError).code).toBe('services_fixable')
    expect((error as Error).message).toMatch(/checks\.services.*ci\/services\.yml.*fixablePaths.*ci\/\*\*/)
  })

  it('настройка с ошибками — понятная ошибка проверки', async () => {
    writeFileSync(join(mainCheckout, 'remontnik.config.mjs'), moduleText({ app: { name: 'demo' } }))
    commitAll(mainCheckout, 'broken')
    await expect(loadMain(mainCheckout)).rejects.toBeInstanceOf(RemontnikConfigError)
  })

  it('файл не читается как модуль', async () => {
    writeFileSync(join(mainCheckout, 'remontnik.config.mjs'), 'export default {{{')
    commitAll(mainCheckout, 'broken')
    await expect(loadMain(mainCheckout)).rejects.toMatchObject({ code: 'unreadable' })
  })

  it('имя основной ветки в настройке не совпадает с веткой рабочей копии', async () => {
    writeFileSync(join(mainCheckout, 'remontnik.config.mjs'), moduleText(configObject({ mainBranch: 'trunk' })))
    commitAll(mainCheckout, 'config')
    await expect(loadMain(mainCheckout)).rejects.toMatchObject({ code: 'branch_mismatch' })
  })

  it('файл настройки — ссылка за пределы рабочей копии', async () => {
    const outside = join(root, 'outside.mjs')
    writeFileSync(outside, moduleText(configObject()))
    symlinkSync(outside, join(mainCheckout, 'remontnik.config.mjs'))
    await expect(loadMain(mainCheckout)).rejects.toMatchObject({ code: 'outside_checkout' })
  })

  // Список файлов настройки строится по git, а там ссылка — это строка с путём, а не текст файла: выполнялся бы
  // файл, которого нет в списке, который защищает шлюз правки. Поэтому ссылка — отказ, и код не выполняется.
  it('файл настройки — ссылка внутри рабочей копии: отказ', async () => {
    writeFileSync(join(mainCheckout, 'real.config.mjs'), moduleText(configObject()))
    symlinkSync('real.config.mjs', join(mainCheckout, 'remontnik.config.mjs'))
    commitAll(mainCheckout, 'config')
    await expect(loadMain(mainCheckout)).rejects.toMatchObject({ code: 'symlink', message: expect.stringContaining('remontnik.config.mjs') })
  })

  it('подключённый файл — ссылка внутри рабочей копии: отказ до выполнения', async () => {
    mkdirSync(join(mainCheckout, 'src'))
    writeFileSync(join(mainCheckout, 'src/real.mjs'), `export const NAME = 'demo'\n`)
    symlinkSync('real.mjs', join(mainCheckout, 'src/link.mjs'))
    writeFileSync(join(mainCheckout, 'remontnik.config.mjs'), `import { NAME } from './src/link.mjs'\nexport default { ...${JSON.stringify(configObject())}, app: { name: NAME } }\n`)
    commitAll(mainCheckout, 'config')
    await expect(loadMain(mainCheckout)).rejects.toMatchObject({ code: 'symlink', message: expect.stringContaining('src/link.mjs') })
    expect(existsSync(join(root, 'scratch'))).toBe(false)
  })

  it('папка на пути подключённого файла — ссылка: отказ', async () => {
    mkdirSync(join(mainCheckout, 'lib'))
    writeFileSync(join(mainCheckout, 'lib/name.mjs'), `export const NAME = 'demo'\n`)
    symlinkSync('lib', join(mainCheckout, 'src'))
    writeFileSync(join(mainCheckout, 'remontnik.config.mjs'), `import { NAME } from './src/name.mjs'\nexport default { ...${JSON.stringify(configObject())}, app: { name: NAME } }\n`)
    commitAll(mainCheckout, 'config')
    await expect(loadMain(mainCheckout)).rejects.toMatchObject({ code: 'symlink', message: expect.stringContaining('src/name.mjs') })
  })

  it('ConfigSourceError — обычная ошибка с кодом', () => {
    const error = new ConfigSourceError('not_found', 'нет файла')
    expect(error).toBeInstanceOf(Error)
    expect(error.code).toBe('not_found')
  })

  it('рабочая копия без git: ветку проверить нечем — отказ', async () => {
    const plain = join(root, 'plain')
    mkdirSync(plain)
    writeFileSync(join(plain, 'remontnik.config.mjs'), moduleText(configObject()))
    await expect(loadMain(plain)).rejects.toMatchObject({ code: 'branch_unknown' })
  })

  it('отдельная голова (detached HEAD) — отказ, даже на коммите основной ветки', async () => {
    writeFileSync(join(mainCheckout, 'remontnik.config.mjs'), moduleText(configObject()))
    commitAll(mainCheckout, 'config')
    git(mainCheckout, 'checkout', '--detach')
    await expect(loadMain(mainCheckout)).rejects.toMatchObject({ code: 'branch_unknown' })
  })

  it('отдельная голова на коммите ветки врача — отказ', async () => {
    writeFileSync(join(mainCheckout, 'remontnik.config.mjs'), moduleText(configObject()))
    commitAll(mainCheckout, 'config')
    const doctorCheckout = join(root, 'doctor')
    git(mainCheckout, 'worktree', 'add', '-b', 'remontnik/7-fix', doctorCheckout)
    writeFileSync(join(doctorCheckout, 'remontnik.config.mjs'), moduleText(configObject({ moneyMask: 'nothing/**' })))
    commitAll(doctorCheckout, 'ослабить настройку')
    git(doctorCheckout, 'checkout', '--detach')
    await expect(loadMain(doctorCheckout)).rejects.toMatchObject({ code: 'branch_unknown' })
  })

  it('любая другая ветка, не только remontnik/*, — отказ', async () => {
    writeFileSync(join(mainCheckout, 'remontnik.config.mjs'), moduleText(configObject()))
    commitAll(mainCheckout, 'config')
    git(mainCheckout, 'checkout', '-b', 'feature/x')
    await expect(loadMain(mainCheckout)).rejects.toMatchObject({ code: 'branch_mismatch' })
  })

  it('имя основной ветки приходит от вызывающего, а не из файла', async () => {
    writeFileSync(join(mainCheckout, 'remontnik.config.mjs'), moduleText(configObject({ mainBranch: 'trunk' })))
    commitAll(mainCheckout, 'config')
    git(mainCheckout, 'checkout', '-b', 'trunk')
    // Копия стоит на "trunk" и файл говорит "trunk", но вызывающий считает основной "main".
    await expect(loadMain(mainCheckout, 'main')).rejects.toMatchObject({ code: 'branch_mismatch' })
    expect((await loadMain(mainCheckout, 'trunk')).config.repo.mainBranch).toBe('trunk')
  })

  it('файл из чужой ветки не выполняется: ветка проверяется до чтения', async () => {
    const marker = join(root, 'executed.marker')
    writeFileSync(
      join(mainCheckout, 'remontnik.config.mjs'),
      `import { writeFileSync } from 'node:fs'\nwriteFileSync(${JSON.stringify(marker)}, 'x')\nexport default ${JSON.stringify(configObject())}\n`,
    )
    commitAll(mainCheckout, 'config')
    git(mainCheckout, 'checkout', '-b', 'remontnik/9-evil')
    await expect(loadMain(mainCheckout)).rejects.toMatchObject({ code: 'branch_mismatch' })
    expect(existsSync(marker)).toBe(false)
  })

  it('подключённые файлы настройки перечитываются, а не берутся из кэша', async () => {
    const imported = join(mainCheckout, 'masks.mjs')
    const entry = join(mainCheckout, 'remontnik.config.mjs')
    const configWithImport = `import { money } from './masks.mjs'\nconst base = ${JSON.stringify(configObject())}\nexport default { ...base, forbidden: { ...base.forbidden, money } }\n`
    writeFileSync(entry, configWithImport)
    writeFileSync(imported, "export const money = ['src/payments/**']\n")
    commitAll(mainCheckout, 'first')
    expect((await loadMain(mainCheckout)).config.forbidden.money).toEqual(['src/payments/**'])

    writeFileSync(imported, "export const money = ['src/billing/**']\n")
    commitAll(mainCheckout, 'second')
    expect((await loadMain(mainCheckout)).config.forbidden.money).toEqual(['src/billing/**'])
  })

  it('вывод в консоль из файла настройки не ломает чтение', async () => {
    writeFileSync(
      join(mainCheckout, 'remontnik.config.mjs'),
      `console.log('hello {"not":"config"}')\nexport default ${JSON.stringify(configObject())}\n`,
    )
    commitAll(mainCheckout, 'config')
    expect((await loadMain(mainCheckout)).config.app.name).toBe('demo')
  })

  it('маска с неподдерживаемым синтаксисом — ошибка настройки', async () => {
    writeFileSync(join(mainCheckout, 'remontnik.config.mjs'), moduleText(configObject({ moneyMask: '@(payments|billing)/**' })))
    commitAll(mainCheckout, 'config')
    await expect(loadMain(mainCheckout)).rejects.toMatchObject({ code: 'invalid_mask' })
  })

  it.each([['src/@(a|b)/**'], ['src/}/**']])('маска fixablePaths %s — понятная ошибка настройки при загрузке', async (mask) => {
    writeFileSync(join(mainCheckout, 'remontnik.config.mjs'), moduleText(configObject({ fixablePaths: [mask] })))
    commitAll(mainCheckout, 'config')
    await expect(loadMain(mainCheckout)).rejects.toMatchObject({ code: 'invalid_mask', message: expect.stringContaining(mask) })
  })
})

describe('loadMainBranchConfig: импорты из настройки', () => {
  const importingConfig = (specifier: string) =>
    `import { defineRemontnikConfig } from '${specifier}'\nexport default defineRemontnikConfig(${JSON.stringify(configObject())})\n`

  it('пакеты Ремонтника разрешаются на пакеты врача: в копии нет node_modules', async () => {
    writeFileSync(join(mainCheckout, 'remontnik.config.mjs'), importingConfig('@ykurilov/remontnik-core/config'))
    commitAll(mainCheckout, 'config')

    const loaded = await loadMain(mainCheckout)

    expect(loaded.config.app.name).toBe('demo')
  })

  it('соседний файл настройки по относительному пути импортируется', async () => {
    writeFileSync(join(mainCheckout, 'description.mjs'), `export const NAME = 'from-neighbour'\n`)
    writeFileSync(
      join(mainCheckout, 'remontnik.config.mjs'),
      `import { NAME } from './description.mjs'\nexport default ${JSON.stringify(configObject())}\nexport const unused = NAME\n`,
    )
    commitAll(mainCheckout, 'config')

    await expect(loadMain(mainCheckout)).resolves.toMatchObject({ config: { app: { name: 'demo' } } })
  })

  it('посторонний пакет — понятная ошибка, а не ERR_MODULE_NOT_FOUND', async () => {
    writeFileSync(join(mainCheckout, 'remontnik.config.mjs'), `import dotenv from 'dotenv'\nexport default ${JSON.stringify(configObject())}\nvoid dotenv\n`)
    commitAll(mainCheckout, 'config')

    const failure = await loadMain(mainCheckout).catch((error: unknown) => error)

    expect(failure).toMatchObject({ code: 'unreadable' })
    expect((failure as Error).message).toContain('настройка должна быть данными; импорт dotenv не поддерживается')
    expect((failure as Error).message).not.toContain('ERR_MODULE_NOT_FOUND')
  })

  it('настройка на TypeScript: типы вырезаются, пакет Ремонтника подключается без node_modules', async () => {
    writeFileSync(
      join(mainCheckout, 'remontnik.config.ts'),
      `import { defineRemontnikConfig } from '@ykurilov/remontnik-core'\nconst name: string = 'demo'\nexport default defineRemontnikConfig({ ...(${JSON.stringify(configObject())} as never), app: { name } })\n`,
    )
    commitAll(mainCheckout, 'config')

    const loaded = await loadMain(mainCheckout)

    expect(loaded.config.app.name).toBe('demo')
    expect(loaded.localImports).toEqual([])
  })

  it('встроенный модуль Node с префиксом и без него импортируется', async () => {
    writeFileSync(
      join(mainCheckout, 'remontnik.config.mjs'),
      `import { join } from 'node:path'\nimport { platform } from 'os'\nexport default { ...${JSON.stringify(configObject())}, app: { name: join('de', 'mo').length > 0 && platform() ? 'demo' : 'x' } }\n`,
    )
    commitAll(mainCheckout, 'config')

    await expect(loadMain(mainCheckout)).resolves.toMatchObject({ config: { app: { name: 'demo' } } })
  })

  it('соседний файл тоже подключает пакет Ремонтника, а загрузчик сообщает о нём в localImports', async () => {
    mkdirSync(join(mainCheckout, 'src'))
    writeFileSync(join(mainCheckout, 'src/zones.mjs'), `import { BUILT_IN_FORBIDDEN } from '@ykurilov/remontnik-core/config'\nexport const ACCESS = BUILT_IN_FORBIDDEN.accessMasks.length\n`)
    writeFileSync(
      join(mainCheckout, 'remontnik.config.mjs'),
      `import { ACCESS } from './src/zones.mjs'\nexport default { ...${JSON.stringify(configObject())}, app: { name: ACCESS > 0 ? 'demo' : 'x' } }\n`,
    )
    commitAll(mainCheckout, 'config')

    const loaded = await loadMain(mainCheckout)

    expect(loaded.config.app.name).toBe('demo')
    expect(loaded.localImports).toEqual(['src/zones.mjs'])
  })

  it('пакет Ремонтника, которого нет у врача, — понятная ошибка', async () => {
    writeFileSync(join(mainCheckout, 'remontnik.config.mjs'), importingConfig('@ykurilov/remontnik-watch'))
    commitAll(mainCheckout, 'config')

    const failure = await loadMain(mainCheckout).catch((error: unknown) => error)

    expect(failure).toMatchObject({ code: 'unreadable' })
    expect((failure as Error).message).toContain('@ykurilov/remontnik-watch не поддерживается')
  })

  it('чужой пакет не берётся из node_modules рабочей копии', async () => {
    const stranger = join(mainCheckout, 'node_modules', 'stranger')
    mkdirSync(stranger, { recursive: true })
    writeFileSync(join(stranger, 'package.json'), JSON.stringify({ name: 'stranger', type: 'module', exports: './index.js' }))
    writeFileSync(join(stranger, 'index.js'), `export default 'loaded'\n`)
    writeFileSync(join(mainCheckout, 'remontnik.config.mjs'), `import stranger from 'stranger'\nexport default { ...${JSON.stringify(configObject())}, app: { name: stranger } }\n`)
    writeFileSync(join(mainCheckout, '.gitignore'), 'node_modules\n')
    commitAll(mainCheckout, 'config')

    const failure = await loadMain(mainCheckout).catch((error: unknown) => error)

    expect(failure).toMatchObject({ code: 'unreadable' })
    expect((failure as Error).message).toContain('импорт stranger не поддерживается')
  })

  it('импорт с вычисляемым путём не выполняется: его нет в списке файлов настройки', async () => {
    mkdirSync(join(mainCheckout, 'src'))
    writeFileSync(join(mainCheckout, 'src/hidden.mjs'), `export const NAME = 'hidden'\n`)
    writeFileSync(
      join(mainCheckout, 'remontnik.config.mjs'),
      `const path = './src/' + 'hidden.mjs'\nconst { NAME } = await import(path)\nexport default { ...${JSON.stringify(configObject())}, app: { name: NAME } }\n`,
    )
    commitAll(mainCheckout, 'config')

    const failure = await loadMain(mainCheckout).catch((error: unknown) => error)

    expect(failure).toMatchObject({ code: 'unreadable' })
    expect((failure as Error).message).toContain('не строкой в кавычках')
  })

  it('код настройки видит только файлы настройки: остальное рабочей копии в копию для чтения не попадает', async () => {
    writeFileSync(join(mainCheckout, 'notes.txt'), 'внутреннее\n')
    writeFileSync(
      join(mainCheckout, 'remontnik.config.mjs'),
      `import { readFileSync } from 'node:fs'\nconst notes = readFileSync(new URL('./notes.txt', import.meta.url), 'utf8')\nexport default { ...${JSON.stringify(configObject())}, app: { name: notes } }\n`,
    )
    commitAll(mainCheckout, 'config')

    const failure = await loadMain(mainCheckout).catch((error: unknown) => error)

    expect(failure).toMatchObject({ code: 'unreadable' })
    expect((failure as Error).message).toContain('ENOENT')
  })

  it('импорт за пределы рабочей копии — понятная ошибка до выполнения', async () => {
    writeFileSync(join(root, 'outside.mjs'), `export const NAME = 'outside'\n`)
    writeFileSync(join(mainCheckout, 'remontnik.config.mjs'), `import { NAME } from '../outside.mjs'\nexport default { ...${JSON.stringify(configObject())}, app: { name: NAME } }\n`)
    commitAll(mainCheckout, 'config')

    const failure = await loadMain(mainCheckout).catch((error: unknown) => error)

    expect(failure).toMatchObject({ code: 'unreadable' })
    expect((failure as Error).message).toContain('импорт ../outside.mjs ведёт за пределы репозитория')
  })

  it('окружения врача код настройки не видит, копия после чтения удаляется', async () => {
    process.env.REMONTNIK_TEST_DOCTOR_SECRET = 'doctor-only-value'
    try {
      writeFileSync(
        join(mainCheckout, 'remontnik.config.mjs'),
        `export default { ...${JSON.stringify(configObject())}, app: { name: process.env.REMONTNIK_TEST_DOCTOR_SECRET ?? 'clean' } }\n`,
      )
      commitAll(mainCheckout, 'config')

      expect((await loadMain(mainCheckout)).config.app.name).toBe('clean')
      expect(readdirSync(join(root, 'scratch'))).toEqual([])
    } finally {
      delete process.env.REMONTNIK_TEST_DOCTOR_SECRET
    }
  })

  it('настройка печатает метку ответа сама — врач всё равно берёт настоящий ответ', async () => {
    writeFileSync(
      join(mainCheckout, 'remontnik.config.mjs'),
      `process.stdout.write(process.env.REMONTNIK_RESULT_MARKER + '{"config":{}}')\nexport default ${JSON.stringify(configObject())}\n`,
    )
    commitAll(mainCheckout, 'config')

    expect((await loadMain(mainCheckout)).config.app.name).toBe('demo')
  })
})

describe('createMainBranchConfigSource: код настройки выполняется один раз на коммит и тексты её файлов', () => {
  function countingReader(options: { failFirst?: boolean } = {}) {
    const inner = localConfigReaderForTests({ scratchDir: join(root, 'scratch') })
    let runs = 0
    const reader: ConfigCodeReader = {
      ...inner,
      run: async (input) => {
        runs += 1
        if (options.failFirst && runs === 1) throw new Error('сбой чтения')
        return inner.run(input)
      },
    }
    return { reader, runs: () => runs }
  }

  function writeImportingConfig(name: string) {
    mkdirSync(join(mainCheckout, 'src'), { recursive: true })
    writeFileSync(join(mainCheckout, 'src/name.mjs'), `export const NAME = ${JSON.stringify(name)}\n`)
    writeFileSync(join(mainCheckout, 'remontnik.config.mjs'), `import { NAME } from './src/name.mjs'\nexport default { ...${JSON.stringify(configObject())}, app: { name: NAME } }\n`)
  }

  it('повторные и одновременные чтения — один запуск', async () => {
    writeImportingConfig('demo')
    commitAll(mainCheckout, 'config')
    const { reader, runs } = countingReader()
    const source = createMainBranchConfigSource({ mainCheckoutDirectory: mainCheckout, mainBranch: 'main', reader })

    const together = await Promise.all([source.load(), source.load(), source.load()])
    const later = await source.load()

    expect(runs()).toBe(1)
    expect(together.map((loaded) => loaded.config.app.name)).toEqual(['demo', 'demo', 'demo'])
    expect(later.config).toBe(together[0]!.config)
  })

  it('изменился подключённый файл или коммит основной ветки — новое чтение', async () => {
    writeImportingConfig('first')
    commitAll(mainCheckout, 'config')
    const { reader, runs } = countingReader()
    const source = createMainBranchConfigSource({ mainCheckoutDirectory: mainCheckout, mainBranch: 'main', reader })
    expect((await source.load()).config.app.name).toBe('first')

    writeFileSync(join(mainCheckout, 'src/name.mjs'), `export const NAME = 'second'\n`)
    expect((await source.load()).config.app.name).toBe('second')
    expect(runs()).toBe(2)

    writeFileSync(join(mainCheckout, 'notes.txt'), 'не файл настройки\n')
    commitAll(mainCheckout, 'другой коммит')
    await source.load()
    await source.load()
    expect(runs()).toBe(3)
  })

  it('неудачное чтение не запоминается: следующий вызов читает заново', async () => {
    writeImportingConfig('demo')
    commitAll(mainCheckout, 'config')
    const { reader, runs } = countingReader({ failFirst: true })
    const source = createMainBranchConfigSource({ mainCheckoutDirectory: mainCheckout, mainBranch: 'main', reader })

    await expect(source.load()).rejects.toMatchObject({ code: 'unreadable' })
    expect((await source.load()).config.app.name).toBe('demo')
    expect(runs()).toBe(2)
  })

  it('ветку рабочей копии проверяет каждый вызов: копия ушла с основной — отказ, даже если текст тот же', async () => {
    writeImportingConfig('demo')
    commitAll(mainCheckout, 'config')
    const { reader } = countingReader()
    const source = createMainBranchConfigSource({ mainCheckoutDirectory: mainCheckout, mainBranch: 'main', reader })
    await source.load()

    git(mainCheckout, 'checkout', '-b', 'remontnik/case-1')
    await expect(source.load()).rejects.toMatchObject({ code: 'branch_mismatch' })
  })
})
