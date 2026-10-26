import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { testRemontnikConfig } from '../testing/config.js'
import { doctorStartPlan, egressProxyEnv, parseListen, startDoctorFromEnv, type DoctorEnv } from './start.js'

// Боевой запуск врача: окружение сервера → служба с исполнителем в контейнере, закрытыми сетями и прокси eval.

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function serverEnv(overrides: Record<string, string | undefined> = {}): DoctorEnv {
  return {
    REMONTNIK_CONFIG_REPO_DIR: '/srv/remontnik/app',
    REMONTNIK_STATE_DIR: '/srv/remontnik/state',
    REMONTNIK_SHARED_SECRET: 'shared-test-secret',
    REMONTNIK_WORKBENCH_NETWORK: 'remontnik-workbench',
    REMONTNIK_CHECKS_NETWORK: 'remontnik-checks',
    REMONTNIK_EGRESS_PROXY_URL: 'http://172.30.98.2:3128',
    REMONTNIK_EVAL_PROXY_LISTEN: '172.30.99.2:7810',
    REMONTNIK_EVAL_PROXY_URL: 'http://172.30.99.2:7810',
    DEEPSEEK_API_KEY: 'test-deepseek',
    OPENROUTER_API_KEY: 'test-openrouter',
    TEST_ALERT_BOT_TOKEN: '123456:test-bot-token',
    TEST_ALERT_CHAT_ID: 'owner-chat',
    ...overrides,
  }
}

describe('настройка запуска из окружения', () => {
  it('служба, исполнитель в контейнере и прокси eval — из окружения и настройки', () => {
    const plan = doctorStartPlan(serverEnv({ REMONTNIK_REPORTS_TOKEN: 'reports-test-token' }), testRemontnikConfig())
    expect(plan.networks).toEqual({ workbench: 'remontnik-workbench', checks: 'remontnik-checks' })
    const { service } = plan
    expect(service.listen).toEqual({ host: '0.0.0.0', port: 7800 })
    expect(service.telegram).toEqual({ botToken: '123456:test-bot-token', chatId: 'owner-chat' })
    expect(service.reportsFeed).toEqual({ token: 'reports-test-token' })
    expect(service.treatment?.runner?.isolation).toBe('container')
    expect(service.treatment?.allowUnisolatedRunner).toBeUndefined()
    expect(service.treatment?.worktreesDir).toBe('/srv/remontnik/state/worktrees')
    expect(service.treatment?.evalProxy).toEqual({ listen: { host: '172.30.99.2', port: 7810 }, publicUrl: 'http://172.30.99.2:7810' })
  })

  it.each([
    ['REMONTNIK_WORKBENCH_NETWORK', undefined, /REMONTNIK_WORKBENCH_NETWORK/],
    ['REMONTNIK_CHECKS_NETWORK', undefined, /REMONTNIK_CHECKS_NETWORK/],
    ['REMONTNIK_WORKBENCH_NETWORK', 'bridge', /не годится/],
    ['REMONTNIK_CHECKS_NETWORK', 'host', /не годится/],
    ['REMONTNIK_CHECKS_NETWORK', 'remontnik-workbench', /разными/],
    ['REMONTNIK_SHARED_SECRET', undefined, /REMONTNIK_SHARED_SECRET/],
    ['TEST_ALERT_BOT_TOKEN', undefined, /TEST_ALERT_BOT_TOKEN/],
    ['DEEPSEEK_API_KEY', undefined, /DEEPSEEK_API_KEY/],
    ['REMONTNIK_EVAL_PROXY_LISTEN', '172.30.99.2', /host:port/],
    ['REMONTNIK_EGRESS_PROXY_URL', 'http://user:pass@10.0.0.2:3128', /http:\/\/host:port/],
  ])('%s = %s → врач не стартует', (name, value, error) => {
    expect(() => doctorStartPlan(serverEnv({ [name]: value }), testRemontnikConfig())).toThrow(error)
  })

  it('без чата тревог в настройке — отказ', () => {
    const config = testRemontnikConfig({ reports: { telegram: { botTokenEnv: 'TEST_ALERT_BOT_TOKEN' } } })
    expect(() => doctorStartPlan(serverEnv(), config)).toThrow(/chatIdEnv/)
  })

  it('прокси выхода: адрес для pnpm, npm, corepack и fetch Node', () => {
    expect(egressProxyEnv('http://172.30.98.2:3128')).toMatchObject({
      HTTPS_PROXY: 'http://172.30.98.2:3128',
      https_proxy: 'http://172.30.98.2:3128',
      HTTP_PROXY: 'http://172.30.98.2:3128',
      NODE_USE_ENV_PROXY: '1',
    })
  })

  it('адрес host:port и [ipv6]:port', () => {
    expect(parseListen('[fd00::2]:7810', 'X')).toEqual({ host: 'fd00::2', port: 7810 })
    expect(() => parseListen('10.0.0.2:99999', 'X')).toThrow(/host:port/)
  })
})

describe('старт врача проверяет сети Docker', () => {
  function appRepo(): string {
    const root = mkdtempSync(join(tmpdir(), 'remontnik-start-'))
    dirs.push(root)
    const repoDir = join(root, 'app')
    execFileSync('git', ['init', '--quiet', '--initial-branch=main', repoDir])
    const config = testRemontnikConfig()
    writeFileSync(join(repoDir, 'remontnik.config.json'), JSON.stringify({ ...config, forbidden: { schema: config.forbidden.schema, money: config.forbidden.money, access: config.forbidden.access } }))
    return repoDir
  }

  function fakeDocker(internal: string): string {
    const root = mkdtempSync(join(tmpdir(), 'remontnik-docker-'))
    dirs.push(root)
    const docker = join(root, 'docker')
    writeFileSync(docker, `#!/bin/sh\necho ${internal}\n`, { mode: 0o755 })
    return docker
  }

  it('сеть верстака не закрыта → служба не стартует, хранилище не создаётся', async () => {
    const repoDir = appRepo()
    const stateDir = join(repoDir, '..', 'state')
    const env = serverEnv({ REMONTNIK_CONFIG_REPO_DIR: repoDir, REMONTNIK_STATE_DIR: stateDir })
    await expect(startDoctorFromEnv(env, { docker: fakeDocker("'false bridge true'") })).rejects.toThrow(/не закрыта/)
    expect(() => execFileSync('ls', [stateDir], { stdio: 'pipe' })).toThrow()
  })
})
