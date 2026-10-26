import { defineRemontnikConfig, type RemontnikConfigInput } from '@ykurilov/remontnik-core/config'
import { describe, expect, it } from 'vitest'
import type { ChangedFile } from '../changed-files/index.js'
import { findForbiddenZones, type ForbiddenZone } from './index.js'

type ForbiddenInput = RemontnikConfigInput['forbidden']

interface ConfigOverrides {
  commands?: Partial<Record<'build' | 'promote' | 'confirm' | 'rollback' | 'current' | 'health', string>>
  checks?: RemontnikConfigInput['checks']
  lockFile?: string
}

function forbiddenOf(overrides: Partial<ForbiddenInput> = {}, more: ConfigOverrides = {}) {
  return defineRemontnikConfig({
    app: { name: 'demo' },
    repo: { mainBranch: 'main' },
    workbench: { image: 'node:22', install: 'pnpm install --frozen-lockfile' },
    checks: more.checks ?? { test: 'pnpm test' },
    evalScope: [],
    closedPaths: [],
    forbidden: {
      schema: ['db/migrations/**'],
      money: ['src/payments/**'],
      access: ['src/auth/**'],
      ...overrides,
    },
    deploy: {
      commands: {
        build: 'b',
        promote: 'p',
        confirm: 'c',
        rollback: 'r',
        current: 'cur',
        health: 'h',
        ...more.commands,
      },
      lockFile: more.lockFile ?? '.deploy/deploy.lock',
    },
    reports: { telegram: { botTokenEnv: 'ALERT_BOT_TOKEN' } },
  })
}

function file(path: string, extra: Partial<ChangedFile> = {}): ChangedFile {
  return { path, status: 'modified', added: 1, removed: 1, ...extra }
}

function manifest(value: object): string {
  return JSON.stringify(value, null, 2)
}

function patchLines(...changed: string[]): string {
  return ['@@ -1,2 +1,2 @@', ' context', ...changed].join('\n')
}

function zonesOf(forbidden: ReturnType<typeof forbiddenOf>, ...files: ChangedFile[]): ForbiddenZone[] {
  return findForbiddenZones(forbidden, files).map((hit) => hit.zone)
}

describe('findForbiddenZones: зоны приложения', () => {
  it('правка вне зон проходит', () => {
    expect(findForbiddenZones(forbiddenOf(), [file('src/bot/greeting.ts'), file('README.md')])).toEqual([])
  })

  it('схема, деньги и доступы — по маскам из настройки', () => {
    const forbidden = forbiddenOf()
    expect(zonesOf(forbidden, file('db/migrations/0004_add_column.sql'))).toContain('schema')
    expect(zonesOf(forbidden, file('src/payments/charge.ts'))).toEqual(['money'])
    expect(zonesOf(forbidden, file('src/auth/session.ts'))).toEqual(['access'])
  })

  it('дополнительные маски приложения (extra) тоже действуют', () => {
    const forbidden = forbiddenOf({ extra: ['src/billing-export/**'] })
    expect(zonesOf(forbidden, file('src/billing-export/report.ts'))).toEqual(['app_extra'])
  })

  it('заглушка «<нет>» ничего не запрещает', () => {
    const forbidden = forbiddenOf({ schema: ['<нет>'] })
    expect(findForbiddenZones(forbidden, [file('db/other/0004.ts'), file('src/x.ts')])).toEqual([])
  })

  it('в хите есть путь и правило, по которому он попал', () => {
    const [hit] = findForbiddenZones(forbiddenOf(), [file('src/payments/charge.ts')])
    expect(hit).toEqual({ path: 'src/payments/charge.ts', zone: 'money', rule: 'src/payments/**' })
  })

  it('переименование проверяется по обоим путям', () => {
    const renamed = file('src/ok/charge.ts', { status: 'renamed', previousPath: 'src/payments/charge.ts' })
    expect(zonesOf(forbiddenOf(), renamed)).toEqual(['money'])
    const into = file('src/payments/charge.ts', { status: 'renamed', previousPath: 'src/ok/charge.ts' })
    expect(zonesOf(forbiddenOf(), into)).toEqual(['money'])
  })

  it('удаление файла из зоны — тоже правка зоны', () => {
    expect(zonesOf(forbiddenOf(), file('src/auth/session.ts', { status: 'deleted' }))).toEqual(['access'])
  })

  it('обход маски через ../ и обратные слэши не работает', () => {
    expect(zonesOf(forbiddenOf(), file('src/bot/../payments/charge.ts'))).toEqual(['money'])
    expect(zonesOf(forbiddenOf(), file('src\\payments\\charge.ts'))).toEqual(['money'])
  })
})

