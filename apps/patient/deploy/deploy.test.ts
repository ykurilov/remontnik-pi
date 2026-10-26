import { execFile, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const deployScript = fileURLToPath(new URL('./remontnik-deploy.ts', import.meta.url))

let sandbox: string
let deployRoot: string
let workCopy: string

function commandOptions(env: Record<string, string>) {
  return {
    cwd: existsSync(workCopy) ? workCopy : sandbox,
    env: { ...process.env, PATIENT_DEPLOY_ROOT: deployRoot, ...env },
    encoding: 'utf8' as const,
    timeout: 40_000,
  }
}

function run(command: string, env: Record<string, string> = {}) {
  const result = spawnSync(process.execPath, [deployScript, command], commandOptions(env))
  return { code: result.status, stdout: result.stdout.trim(), stderr: result.stderr }
}

/** Без блокировки: нужен, когда команда ходит в сервер этого же процесса. */
function runAsync(command: string, env: Record<string, string> = {}) {
  return new Promise<{ code: number; stdout: string }>((resolve) => {
    execFile(process.execPath, [deployScript, command], commandOptions(env), (error, stdout) => {
      resolve({ code: error ? Number(error.code ?? 1) : 0, stdout: stdout.trim() })
    })
  })
}

function current() {
  const result = run('current')
  expect(result.code).toBe(0)
  return JSON.parse(result.stdout) as { version: string | null; previous: string | null }
}

/** Настройки выкатки лежат файлом в папке выкаток: врач не передаёт командам переменные с адресами. */
function writeSettings(settings: Record<string, unknown>) {
  mkdirSync(deployRoot, { recursive: true })
  writeFileSync(join(deployRoot, 'settings.json'), JSON.stringify(settings))
}

function buildAndPromote(version: string, content: string) {
  writeFileSync(join(workCopy, 'app.txt'), content)
  expect(run('build', { REMONTNIK_VERSION: version }).code).toBe(0)
  expect(run('promote').code).toBe(0)
}

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'patient-deploy-'))
  deployRoot = join(sandbox, 'server')
  workCopy = join(sandbox, 'work')
  mkdirSync(join(workCopy, 'node_modules', 'junk'), { recursive: true })
  mkdirSync(join(workCopy, '.git'), { recursive: true })
  writeFileSync(join(workCopy, 'node_modules', 'junk', 'index.js'), '')
})

afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true })
})

