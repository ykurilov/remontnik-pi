import { z } from 'zod'

// Настройка приложения `remontnik.config.ts` (contracts/remontnik-config.md).
// Секретов в файле нет: только имена переменных окружения. Встроенные запреты (R7) добавляются всегда.

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !(value instanceof RegExp) && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const item of Object.values(value)) deepFreeze(item)
  }
  return value
}

/** Запреты, которые нельзя убрать настройкой. Маски — glob от корня репозитория, без учёта регистра. */
export const BUILT_IN_FORBIDDEN = deepFreeze({
  /** Доступы и ключи: добавляются к `forbidden.access` приложения. */
  accessMasks: ['**/.env*', '**/*.env', '**/*secret*', '**/*credential*', '**/*.pem', '**/*.key'],
  /** Код Agent Chat SDK и его патчи. */
  agentChatSdkMasks: [
    '**/node_modules/@ykurilov/agent-chat-*/**',
    'patches/@ykurilov__agent-chat-*',
    'patches/@ykurilov+agent-chat-*',
  ],
  /** Сам Ремонтник: его настройку и служебные файлы правит только человек. */
  remontnikMasks: ['remontnik.config.*', '**/remontnik.config.*', '.remontnik*', '**/.remontnik*', '.remontnik*/**', '**/.remontnik*/**'],
  /** Пакеты, чьи версии и патчи (`pnpm.patchedDependencies`) менять нельзя даже при `allowDependencyChanges`. */
  protectedPackages: ['@ykurilov/agent-chat-*', '@ykurilov/remontnik-*'],
  /** Признаки изменения схемы базы в диффе файлов `schemaSignalFiles`. */
  schemaSignals: [/\bCREATE\s+TABLE\b/i, /\bALTER\s+TABLE\b/i, /\bDROP\b/i],
  schemaSignalFiles: ['**/*.sql'],
})

export type BuiltInForbidden = typeof BUILT_IN_FORBIDDEN

/** Запреты по умолчанию, которые приложение может снять флагами `allow*` в `forbidden`. */
export const DEFAULT_FORBIDDEN = deepFreeze({
  /** Снимается `allowDependencyChanges`: зависимости в `package.json` и файлы-замки. */
  dependencyMasks: ['**/pnpm-lock.yaml', '**/package-lock.json', '**/yarn.lock', '**/bun.lock', '**/bun.lockb'],
  /** Снимается `allowBuildAndDeployChanges`: сборка, выкатка, CI. */
  buildAndDeployMasks: [
    '**/Dockerfile',
    '**/Dockerfile.*',
    '**/*.dockerfile',
    '**/compose*.yml',
    '**/compose*.yaml',
    '**/docker-compose*.yml',
    '**/docker-compose*.yaml',
    '.github/**',
    'deploy/**',
  ],
})

const envName = z
  .string()
  .regex(/^[A-Z][A-Z0-9_]*$/, 'ожидается имя переменной окружения (A-Z, 0-9, _), а не её значение')
const command = z.string().trim().min(1)
const masks = z.array(z.string().trim().min(1)).min(1, 'маски не могут быть пустыми; если зоны нет — ["<нет>"]')
const positiveInt = z.number().int().positive()
const positiveNumber = z.number().positive()

const timeZone = z.string().refine((value) => {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value })
    return true
  } catch {
    return false
  }
}, 'неизвестный часовой пояс')

// Ключи провайдеров модели остаются у врача: eval ходит к модели через его прокси (адрес в `baseUrlEnv`,
// токен прогона вместо ключа в `keyEnv`). Поэтому в `env` — только несекретные переменные. Фильтр по имени —
// подсказка против ошибки, а не гарантия: секрет под невинным именем он не узнает.
const SECRET_LIKE_ENV = /KEY|TOKEN|SECRET|PASS|AUTH|CREDENTIAL|PRIVATE|URL|DSN|COOKIE|SESSION/

/** Цена модели в долларах за миллион токенов. */
const modelPriceSchema = z.strictObject({ input: z.number().nonnegative(), output: z.number().nonnegative() })