describe('findForbiddenZones: встроенные запреты', () => {
  const forbidden = forbiddenOf({ access: ['<нет>'] })

  it('.env* и файлы с secret/credential в имени', () => {
    expect(zonesOf(forbidden, file('.env'), file('apps/web/.env.production'))).toEqual(['access', 'access'])
    expect(zonesOf(forbidden, file('config/secrets.json'), file('src/aws-credentials.ts'))).toEqual(['access', 'access'])
  })

  it('код Agent Chat SDK в node_modules и патчи на него', () => {
    expect(zonesOf(forbidden, file('node_modules/@ykurilov/agent-chat-core/dist/index.js'))).toEqual(['agent_chat_sdk'])
    expect(zonesOf(forbidden, file('patches/@ykurilov__agent-chat-server@1.2.0.patch'))).toEqual(['agent_chat_sdk'])
    expect(zonesOf(forbidden, file('patches/@ykurilov+agent-chat-react+1.2.0.patch'))).toEqual(['agent_chat_sdk'])
  })

  it('сама настройка Ремонтника', () => {
    expect(zonesOf(forbidden, file('remontnik.config.ts'))).toEqual(['remontnik'])
    expect(zonesOf(forbidden, file('apps/web/remontnik.config.mjs'))).toEqual(['remontnik'])
  })

  it('встроенные запреты нельзя снять флагами allow*', () => {
    const allowed = forbiddenOf({ access: ['<нет>'], allowDependencyChanges: true, allowBuildAndDeployChanges: true })
    expect(zonesOf(allowed, file('.env'), file('node_modules/@ykurilov/agent-chat-core/index.js'))).toEqual([
      'access',
      'agent_chat_sdk',
    ])
    expect(zonesOf(allowed, file('remontnik.config.ts'))).toEqual(['remontnik'])
  })
})

