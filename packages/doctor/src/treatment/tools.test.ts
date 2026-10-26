import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import type { DocumentReader } from '@earendil-works/pi-durable'
import { describe, expect, it } from 'vitest'
import { BROWSER_TOOL_NAMES, createBrowserTools } from '../browser-tools/index.js'
import { createLocalRunner } from '../workbench/index.js'
import { bashCallPolicy, createWorkbenchEnvFactory, DOCTOR_TOOL_NAMES, doctorTools, TreatmentDoc, type TreatmentDocState } from './index.js'

const limits = { defaultTimeoutSeconds: 60, maxTimeoutSeconds: 600 }

describe('правило вызова bash', () => {
  it('без тайм-аута — ставит тайм-аут по умолчанию', () => {
    expect(bashCallPolicy({ command: 'ls' }, limits)).toEqual({ arguments: { command: 'ls', timeout: 60 } })
  })

  it('тайм-аут больше предела — обрезает до предела, меньший — оставляет', () => {
    expect(bashCallPolicy({ command: 'pnpm test', timeout: 5000 }, limits)).toEqual({ arguments: { command: 'pnpm test', timeout: 600 } })
    expect(bashCallPolicy({ command: 'pnpm test', timeout: 10 }, limits)).toEqual({ arguments: { command: 'pnpm test', timeout: 10 } })
  })

  it('нулевой или отрицательный тайм-аут — тайм-аут по умолчанию', () => {
    expect(bashCallPolicy({ command: 'ls', timeout: 0 }, limits)).toEqual({ arguments: { command: 'ls', timeout: 60 } })
    expect(bashCallPolicy({ command: 'ls', timeout: -5 }, limits)).toEqual({ arguments: { command: 'ls', timeout: 60 } })
  })

  it.each(['git log', 'cd src && git status', 'GIT_DIR=.x git show', '/usr/bin/git diff', 'echo x | git apply', '(git stash)', 'sudo git push'])(
    'git запрещён: %s',
    (command) => {
      expect(bashCallPolicy({ command }, limits)).toMatchObject({ block: expect.stringContaining('git') })
    },
  )

  it.each(['echo legit', 'cat .gitignore', 'ls digits', 'grep -r gitter src', 'node --test test/'])('не git: %s', (command) => {
    expect(bashCallPolicy({ command }, limits)).toHaveProperty('arguments')
  })
})

describe('набор инструментов врача', () => {
  it('постоянный: те же имена в том же порядке', () => {
    expect(doctorTools().map((tool) => tool.name)).toEqual([...DOCTOR_TOOL_NAMES])
    expect(DOCTOR_TOOL_NAMES).toEqual([
      'read',
      'write',
      'edit',
      'bash',
      'case_info',
      ...BROWSER_TOOL_NAMES,
      'finish_diagnosis',
      'finish_fix',
    ])
    expect(doctorTools().map((tool) => tool.description)).toEqual(doctorTools().map((tool) => tool.description))
  })

  it('инструменты браузера есть всегда, даже без службы: набор не зависит от настройки', () => {
    const names = doctorTools(createBrowserTools()).map((tool) => tool.name)
    expect(names).toEqual([...DOCTOR_TOOL_NAMES])
  })
})

function readerWith(state: TreatmentDocState | undefined): DocumentReader {
  return { snapshot: async () => state } as unknown as DocumentReader
}

function workbenchState(root: string): TreatmentDocState {
  return {
    workbench: { root, closedPaths: ['secret/**'], bashTimeoutSeconds: 30, maxTimeoutSeconds: 120 },
    case: { caseId: 1, appName: 'test-app', kind: 'tool_error', where: 'src/a.ts', message: 'boom', stack: '', events: 1 },
  }
}

describe('окружение выполнения модели', () => {
  it('без документа лечения окружения нет: инструменты получат ошибку', async () => {
    const factory = createWorkbenchEnvFactory({ runner: createLocalRunner() })
    expect(await factory({ conversationId: 'c1' as never, read: readerWith(undefined) }, BACKGROUND_CONTEXT)).toBeUndefined()
  })

  it('верстак: закрытые пути и .git недоступны, команды без окружения врача', async () => {
    const root = mkdtempSync(join(tmpdir(), 'remontnik-env-'))
    mkdirSync(join(root, 'src'))
    mkdirSync(join(root, 'secret'))
    mkdirSync(join(root, '.git'))
    writeFileSync(join(root, 'src/a.ts'), 'export const a = 1\n')
    writeFileSync(join(root, 'secret/keys.txt'), 'key\n')
    process.env.REMONTNIK_TEST_SECRET = 'doctor-only-value'
    const factory = createWorkbenchEnvFactory({ runner: createLocalRunner() })
    const env = await factory({ conversationId: 'c1' as never, read: readerWith(workbenchState(root)) }, BACKGROUND_CONTEXT)
    if (!env) throw new Error('окружения нет')

    expect(await env.readTextFile('src/a.ts', BACKGROUND_CONTEXT)).toEqual({ ok: true, value: 'export const a = 1\n' })
    expect((await env.readTextFile('secret/keys.txt', BACKGROUND_CONTEXT)).ok).toBe(false)
    expect((await env.readTextFile('.git/config', BACKGROUND_CONTEXT)).ok).toBe(false)
    expect((await env.readTextFile('../outside.txt', BACKGROUND_CONTEXT)).ok).toBe(false)

    let output = ''
    const result = await env.exec('echo "[$REMONTNIK_TEST_SECRET][$GIT_DIR]"', { onOutput: (text) => (output += text) }, BACKGROUND_CONTEXT)
    expect(result).toEqual({ ok: true, value: { exitCode: 0 } })
    expect(output).not.toContain('doctor-only-value')
    expect(output).toContain('[][/nonexistent]')
    delete process.env.REMONTNIK_TEST_SECRET
  })

  it('тайм-аут команды не больше предела верстака', async () => {
    const root = mkdtempSync(join(tmpdir(), 'remontnik-env-'))
    const state = workbenchState(root)
    state.workbench.maxTimeoutSeconds = 1
    const factory = createWorkbenchEnvFactory({ runner: createLocalRunner() })
    const env = await factory({ conversationId: 'c1' as never, read: readerWith(state) }, BACKGROUND_CONTEXT)
    const result = await env!.exec('sleep 5', { timeout: 100 }, BACKGROUND_CONTEXT)
    expect(result.ok).toBe(false)
    expect(!result.ok && result.error.code).toBe('timeout')
  })

  it('документ лечения — документ разговора', () => {
    expect(TreatmentDoc.definition.scope).toBe('conversation')
  })
})
