import { defineRemontnikConfig, type RemontnikConfigInput } from '@ykurilov/remontnik-core/config'
import { describe, expect, it } from 'vitest'
import type { ChangedFile } from '../changed-files/index.js'
import { findForbiddenZones, type ForbiddenZone } from './index.js'

type ForbiddenInput = RemontnikConfigInput['forbidden']

function forbiddenOf(overrides: Partial<ForbiddenInput> = {}) {
  return defineRemontnikConfig({
    app: { name: 'demo' },
    repo: { mainBranch: 'main' },
    workbench: { image: 'node:22', install: 'pnpm install --frozen-lockfile' },
    checks: { test: 'pnpm test' },
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
      },
      lockFile: '.deploy/deploy.lock',
    },
    reports: { telegram: { botTokenEnv: 'ALERT_BOT_TOKEN' } },
  }).forbidden
}

function file(path: string, extra: Partial<ChangedFile> = {}): ChangedFile {
  return { path, status: 'modified', added: 1, removed: 1, ...extra }
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
    expect(findForbiddenZones(forbidden, [file('db/migrations/0004.ts'), file('src/x.ts')])).toEqual([])
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

  it('package.json: правка зависимостей запрещена, правка скрипта — нет', () => {
    const forbidden = forbiddenOf()
    const dependencyPatch = patchLines('-    "zod": "^4.5.0"', '+    "zod": "^4.6.7"')
    const scriptPatch = patchLines('-    "test": "vitest"', '+    "test": "vitest run"')
    expect(zonesOf(forbidden, file('package.json', { patch: dependencyPatch }))).toEqual(['dependencies'])
    expect(zonesOf(forbidden, file('package.json', { patch: scriptPatch }))).toEqual([])
  })

  it('package.json без диффа — неизвестно, что изменено: считается правкой зависимостей', () => {
    expect(zonesOf(forbiddenOf(), file('package.json'))).toEqual(['dependencies'])
  })

  it('allowDependencyChanges снимает запрет на замки и зависимости', () => {
    const forbidden = forbiddenOf({ allowDependencyChanges: true })
    const dependencyPatch = patchLines('-    "zod": "^4.5.0"', '+    "zod": "^4.6.7"')
    expect(zonesOf(forbidden, file('pnpm-lock.yaml'), file('package.json', { patch: dependencyPatch }))).toEqual([])
  })

  it('allowBuildAndDeployChanges снимает запрет на сборку и выкатку', () => {
    const forbidden = forbiddenOf({ allowBuildAndDeployChanges: true })
    expect(zonesOf(forbidden, file('Dockerfile'), file('.github/workflows/ci.yml'))).toEqual([])
    expect(zonesOf(forbidden, file('pnpm-lock.yaml'))).toEqual(['dependencies'])
  })

  it('версия пакета Agent Chat SDK или Ремонтника в package.json запрещена даже при allowDependencyChanges', () => {
    const forbidden = forbiddenOf({ allowDependencyChanges: true })
    const sdkPatch = patchLines('-    "@ykurilov/agent-chat-core": "1.2.0"', '+    "@ykurilov/agent-chat-core": "1.3.0"')
    const remontnikPatch = patchLines('+    "@ykurilov/remontnik-watch": "0.2.0"')
    expect(zonesOf(forbidden, file('package.json', { patch: sdkPatch }))).toEqual(['agent_chat_sdk'])
    expect(zonesOf(forbidden, file('package.json', { patch: remontnikPatch }))).toEqual(['remontnik'])
  })

  it('pnpm.patchedDependencies для SDK запрещено даже при allowDependencyChanges', () => {
    const forbidden = forbiddenOf({ allowDependencyChanges: true })
    const patch = patchLines('+      "@ykurilov/agent-chat-server@1.2.0": "patches/fix.patch"')
    expect(zonesOf(forbidden, file('package.json', { patch }))).toEqual(['agent_chat_sdk'])
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
