import { describe, expect, it } from 'vitest'
import {
  BUILT_IN_FORBIDDEN,
  RemontnikConfigError,
  defineRemontnikConfig,
  type RemontnikConfigInput,
} from './index.js'

function minimalConfig(): RemontnikConfigInput {
  return {
    app: { name: 'patient' },
    repo: { mainBranch: 'main' },
    workbench: { image: 'node:22', install: 'pnpm install --frozen-lockfile' },
    checks: { test: 'pnpm test' },
    evalScope: [],
    closedPaths: [],
    forbidden: {
      schema: ['db/migrations/**'],
      money: ['src/payments/**'],
      access: ['src/auth/**'],
    },
    deploy: {
      commands: {
        build: 'deploy build',
        promote: 'deploy promote',
        confirm: 'deploy confirm',
        rollback: 'deploy rollback',
        current: 'deploy current',
        health: 'deploy health',
      },
      lockFile: '.deploy/deploy.lock',
    },
    reports: { telegram: { botTokenEnv: 'ALERT_BOT_TOKEN', chatIdEnv: 'ALERT_CHAT_ID' } },
  }
}

function errorOf(action: () => unknown): RemontnikConfigError {
  try {
    action()
  } catch (error) {
    if (error instanceof RemontnikConfigError) return error
    throw error
  }
  throw new Error('настройка принята, а ждали ошибку')
}

