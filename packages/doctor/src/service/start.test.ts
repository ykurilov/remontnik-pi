import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { testRemontnikConfig } from '../testing/config.js'
import { startDoctorService } from './index.js'
import { caseWorkbenchEnv, doctorStartPlan, parseListen, startDoctorFromEnv, type DoctorEnv } from './start.js'

// Настоящая служба, но видно, с чем её подняли.
vi.mock('./index.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('./index.js')>()
  return { ...original, startDoctorService: vi.fn(original.startDoctorService) }
})

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

  it('секрет владельца — из REMONTNIK_CONTROL_SECRET; не задан — его нет; совпадает с общим — отказ', () => {
    expect(doctorStartPlan(serverEnv({ REMONTNIK_CONTROL_SECRET: ' owner-test-secret ' }), testRemontnikConfig()).service.controlSecret).toBe('owner-test-secret')
    expect(doctorStartPlan(serverEnv(), testRemontnikConfig()).service.controlSecret).toBeUndefined()
    expect(() => doctorStartPlan(serverEnv({ REMONTNIK_CONTROL_SECRET: 'shared-test-secret' }), testRemontnikConfig())).toThrow(/REMONTNIK_CONTROL_SECRET/)
  })

  it('режим «сначала Paseo»: адрес для моста, его секрет и адрес моста — из переменных, названных в настройке', () => {
    const paseo = { bridgeUrlEnv: 'TEST_BRIDGE_URL', bridgeSecretEnv: 'TEST_BRIDGE_SECRET', listenEnv: 'TEST_BRIDGE_LISTEN', acceptTimeoutMs: 300_000, workTimeoutMs: 3_600_000 }
    const config = testRemontnikConfig({ handoff: { mode: 'paseo-first', paseo } })
    const env = serverEnv({ REMONTNIK_REPORTS_TOKEN: 'reports-test-token', TEST_BRIDGE_URL: 'http://10.0.0.2:7900', TEST_BRIDGE_SECRET: 'bridge-test-secret', TEST_BRIDGE_LISTEN: '10.0.0.1:7820' })
    const { service } = doctorStartPlan(env, config)
    expect(service.reportsFeed).toEqual({ token: 'reports-test-token', bridge: { listen: { host: '10.0.0.1', port: 7820 }, secret: 'bridge-test-secret', appName: config.app.name } })
    expect(service.paseoBridge).toEqual({ url: 'http://10.0.0.2:7900' })
    // Режим «сам»: лента для моста есть, а случаи мосту не уходят.
    expect(doctorStartPlan(env, testRemontnikConfig({ handoff: { mode: 'self', paseo } })).service.paseoBridge).toBeUndefined()
    expect(() => doctorStartPlan(serverEnv({ TEST_BRIDGE_URL: 'http://10.0.0.2:7900', TEST_BRIDGE_LISTEN: '10.0.0.1:7820' }), config)).toThrow(/TEST_BRIDGE_SECRET/)
    expect(() => doctorStartPlan(serverEnv({ TEST_BRIDGE_SECRET: 'bridge-test-secret', TEST_BRIDGE_LISTEN: '10.0.0.1:7820' }), config)).toThrow(/TEST_BRIDGE_URL/)
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
        "  \"ps -a\") echo 'orphan-container running 0123456789abcdef';;",
        'esac',
        'exit 0',
        '',
      ].join('\n'),
      { mode: 0o755 },
    )
    return { docker, calls: () => (existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean) : []) }
  }

  it('приём событий — только на адресе врача в сети приложения; старые сети случая удаляются; выкатчик подключён', async () => {
    const repoDir = appRepo()
    const fake = fakeDocker({ 'remontnik-app': '127.0.0.1', 'remontnik-outside': '10.9.0.5' })
    const env = serverEnv({ REMONTNIK_CONFIG_REPO_DIR: repoDir, REMONTNIK_STATE_DIR: join(repoDir, '..', 'state'), REMONTNIK_LISTEN_PORT: '0' })
    // Копия файлов настройки от чтения, которое оборвало падение врача.
    mkdirSync(join(repoDir, '..', 'state', 'config-read', 'config-old'), { recursive: true })
    const doctor = await startDoctorFromEnv(env, { docker: fake.docker })
    try {
      expect(doctor.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
      // Выкатчик врача: без него решение «выкатывать» закрывалось бы только отчётом.
      const started = vi.mocked(startDoctorService).mock.lastCall![0]
      expect(started.treatment.deployer?.step).toBeTypeOf('function')
      expect(fake.calls()).toEqual(expect.arrayContaining(['inspect --format {{json .NetworkSettings.Networks}} remontnik-doctor', 'network rm stale-network-id']))
      // Контейнеры верстака прошлого запуска убиваются раньше, чем удаляются их сети; удалённый контейнер копию не портит.
      const calls = fake.calls()
      expect(calls.indexOf('rm -f orphan-container')).toBeGreaterThan(-1)
      expect(calls.indexOf('rm -f orphan-container')).toBeLessThan(calls.findIndex((call) => call.startsWith('network ls')))
      expect(existsSync(join(repoDir, '..', 'state', 'homes', '0123456789abcdef.spoiled'))).toBe(false)
      // Службы для тестов прошлого запуска — тоже до удаления сетей: иначе сеть занята.
      const staleServices = calls.indexOf('ps -aq --filter label=remontnik.case-services')
      expect(staleServices).toBeGreaterThan(-1)
      expect(staleServices).toBeLessThan(calls.findIndex((call) => call.startsWith('network ls')))
      // Остатки чтений настройки прошлого запуска: контейнеры с меткой этого врача и копии файлов.
      expect(calls).toContain('ps -aq --filter label=remontnik.config-read=remontnik-doctor')
      expect(readdirSync(join(repoDir, '..', 'state', 'config-read'))).toEqual([])
    } finally {
      await doctor.close()
    }
  })

  it('первое чтение настройки упало — остатки прошлых чтений всё равно убраны', async () => {
    const repoDir = appRepo()
    writeFileSync(join(repoDir, 'remontnik.config.json'), '{ не JSON')
    const stateDir = join(repoDir, '..', 'state')
    const fake = fakeDocker({ 'remontnik-app': '127.0.0.1' })
    mkdirSync(join(stateDir, 'config-read', 'config-old'), { recursive: true })
    await expect(startDoctorFromEnv(serverEnv({ REMONTNIK_CONFIG_REPO_DIR: repoDir, REMONTNIK_STATE_DIR: stateDir }), { docker: fake.docker })).rejects.toThrow()
    expect(fake.calls()).toContain('ps -aq --filter label=remontnik.config-read=remontnik-doctor')
    expect(readdirSync(join(stateDir, 'config-read'))).toEqual([])
  })

  it('врача нет в сети приложения → служба не стартует, хранилище не создаётся', async () => {
    const repoDir = appRepo()
    const stateDir = join(repoDir, '..', 'state')
    const env = serverEnv({ REMONTNIK_CONFIG_REPO_DIR: repoDir, REMONTNIK_STATE_DIR: stateDir })
    await expect(startDoctorFromEnv(env, { docker: fakeDocker({ 'remontnik-outside': '10.9.0.5' }).docker })).rejects.toThrow(/remontnik-app/)
    expect(existsSync(stateDir)).toBe(false)
  })
})