describe('findForbiddenZones: зависимости, сборка, выкатка', () => {
  it('файлы-замки и сборка/выкатка/CI запрещены по умолчанию', () => {
    const forbidden = forbiddenOf()
    expect(zonesOf(forbidden, file('pnpm-lock.yaml'))).toEqual(['dependencies'])
    expect(zonesOf(forbidden, file('package-lock.json'), file('bun.lock'))).toEqual(['dependencies', 'dependencies'])
    expect(zonesOf(forbidden, file('Dockerfile'), file('apps/web/Dockerfile.prod'))).toEqual([
      'build_and_deploy',
      'build_and_deploy',
    ])
    expect(zonesOf(forbidden, file('docker-compose.yml'), file('compose.prod.yaml'))).toEqual([
      'build_and_deploy',
      'build_and_deploy',
    ])
    expect(zonesOf(forbidden, file('.github/workflows/ci.yml'), file('deploy/promote.sh'))).toEqual([
      'build_and_deploy',
      'build_and_deploy',
    ])
  })

  it('package.json: при allowDependencyChanges=false запрещена любая правка', () => {
    const forbidden = forbiddenOf()
    const dependencyPatch = patchLines('-    "zod": "^4.5.0"', '+    "zod": "^4.6.7"')
    const scriptPatch = patchLines('-    "test": "vitest"', '+    "test": "vitest run"')
    const trueTestPatch = patchLines('-    "test": "vitest"', '+    "test": "true"')
    const postinstallPatch = patchLines('+    "postinstall": "node scripts/x.js"')
    const sourcePatch = patchLines('+    "evil": "attacker/evil#main"')
    for (const patch of [dependencyPatch, scriptPatch, trueTestPatch, postinstallPatch, sourcePatch]) {
      expect(zonesOf(forbidden, file('package.json', { patch }))).toEqual(['dependencies'])
      expect(zonesOf(forbidden, file('apps/web/package.json', { patch }))).toEqual(['dependencies'])
    }
  })

  it('package.json без диффа — неизвестно, что изменено: запрет', () => {
    expect(zonesOf(forbiddenOf(), file('package.json'))).toEqual(['dependencies'])
  })

  it('переименование package.json без правок текста — тоже запрет', () => {
    const renamed = file('apps/web/package.json', { status: 'renamed', previousPath: 'apps/old/package.json', added: 0, removed: 0 })
    expect(zonesOf(forbiddenOf(), renamed)).toEqual(['dependencies'])
    expect(zonesOf(forbiddenOf({ allowDependencyChanges: true }), renamed)).toEqual(['dependencies'])
  })

  it('allowDependencyChanges снимает запрет на замки', () => {
    const forbidden = forbiddenOf({ allowDependencyChanges: true })
    expect(zonesOf(forbidden, file('pnpm-lock.yaml'))).toEqual([])
  })

  it('allowDependencyChanges разрешает package.json, если менялись только разделы зависимостей', () => {
    const forbidden = forbiddenOf({ allowDependencyChanges: true })
    const before = manifest({ name: 'app', scripts: { test: 'vitest' }, dependencies: { zod: '^4.5.0' } })
    const after = manifest({ name: 'app', scripts: { test: 'vitest' }, dependencies: { zod: '^4.6.7' }, devDependencies: { vitest: '5.0.0' } })
    expect(zonesOf(forbidden, file('package.json', { patch: patchLines('+x'), contentBefore: before, contentAfter: after }))).toEqual([])
  })

  it.each([
    ['scripts: test → true', { scripts: { test: 'true' } }],
    ['scripts: postinstall', { scripts: { test: 'vitest', postinstall: 'node x.js' } }],
    ['pnpm.overrides', { pnpm: { overrides: { lodash: '4.17.0' } } }],
    ['pnpm.patchedDependencies', { pnpm: { patchedDependencies: { 'zod@4': 'patches/zod.patch' } } }],
    ['overrides', { overrides: { lodash: '4.17.0' } }],
    ['resolutions', { resolutions: { lodash: '4.17.0' } }],
    ['bin', { bin: { app: 'bin/evil.js' } }],
  ])('и при allowDependencyChanges запрещено: %s', (_name, change) => {
    const forbidden = forbiddenOf({ allowDependencyChanges: true })
    const before = manifest({ name: 'app', scripts: { test: 'vitest' }, dependencies: { zod: '^4.5.0' } })
    const after = manifest({ name: 'app', scripts: { test: 'vitest' }, dependencies: { zod: '^4.5.0' }, ...change })
    expect(zonesOf(forbidden, file('package.json', { patch: patchLines('+x'), contentBefore: before, contentAfter: after }))).toEqual(['dependencies'])
  })

  it('при allowDependencyChanges без полного текста package.json проверить нечем — запрет', () => {
    const forbidden = forbiddenOf({ allowDependencyChanges: true })
    const patch = patchLines('-    "zod": "^4.5.0"', '+    "zod": "^4.6.7"')
    expect(zonesOf(forbidden, file('package.json', { patch }))).toEqual(['dependencies'])
    expect(zonesOf(forbidden, file('package.json', { patch, contentBefore: '{', contentAfter: '{' }))).toEqual(['dependencies'])
  })

  it('allowBuildAndDeployChanges снимает запрет на сборку и выкатку', () => {
    const forbidden = forbiddenOf({ allowBuildAndDeployChanges: true })
    expect(zonesOf(forbidden, file('Dockerfile'), file('.github/workflows/ci.yml'), file('Makefile'), file('tsconfig.json'))).toEqual([])
    expect(zonesOf(forbidden, file('pnpm-lock.yaml'))).toEqual(['dependencies'])
  })

  it('версия пакета Agent Chat SDK или Ремонтника в package.json запрещена даже при allowDependencyChanges', () => {
    const forbidden = forbiddenOf({ allowDependencyChanges: true })
    const sdkPatch = patchLines('-    "@ykurilov/agent-chat-core": "1.2.0"', '+    "@ykurilov/agent-chat-core": "1.3.0"')
    const remontnikPatch = patchLines('+    "@ykurilov/remontnik-watch": "0.2.0"')
    const contentBefore = manifest({ dependencies: {} })
    const contentAfter = manifest({ dependencies: { x: '1.0.0' } })
    expect(zonesOf(forbidden, file('package.json', { patch: sdkPatch, contentBefore, contentAfter }))).toEqual(['agent_chat_sdk'])
    expect(zonesOf(forbidden, file('package.json', { patch: remontnikPatch, contentBefore, contentAfter }))).toEqual(['remontnik'])
  })

  it('pnpm.patchedDependencies для SDK запрещено даже при allowDependencyChanges', () => {
    const forbidden = forbiddenOf({ allowDependencyChanges: true })
    const patch = patchLines('+      "@ykurilov/agent-chat-server@1.2.0": "patches/fix.patch"')
    const contentBefore = manifest({ dependencies: {} })
    const contentAfter = manifest({ dependencies: { x: '1.0.0' } })
    expect(zonesOf(forbidden, file('package.json', { patch, contentBefore, contentAfter }))).toContain('agent_chat_sdk')
  })

  it('файл-замок с правкой пакета SDK запрещён даже при allowDependencyChanges', () => {
    const forbidden = forbiddenOf({ allowDependencyChanges: true })
    const patch = patchLines("+  '@ykurilov/agent-chat-core@1.3.0':")
    expect(zonesOf(forbidden, file('pnpm-lock.yaml', { patch }))).toEqual(['agent_chat_sdk'])
  })

  it('упоминание SDK в обычном коде — не правка пакета', () => {
    const patch = patchLines("+import { createChat } from '@ykurilov/agent-chat-core'")
    expect(zonesOf(forbiddenOf(), file('src/chat.ts', { patch }))).toEqual([])
  })
})