describe('defineRemontnikConfig', () => {
  it('принимает минимальную настройку и подставляет значения по умолчанию', () => {
    const config = defineRemontnikConfig(minimalConfig())

    const { app } = config
    expect(app.timeZone).toBe('UTC')
    expect(config.repo.mainline).toBe('merge')
    expect(config.workbench.bashTimeoutMs).toBe(600_000)
    expect(config.forbidden.allowDependencyChanges).toBe(false)
    expect(config.forbidden.allowBuildAndDeployChanges).toBe(false)
    expect(config.observe).toEqual({
      windowMinutes: 30,
      healthFailuresToRollback: 3,
      errorRateFactor: 3,
      minErrorsToRollback: 5,
      newFingerprintsToRollback: 3,
    })
    expect(config.limits).toMatchObject({
      modelUsdPerDay: 5,
      evalUsdPerDay: 5,
      autoDeploysPerFingerprintPerDay: 2,
      autoDeploysPerDay: 5,
      maxDiffLines: 300,
      maxDiffFiles: 15,
    })
    expect(config.handoff).toEqual({ mode: 'self' })
  })

  it('fixablePaths: по умолчанию src/**, можно свои, пустой список — ошибка', () => {
    expect(defineRemontnikConfig(minimalConfig()).fixablePaths).toEqual(['src/**'])
    expect(defineRemontnikConfig({ ...minimalConfig(), fixablePaths: ['app/**', 'lib/**'] }).fixablePaths).toEqual(['app/**', 'lib/**'])
    expect(errorOf(() => defineRemontnikConfig({ ...minimalConfig(), fixablePaths: [] })).issues.some((issue) => issue.startsWith('fixablePaths'))).toBe(true)
  })

  it('подставляет значения по умолчанию для eval, review и Paseo', () => {
    const input = minimalConfig()
    input.checks.eval = { run: 'eval {scenarios}', resultFile: 'result.json', env: ['EVAL_MODE'] }
    input.review = { botDescription: 'бот помогает с тарифами' }
    input.handoff = {
      mode: 'paseo-first',
      paseo: { bridgeUrlEnv: 'BRIDGE_URL', bridgeSecretEnv: 'BRIDGE_SECRET', listenEnv: 'BRIDGE_LISTEN' },
    }

    const config = defineRemontnikConfig(input)

    expect(config.checks.eval).toMatchObject({ repeat: 3, maxScenarios: 3, providers: [], tokenEnv: 'REMONTNIK_EVAL_TOKEN' })
    expect(config.limits.evalUsdPerCase).toBe(1)
    expect(config.review?.minConfidence).toBe(0.7)
    expect(config.handoff.paseo).toMatchObject({ acceptTimeoutMs: 300_000, workTimeoutMs: 3_600_000 })
  })

  it('провайдеры модели для eval: ключ — имя переменной у врача, в контейнер идут адрес прокси и токен', () => {
    const input = minimalConfig()
    input.checks.eval = {
      run: 'eval {scenarios}',
      resultFile: 'result.json',
      env: ['EVAL_MODE'],
      providers: [{ name: 'chat', baseUrlEnv: 'CHAT_BASE_URL', keyEnv: 'CHAT_API_KEY', upstream: 'https://api.example.com/v1', priceUsdPerMTok: { input: 0.5, output: 2 } }],
    }
    const config = defineRemontnikConfig(input)
    expect(config.checks.eval?.providers[0]).toMatchObject({ name: 'chat', authHeader: 'authorization' })
  })

  it.each([
    ['ключ в eval.env', { env: ['EVAL_API_KEY'] }],
    ['токен в eval.env', { env: ['BOT_TOKEN'] }],
    ['пароль в eval.env', { env: ['DB_PASSWORD'] }],
    ['секрет в eval.env', { env: ['APP_SECRET'] }],
    ['переменная ключа провайдера в eval.env', { env: ['CHAT_KEY_NAME'], providers: [{ name: 'chat', baseUrlEnv: 'CHAT_BASE_URL', keyEnv: 'CHAT_KEY_NAME', upstream: 'https://api.example.com/v1', priceUsdPerMTok: { input: 1, output: 1 } }] }],
    ['имя провайдера не для адреса', { env: [], providers: [{ name: 'Chat/../x', baseUrlEnv: 'CHAT_BASE_URL', keyEnv: 'CHAT_API_KEY', upstream: 'https://api.example.com/v1', priceUsdPerMTok: { input: 1, output: 1 } }] }],
  ])('отклоняет %s: секреты eval идут только через прокси', (_what, extra) => {
    const input = minimalConfig()
    input.checks.eval = { run: 'eval {scenarios}', resultFile: 'result.json', ...extra } as NonNullable<RemontnikConfigInput['checks']['eval']>
    expect(errorOf(() => defineRemontnikConfig(input)).issues.some((issue) => issue.startsWith('checks.eval'))).toBe(true)
  })

  it('принимает все разделы контракта, включая браузер с живым экраном', () => {
    const input = minimalConfig()
    input.browser = {
      enabled: true,
      profile: 'patient',
      allowedOrigins: ['https://app.example.com'],
      allowedMutations: [{ method: 'POST', pathPattern: '/api/chat' }],
      pagesToCheck: [{ url: 'https://app.example.com/chat', expectText: 'Чат' }],
      loginEntryId: 1,
      live: { enabled: true, linkEnv: 'BROWSER_LIVE_LINK' },
    }
    input.evalScope = [{ paths: ['src/bot/**'], scenarios: 'all' }]

    const config = defineRemontnikConfig(input)

    expect(config.browser?.live).toEqual({ enabled: true, linkEnv: 'BROWSER_LIVE_LINK' })
    expect(config.evalScope[0]?.scenarios).toBe('all')
  })

  it.each(['schema', 'money', 'access'] as const)('отклоняет пустой forbidden.%s', (zone) => {
    const input = minimalConfig()
    input.forbidden[zone] = []

    const error = errorOf(() => defineRemontnikConfig(input))

    expect(error.issues.some((issue) => issue.startsWith(`forbidden.${zone}`))).toBe(true)
    expect(error.message).toContain(`forbidden.${zone}`)
  })

  it('принимает явное «<нет>» вместо масок', () => {
    const input = minimalConfig()
    input.forbidden.schema = ['<нет>']

    expect(defineRemontnikConfig(input).forbidden.schema).toContain('<нет>')
  })

  it('всегда добавляет встроенные запреты к маскам приложения', () => {
    const config = defineRemontnikConfig(minimalConfig())

    expect(config.forbidden.access).toEqual(expect.arrayContaining(['src/auth/**', ...BUILT_IN_FORBIDDEN.accessMasks]))
    expect(config.forbidden.builtIn).toBe(BUILT_IN_FORBIDDEN)
    expect(BUILT_IN_FORBIDDEN.accessMasks).toEqual(
      expect.arrayContaining(['**/.env*', '**/*.env', '**/*.pem', '**/*.key', '**/*secret*', '**/*credential*']),
    )
    expect(BUILT_IN_FORBIDDEN.agentChatSdkMasks.length).toBeGreaterThan(0)
    expect(BUILT_IN_FORBIDDEN.remontnikMasks).toEqual(expect.arrayContaining(['**/remontnik.config.*', '**/.remontnik*', '**/.remontnik*/**']))
    expect(BUILT_IN_FORBIDDEN.protectedPackages).toEqual(
      expect.arrayContaining(['@ykurilov/agent-chat-*', '@ykurilov/remontnik-*']),
    )
    expect(BUILT_IN_FORBIDDEN.schemaSignals.some((signal) => signal.test('ALTER TABLE users'))).toBe(true)
  })

  it('не даёт убрать встроенные запреты настройкой', () => {
    const input = minimalConfig() as unknown as { forbidden: Record<string, unknown> }
    input.forbidden.builtIn = { accessMasks: [] }

    const error = errorOf(() => defineRemontnikConfig(input as unknown as RemontnikConfigInput))
    expect(error.message).toContain('forbidden')
  })

  it('встроенные запреты нельзя поменять после проверки', () => {
    const config = defineRemontnikConfig(minimalConfig())

    expect(Object.isFrozen(BUILT_IN_FORBIDDEN)).toBe(true)
    expect(Object.isFrozen(BUILT_IN_FORBIDDEN.accessMasks)).toBe(true)
    expect(() => (BUILT_IN_FORBIDDEN.accessMasks as string[]).pop()).toThrow()
    expect(Object.isFrozen(config.forbidden)).toBe(true)
  })

  it('разрешения на зависимости и выкатку не снимают встроенные запреты', () => {
    const input = minimalConfig()
    input.forbidden.allowDependencyChanges = true
    input.forbidden.allowBuildAndDeployChanges = true

    const config = defineRemontnikConfig(input)

    expect(config.forbidden.builtIn.protectedPackages).toContain('@ykurilov/remontnik-*')
    expect(config.forbidden.access).toEqual(expect.arrayContaining([...BUILT_IN_FORBIDDEN.accessMasks]))
  })

  it('требует раздел paseo в режиме «сначала Paseo»', () => {
    const input = minimalConfig()
    input.handoff = { mode: 'paseo-first' }

    expect(errorOf(() => defineRemontnikConfig(input)).message).toContain('handoff.paseo')
  })

  it('отклоняет неизвестные поля, чтобы опечатка не прошла молча', () => {
    const input = { ...minimalConfig(), deploi: {} } as unknown as RemontnikConfigInput

    expect(errorOf(() => defineRemontnikConfig(input)).message).toContain('deploi')
  })

  it('отклоняет значение секрета вместо имени переменной окружения', () => {
    const input = minimalConfig()
    input.reports.telegram.botTokenEnv = '12345:abc-secret'

    expect(errorOf(() => defineRemontnikConfig(input)).message).toContain('reports.telegram.botTokenEnv')
  })

  it('отклоняет неизвестный часовой пояс', () => {
    const input = minimalConfig()
    Object.assign(input, { app: { name: 'patient', timeZone: 'Mars/Olympus' } })

    expect(errorOf(() => defineRemontnikConfig(input)).message).toContain('app.timeZone')
  })

  it('собирает все ошибки в одно понятное сообщение', () => {
    const error = errorOf(() => defineRemontnikConfig({} as RemontnikConfigInput))

    expect(error.issues.length).toBeGreaterThan(3)
    expect(error.message).toMatch(/^Настройка Ремонтника/)
    expect(error.message).toContain('app')
    expect(error.message).toContain('deploy')
  })
})