const evalProviderSchema = z.strictObject({
  name: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, 'строчные латинские буквы, цифры и дефис: имя идёт в адрес прокси'),
  baseUrlEnv: envName,
  keyEnv: envName,
  upstream: z.url(),
  authHeader: z.enum(['authorization', 'x-api-key']).default('authorization'),
  /** Белый список моделей с ценами: модель выбирает код правки, поэтому цена — по модели, чужая модель — отказ. */
  models: z.record(z.string().min(1), modelPriceSchema).refine((models) => Object.keys(models).length > 0, 'хотя бы одна модель с ценой'),
})

/** Пределы прокси eval на один прогон: память врача и бронь запросов в пути. */
const evalProxyLimitsSchema = z
  .strictObject({
    maxRequestBytes: positiveInt.default(2 * 1024 * 1024),
    maxResponseBytes: positiveInt.default(8 * 1024 * 1024),
    maxConcurrentRequests: positiveInt.default(4),
    /** Подставляется в запрос без предела ответа: без него наибольшую цену запроса не посчитать. */
    maxOutputTokens: positiveInt.default(4096),
  })
  .prefault({})

const evalSchema = z
  .strictObject({
    run: command,
    resultFile: z.string().min(1),
    repeat: positiveInt.default(3),
    maxScenarios: positiveInt.default(3),
    env: z.array(envName),
    providers: z.array(evalProviderSchema).default([]),
    tokenEnv: envName.default('REMONTNIK_EVAL_TOKEN'),
    proxy: evalProxyLimitsSchema,
  })
  .superRefine((evalConfig, context) => {
    const proxyNames = new Set([evalConfig.tokenEnv, ...evalConfig.providers.flatMap((provider) => [provider.keyEnv, provider.baseUrlEnv])])
    evalConfig.env.forEach((name, index) => {
      if (SECRET_LIKE_ENV.test(name) || proxyNames.has(name)) {
        context.addIssue({ code: 'custom', path: ['env', index], message: 'секрет в eval не передаётся: ключи модели — через providers и прокси врача' })
      }
    })
    const names = evalConfig.providers.map((provider) => provider.name)
    if (new Set(names).size !== names.length) context.addIssue({ code: 'custom', path: ['providers'], message: 'имена провайдеров повторяются' })
  })

const paseoSchema = z.strictObject({
  bridgeUrlEnv: envName,
  bridgeSecretEnv: envName,
  listenEnv: envName,
  acceptTimeoutMs: positiveInt.default(300_000),
  workTimeoutMs: positiveInt.default(3_600_000),
})

const handoffSchema = z
  .strictObject({
    mode: z.enum(['self', 'paseo-first']),
    paseo: paseoSchema.optional(),
  })
  .superRefine((handoff, context) => {
    if (handoff.mode === 'paseo-first' && !handoff.paseo) {
      context.addIssue({ code: 'custom', path: ['paseo'], message: 'обязателен в режиме "paseo-first"' })
    }
  })

const browserSchema = z.strictObject({
  enabled: z.boolean(),
  profile: z.string().min(1),
  allowedOrigins: z.array(z.url()),
  allowedMutations: z.array(z.strictObject({ method: z.string().min(1), pathPattern: z.string().min(1) })),
  pagesToCheck: z.array(z.strictObject({ url: z.url(), expectText: z.string().optional() })),
  loginEntryId: positiveInt.optional(),
  live: z.strictObject({ enabled: z.boolean(), linkEnv: envName }).optional(),
})