describe('findForbiddenZones: признаки схемы базы в SQL', () => {
  const forbidden = forbiddenOf({ schema: ['db/migrations/**'] })

  it.each([
    ['CREATE TABLE', '+CREATE TABLE notes (id integer);'],
    ['ALTER TABLE', '+alter  table notes add column body text;'],
    ['DROP', '-DROP INDEX notes_idx;'],
  ])('%s в .sql вне папок схемы', (_name, line) => {
    expect(zonesOf(forbidden, file('seeds/fix.sql', { patch: patchLines(line) }))).toEqual(['schema'])
  })

  it('обычный запрос в .sql — не схема', () => {
    expect(zonesOf(forbidden, file('queries/list.sql', { patch: patchLines('+SELECT id FROM notes;') }))).toEqual([])
  })

  it('слово из контекста диффа не считается: смотрим только строки + и -', () => {
    const patch = ['@@ -1,2 +1,2 @@', ' DROP TABLE old;', '+SELECT 1;'].join('\n')
    expect(zonesOf(forbidden, file('queries/list.sql', { patch }))).toEqual([])
  })

  it('.sql без диффа — проверить нечем, считается схемой', () => {
    expect(zonesOf(forbidden, file('queries/list.sql'))).toEqual(['schema'])
  })

  it('признаки ищутся только в файлах .sql', () => {
    const patch = patchLines('+const text = "DROP the beat"')
    expect(zonesOf(forbidden, file('src/lyrics.ts', { patch }))).toEqual([])
  })
})

describe('findForbiddenZones: пути из самой настройки', () => {
  const config = forbiddenOf(
    { allowBuildAndDeployChanges: true, allowDependencyChanges: true },
    {
      commands: {
        build: 'node deploy/remontnik-deploy.ts build',
        rollback: 'bash scripts/rollback.sh --fast',
        health: 'sh -c "scripts/health-check.sh && echo ok"',
        promote: 'FOO=1 ./scripts/promote.sh',
      },
      checks: {
        test: 'pnpm test',
        typecheck: 'node tools/typecheck.mjs',
        eval: {
          run: 'node eval/run-eval.ts --scenarios {scenarios} --out={outDir}/result',
          resultFile: 'eval-result.json',
          repeat: 3,
          maxScenarios: 3,
          env: [],
        },
      },
      lockFile: '.remontnik/deploy.lock',
    },
  )

  it.each([
    'deploy/remontnik-deploy.ts',
    'scripts/rollback.sh',
    'scripts/health-check.sh',
    'scripts/promote.sh',
    'tools/typecheck.mjs',
    'eval/run-eval.ts',
    '.remontnik/deploy.lock',
  ])('файл %s из команд и замка настройки защищён, даже если сборка и выкатка разрешены', (path) => {
    expect(zonesOf(config, file(path))).toContain('build_and_deploy')
  })

  it('хит говорит, откуда путь', () => {
    const [hit] = findForbiddenZones(config, [file('scripts/rollback.sh')])
    expect(hit?.rule).toContain('scripts/rollback.sh')
  })

  it('обычные файлы и слова команд без пути не защищены', () => {
    expect(zonesOf(config, file('src/bot/greeting.ts'), file('build'), file('scripts/other.sh'))).toEqual([])
  })

  it('переименование защищённого скрипта проверяется по обоим путям', () => {
    const renamed = file('scripts/rollback-old.sh', { status: 'renamed', previousPath: 'scripts/rollback.sh', added: 0, removed: 0 })
    expect(zonesOf(config, renamed)).toEqual(['build_and_deploy'])
  })
})

