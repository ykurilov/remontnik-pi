import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { testRemontnikConfig } from '../testing/config.js'
import { caseWorkbenchEnv, doctorStartPlan, parseListen, startDoctorFromEnv, type DoctorEnv } from './start.js'

// Боевой запуск врача: окружение сервера → служба с исполнителем в контейнере, сетями случая, зеркалом реестра
// и прокси eval; приём событий — только в сети приложения.

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function serverEnv(overrides: Record<string, string | undefined> = {}): DoctorEnv {
  return {
    REMONTNIK_CONFIG_REPO_DIR: '/srv/remontnik/app',
    REMONTNIK_STATE_DIR: '/srv/remontnik/state',
    REMONTNIK_SHARED_SECRET: 'shared-test-secret',
    REMONTNIK_GATEWAY_CONTAINER: 'remontnik-doctor',
    REMONTNIK_LISTEN_NETWORK: 'remontnik-app',
    DEEPSEEK_API_KEY: 'test-deepseek',
    OPENROUTER_API_KEY: 'test-openrouter',
    TEST_ALERT_BOT_TOKEN: '123456:test-bot-token',
    TEST_ALERT_CHAT_ID: 'owner-chat',
    ...overrides,
  }
}

describe('настройка запуска из окружения', () => {
  it('служба, сети случая и приём событий — из окружения и настройки', () => {
    const plan = doctorStartPlan(serverEnv({ REMONTNIK_REPORTS_TOKEN: 'reports-test-token' }), testRemontnikConfig())
    expect(plan.listen).toEqual({ network: 'remontnik-app', port: 7800 })
    expect(plan.gateway).toEqual({ container: 'remontnik-doctor', subnetPool: '10.213.0.0/16' })
    const { service } = plan
    expect(service.telegram).toEqual({ botToken: '123456:test-bot-token', chatId: 'owner-chat' })
    expect(service.reportsFeed).toEqual({ token: 'reports-test-token' })
    expect(service.treatment.worktreesDir).toBe('/srv/remontnik/state/worktrees')
    expect(service.treatment.allowUnisolatedRunner).toBeUndefined()
    expect(plan.runner).toMatchObject({ image: testRemontnikConfig().workbench.image, homesDir: '/srv/remontnik/state/homes' })
  })

  it('приём событий на явном адресе', () => {
    expect(doctorStartPlan(serverEnv({ REMONTNIK_LISTEN_NETWORK: undefined, REMONTNIK_LISTEN: '10.5.0.3:7800' }), testRemontnikConfig()).listen).toEqual({ host: '10.5.0.3', port: 7800 })
  })

  it.each([
    ['REMONTNIK_GATEWAY_CONTAINER', undefined, /REMONTNIK_GATEWAY_CONTAINER/],
    ['REMONTNIK_LISTEN_NETWORK', undefined, /REMONTNIK_LISTEN/],
    ['REMONTNIK_LISTEN', '0.0.0.0:7800', /все адреса/],
    ['REMONTNIK_LISTEN', '[::]:7800', /все адреса/],
    ['REMONTNIK_CASE_SUBNETS', '10.213.0.0/30', /подсет/],
    ['REMONTNIK_SHARED_SECRET', undefined, /REMONTNIK_SHARED_SECRET/],
    ['TEST_ALERT_BOT_TOKEN', undefined, /TEST_ALERT_BOT_TOKEN/],
    ['DEEPSEEK_API_KEY', undefined, /DEEPSEEK_API_KEY/],
  ])('%s = %s → врач не стартует', (name, value, error) => {
    const env = serverEnv({ [name]: value, ...(name === 'REMONTNIK_LISTEN' ? { REMONTNIK_LISTEN_NETWORK: undefined } : {}) })
    expect(() => doctorStartPlan(env, testRemontnikConfig())).toThrow(error)
  })

  it('без чата тревог в настройке — отказ', () => {
    const config = testRemontnikConfig({ reports: { telegram: { botTokenEnv: 'TEST_ALERT_BOT_TOKEN' } } })
    expect(() => doctorStartPlan(serverEnv(), config)).toThrow(/chatIdEnv/)
  })

  it('верстак берёт пакеты только через зеркало врача', () => {
    expect(caseWorkbenchEnv()).toMatchObject({
      npm_config_registry: 'http://remontnik-gateway:7801/',
      COREPACK_NPM_REGISTRY: 'http://remontnik-gateway:7801',
    })
  })

  it('адрес host:port и [ipv6]:port', () => {
    expect(parseListen('[fd00::2]:7810', 'X')).toEqual({ host: 'fd00::2', port: 7810 })
    expect(() => parseListen('10.0.0.2:99999', 'X')).toThrow(/host:port/)
  })
})

describe('старт врача', () => {
  function appRepo(): string {
    const root = mkdtempSync(join(tmpdir(), 'remontnik-start-'))
    dirs.push(root)
    const repoDir = join(root, 'app')
    execFileSync('git', ['init', '--quiet', '--initial-branch=main', repoDir])
    const config = testRemontnikConfig()
    writeFileSync(join(repoDir, 'remontnik.config.json'), JSON.stringify({ ...config, forbidden: { schema: config.forbidden.schema, money: config.forbidden.money, access: config.forbidden.access } }))
    return repoDir
  }

  /** Подставной docker: адреса врача по сетям и одна старая сеть случая; вызовы — в журнал. */
  function fakeDocker(networks: Record<string, string>): { docker: string; calls: () => string[] } {
    const root = mkdtempSync(join(tmpdir(), 'remontnik-docker-'))
    dirs.push(root)
    const docker = join(root, 'docker')
    const log = join(root, 'calls.log')
    const answer = JSON.stringify(Object.fromEntries(Object.entries(networks).map(([name, ip]) => [name, { IPAddress: ip }])))
    writeFileSync(
      docker,
      [
        '#!/bin/sh',
        `echo "$*" >> '${log}'`,
        'case "$1 $2" in',
        `  "inspect --format") printf '%s\n' '${answer}';;`,
        "  \"network ls\") echo stale-network-id;;",
        'esac',
        'exit 0',
        '',
      ].join('\n'),
      { mode: 0o755 },
    )
    return { docker, calls: () => (existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean) : []) }
  }

  it('приём событий — только на адресе врача в сети приложения; старые сети случая удаляются', async () => {
    const repoDir = appRepo()
    const fake = fakeDocker({ 'remontnik-app': '127.0.0.1', 'remontnik-outside': '10.9.0.5' })
    const env = serverEnv({ REMONTNIK_CONFIG_REPO_DIR: repoDir, REMONTNIK_STATE_DIR: join(repoDir, '..', 'state'), REMONTNIK_LISTEN_PORT: '0' })
    const doctor = await startDoctorFromEnv(env, { docker: fake.docker })
    try {
      expect(doctor.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
      expect(fake.calls()).toEqual(expect.arrayContaining(['inspect --format {{json .NetworkSettings.Networks}} remontnik-doctor', 'network rm stale-network-id']))
    } finally {
      await doctor.close()
    }
  })

  it('врача нет в сети приложения → служба не стартует, хранилище не создаётся', async () => {
    const repoDir = appRepo()
    const stateDir = join(repoDir, '..', 'state')
    const env = serverEnv({ REMONTNIK_CONFIG_REPO_DIR: repoDir, REMONTNIK_STATE_DIR: stateDir })
    await expect(startDoctorFromEnv(env, { docker: fakeDocker({ 'remontnik-outside': '10.9.0.5' }).docker })).rejects.toThrow(/remontnik-app/)
    expect(existsSync(stateDir)).toBe(false)
  })
})