describe('выкатка «Пациента» на папках', () => {
  it('без выкаток current отдаёт пустую версию', () => {
    expect(current()).toEqual({ version: null, previous: null })
  })

  it('build собирает кандидата в releases/<версия> и не трогает работающую версию', () => {
    buildAndPromote('v1', 'one')
    writeFileSync(join(workCopy, 'app.txt'), 'two')

    expect(run('build', { REMONTNIK_VERSION: 'v2' }).code).toBe(0)

    expect(readFileSync(join(deployRoot, 'releases', 'v2', 'app.txt'), 'utf8')).toBe('two')
    expect(existsSync(join(deployRoot, 'releases', 'v2', 'node_modules'))).toBe(false)
    expect(existsSync(join(deployRoot, 'releases', 'v2', '.git'))).toBe(false)
    expect(current()).toEqual({ version: 'v1', previous: null })
    expect(readFileSync(join(deployRoot, 'current', 'app.txt'), 'utf8')).toBe('one')
  })

  it('build без REMONTNIK_VERSION или с плохой версией — ошибка', () => {
    expect(run('build').code).not.toBe(0)
    expect(run('build', { REMONTNIK_VERSION: '../evil' }).code).not.toBe(0)
  })

  it('promote без кандидата — ошибка', () => {
    expect(run('promote').code).not.toBe(0)
  })

  it('promote сохраняет прежнюю сборку, current показывает обе', () => {
    buildAndPromote('v1', 'one')
    expect(run('confirm').code).toBe(0)
    buildAndPromote('v2', 'two')

    expect(current()).toEqual({ version: 'v2', previous: 'v1' })
    expect(readlinkSync(join(deployRoot, 'current'))).toBe(join('releases', 'v2'))
    expect(readFileSync(join(deployRoot, 'current', 'app.txt'), 'utf8')).toBe('two')
  })

  it('promote отмечает выкатку неподтверждённой, confirm снимает отметку и безопасен для повтора', () => {
    buildAndPromote('v1', 'one')
    const state = () => JSON.parse(readFileSync(join(deployRoot, 'state.json'), 'utf8'))
    expect(state().unconfirmed).toBe(true)

    expect(run('confirm').code).toBe(0)
    expect(run('confirm').code).toBe(0)
    expect(state().unconfirmed).toBe(false)
  })

  it('rollback возвращает прежнюю сборку без git и сети, повтор безопасен', () => {
    buildAndPromote('v1', 'one')
    buildAndPromote('v2', 'two')
    rmSync(workCopy, { recursive: true, force: true })

    expect(run('rollback', { PATH: '' }).code).toBe(0)
    expect(current()).toEqual({ version: 'v1', previous: null })
    expect(readFileSync(join(deployRoot, 'current', 'app.txt'), 'utf8')).toBe('one')

    expect(run('rollback').code).toBe(0)
    expect(current().version).toBe('v1')
  })

  it('rollback без прежней сборки — ошибка', () => {
    buildAndPromote('v1', 'one')

    expect(run('rollback').code).not.toBe(0)
    expect(current().version).toBe('v1')
  })

  it('health: нет выкатки — нездоров, есть — здоров', () => {
    const before = run('health')
    expect(before.code).not.toBe(0)
    expect(before.stdout).not.toBe('')

    buildAndPromote('v1', 'one')
    expect(run('health')).toMatchObject({ code: 0, stdout: 'ok v1' })
  })

  describe('health по адресу работающего приложения', () => {
    let server: Server
    let status = 200

    beforeEach(async () => {
      server = createServer((_request, response) => {
        response.writeHead(status)
        response.end(status === 200 ? 'ok' : 'fail')
      })
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    })

    afterEach(async () => {
      await new Promise((resolve) => server.close(resolve))
    })

    it('200 — здоров, 500 — нет', async () => {
      buildAndPromote('v1', 'one')
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/health`

      writeSettings({ healthUrl: url })

      status = 200
      expect((await runAsync('health')).code).toBe(0)
      status = 500
      const unhealthy = await runAsync('health')
      expect(unhealthy.code).not.toBe(0)
      expect(unhealthy.stdout).toContain('500')
    })
  })

  describe('promote и rollback ждут, пока перезапущенное приложение ответит своей версией', () => {
    let server: Server
    /** Какую версию отдаёт «приложение»: присмотр перезапускает его не сразу после смены ссылки. */
    let answers: string[] = []
    let versionUrl: string

    beforeEach(async () => {
      answers = []
      server = createServer((_request, response) => {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ version: answers.length > 1 ? answers.shift() : answers[0] }))
      })
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
      versionUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/version`
    })

    afterEach(async () => {
      await new Promise((resolve) => server.close(resolve))
    })

    it('promote возвращается, когда приложение отвечает версией кандидата', async () => {
      buildAndPromote('v1', 'one')
      writeFileSync(join(workCopy, 'app.txt'), 'two')
      expect(run('build', { REMONTNIK_VERSION: 'v2' }).code).toBe(0)
      answers = ['v1', 'v1', 'v1', 'v2']
      writeSettings({ versionUrl })

      const promoted = await runAsync('promote')

      expect(promoted).toMatchObject({ code: 0 })
      expect(answers).toEqual(['v2'])
    })

    it('приложение так и не ответило версией кандидата — promote с ошибкой, ссылка уже переставлена', async () => {
      buildAndPromote('v1', 'one')
      writeFileSync(join(workCopy, 'app.txt'), 'two')
      expect(run('build', { REMONTNIK_VERSION: 'v2' }).code).toBe(0)
      answers = ['v1']
      writeSettings({ versionUrl, startTimeoutSeconds: 1 })

      const promoted = await runAsync('promote')

      expect(promoted.code).not.toBe(0)
      expect(promoted.stdout).toContain('v2')
      expect(current().version).toBe('v2')
    })

    it('rollback возвращается, когда приложение отвечает прежней версией', async () => {
      buildAndPromote('v1', 'one')
      buildAndPromote('v2', 'two')
      answers = ['v2', 'v2', 'v1']
      writeSettings({ versionUrl })

      const rolledBack = await runAsync('rollback')

      expect(rolledBack).toMatchObject({ code: 0 })
      expect(answers).toEqual(['v1'])
    })
  })

  it('неизвестная команда — ошибка', () => {
    expect(run('explode').code).not.toBe(0)
  })
})