export const remontnikConfigSchema = z.strictObject({
  app: z.strictObject({
    name: z.string().trim().min(1),
    timeZone: timeZone.default('UTC'),
  }),
  repo: z.strictObject({
    mainBranch: z.string().trim().min(1),
    mainline: z.enum(['merge', 'pull-request']).default('merge'),
  }),
  workbench: z.strictObject({
    image: z.string().trim().min(1),
    install: command,
    bashTimeoutMs: positiveInt.default(600_000),
  }),
  checks: z.strictObject({
    test: command,
    typecheck: command.optional(),
    services: z.string().min(1).optional(),
    eval: evalSchema.optional(),
  }),
  evalScope: z.array(
    z.strictObject({
      paths: z.array(z.string().min(1)).min(1),
      scenarios: z.union([z.literal('all'), z.array(z.string().min(1)).min(1)]),
    }),
  ),
  closedPaths: z.array(z.string().min(1)),
  /** Где правка врача может менять код; всё остальное, кроме новых тестов, — только человек. */
  fixablePaths: z.array(z.string().trim().min(1)).min(1, 'хотя бы одна маска; по умолчанию ["src/**"]').default(['src/**']),
  forbidden: z.strictObject({
    schema: masks,
    money: masks,
    access: masks,
    extra: z.array(z.string().trim().min(1)).optional(),
    allowDependencyChanges: z.boolean().default(false),
    allowBuildAndDeployChanges: z.boolean().default(false),
  }),
  deploy: z.strictObject({
    commands: z.strictObject({
      build: command,
      promote: command,
      confirm: command,
      rollback: command,
      current: command,
      health: command,
    }),
    lockFile: z.string().min(1),
  }),
  observe: z
    .strictObject({
      windowMinutes: positiveInt.default(30),
      healthFailuresToRollback: positiveInt.default(3),
      errorRateFactor: positiveNumber.default(3),
      minErrorsToRollback: positiveInt.default(5),
      newFingerprintsToRollback: positiveInt.default(3),
    })
    .prefault({}),
  limits: z
    .strictObject({
      modelUsdPerDay: z.number().nonnegative().default(5),
      evalUsdPerDay: z.number().nonnegative().default(5),
      /** Доля дневного бюджета eval на один случай: столько бронирует проверка правки. */
      evalUsdPerCase: z.number().nonnegative().default(1),
      autoDeploysPerFingerprintPerDay: z.number().int().nonnegative().default(2),
      autoDeploysPerDay: z.number().int().nonnegative().default(5),
      maxDiffLines: positiveInt.default(300),
      maxDiffFiles: positiveInt.default(15),
      diagnoseUsdPerCase: z.number().nonnegative().optional(),
    })
    .prefault({}),
  reports: z.strictObject({
    telegram: z.strictObject({
      botTokenEnv: envName,
      chatIdEnv: envName.optional(),
      apiBaseUrlEnv: envName.optional(),
      proxyTokenEnv: envName.optional(),
    }),
  }),
  handoff: handoffSchema.prefault({ mode: 'self' }),
  review: z
    .strictObject({
      botDescription: z.string().trim().min(1),
      usdPerDay: z.number().nonnegative().optional(),
      minConfidence: z.number().min(0).max(1).default(0.7),
    })
    .optional(),
  browser: browserSchema.optional(),
})

/** То, что пишет приложение в `remontnik.config.ts`. */
export type RemontnikConfigInput = z.input<typeof remontnikConfigSchema>

type ParsedConfig = z.output<typeof remontnikConfigSchema>

export type ResolvedForbidden = ParsedConfig['forbidden'] & {
  /** Встроенные запреты R7; всегда действуют. */
  readonly builtIn: BuiltInForbidden
}

/** Проверенная настройка: значения по умолчанию подставлены, встроенные запреты добавлены, объект заморожен. */
export type RemontnikConfig = Readonly<Omit<ParsedConfig, 'forbidden'> & { forbidden: ResolvedForbidden }>

export class RemontnikConfigError extends Error {
  /** Ошибки по полям: `путь: что не так`. */
  readonly issues: string[]

  constructor(issues: string[]) {
    super(`Настройка Ремонтника (remontnik.config) с ошибками:\n${issues.map((issue) => `- ${issue}`).join('\n')}`)
    this.name = 'RemontnikConfigError'
    this.issues = issues
  }
}

function describeIssue(issue: z.core.$ZodIssue): string {
  const path = issue.path.map(String).join('.') || '(корень)'
  if (issue.code === 'unrecognized_keys') return `${path}: неизвестные поля ${issue.keys.join(', ')}`
  return `${path}: ${issue.message}`
}

/**
 * Проверяет настройку приложения и падает с понятной ошибкой.
 * Принимает и непроверенное значение — врач читает файл из основной ветки сам.
 */
export function defineRemontnikConfig(input: RemontnikConfigInput): RemontnikConfig {
  const parsed = remontnikConfigSchema.safeParse(input)
  if (!parsed.success) throw new RemontnikConfigError(parsed.error.issues.map(describeIssue))

  const config = parsed.data
  const forbidden: ResolvedForbidden = {
    ...config.forbidden,
    access: [...new Set([...config.forbidden.access, ...BUILT_IN_FORBIDDEN.accessMasks])],
    builtIn: BUILT_IN_FORBIDDEN,
  }
  return deepFreeze({ ...config, forbidden })
}