describe('findForbiddenZones: файлы, управляющие сборкой, запуском и зависимостями', () => {
  it.each(['Makefile', 'apps/web/tsconfig.json', 'tsconfig.base.json'])('%s — запрет по умолчанию, снимается allowBuildAndDeployChanges', (path) => {
    expect(zonesOf(forbiddenOf(), file(path))).toEqual(['build_and_deploy'])
    expect(zonesOf(forbiddenOf({ allowBuildAndDeployChanges: true }), file(path))).toEqual([])
  })

  it.each(['.husky/pre-commit', '.gitmodules', '.githooks/pre-push'])('%s — запрет, который снять нельзя', (path) => {
    expect(zonesOf(forbiddenOf({ allowBuildAndDeployChanges: true }), file(path))).toEqual(['build_and_deploy'])
  })

  it.each(['.npmrc', 'pnpm-workspace.yaml', '.pnpmfile.cjs', '.yarnrc.yml'])('%s — запрет, который снять нельзя', (path) => {
    expect(zonesOf(forbiddenOf({ allowDependencyChanges: true }), file(path))).toEqual(['dependencies'])
  })
})

describe('findForbiddenZones: доступы и ключи по расширению', () => {
  it.each(['prod.env', 'certs/server.pem', 'keys/id_rsa.key'])('%s', (path) => {
    expect(zonesOf(forbiddenOf({ access: ['<нет>'] }), file(path))).toEqual(['access'])
  })
})

describe('findForbiddenZones: папки миграций и обходы схемы', () => {
  const forbidden = forbiddenOf({ schema: ['<нет>'] })

  it.each(['db/migrations/001_init.sql', 'migrations/002.ts', 'prisma/schema.prisma', 'drizzle/0001_x.sql', 'db/migrate/20240101_x.rb'])(
    '%s — схема, даже если приложение не указало её в настройке',
    (path) => {
      expect(zonesOf(forbidden, file(path, { patch: patchLines('+x') }))).toEqual(['schema'])
    },
  )

  it('правка существующей миграции — схема', () => {
    expect(zonesOf(forbidden, file('db/migrations/001_init.sql', { status: 'modified', patch: patchLines('-SELECT 1;', '+SELECT 2;') }))).toEqual(['schema'])
  })

  it.each([
    ['DDL разбит на строки', ['+ALTER', '+  TABLE notes ADD x int;']],
    ['TRUNCATE', ['+TRUNCATE TABLE notes;']],
    ['DELETE FROM', ['+delete from notes;']],
    ['CREATE INDEX', ['+create unique index notes_idx on notes(id);']],
    ['GRANT', ['+GRANT ALL ON notes TO app;']],
    ['REVOKE', ['+revoke select on notes from app;']],
  ])('SQL: %s', (_name, lines) => {
    expect(zonesOf(forbidden, file('seeds/fix.sql', { patch: patchLines(...lines) }))).toEqual(['schema'])
  })

  it.each([
    ['db.exec("DROP TABLE notes")'],
    ["await sql`alter table notes add column x int`"],
    ['db.exec("create table x (id int)")'],
    ['db.run("DELETE FROM notes")'],
    ['db.exec("TRUNCATE TABLE notes")'],
  ])('DDL внутри строки в коде: %s', (line) => {
    expect(zonesOf(forbidden, file('src/db.ts', { patch: patchLines(`+${line}`) }))).toEqual(['schema'])
  })

  it('обычные слова в коде — не схема', () => {
    const patch = patchLines('+// delete from the cache, then drop the beat', '+const text = "grant access and truncate the string"')
    expect(zonesOf(forbidden, file('src/text.ts', { patch }))).toEqual([])
  })

  it('переименование .sql без текста правки — схема', () => {
    const renamed = file('seeds/b.sql', { status: 'renamed', previousPath: 'seeds/a.sql', added: 0, removed: 0, patch: '' })
    expect(zonesOf(forbidden, renamed)).toEqual(['schema'])
  })

  it('переименование в папку миграций и из неё — схема', () => {
    const into = file('db/migrations/003.ts', { status: 'renamed', previousPath: 'src/x.ts', added: 0, removed: 0 })
    const from = file('src/x.ts', { status: 'renamed', previousPath: 'db/migrations/003.ts', added: 0, removed: 0 })
    expect(zonesOf(forbidden, into)).toEqual(['schema'])
    expect(zonesOf(forbidden, from)).toEqual(['schema'])
  })
})
