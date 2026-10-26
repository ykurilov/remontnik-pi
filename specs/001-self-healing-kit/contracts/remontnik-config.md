# Контракт: настройка приложения `remontnik.config.ts`

Файл лежит в корне репозитория приложения. Врач читает его **только из основной ветки** (R7). Секретов в файле нет: только имена переменных окружения.

```ts
import { defineRemontnikConfig } from "@ykurilov/remontnik-core/config";

export default defineRemontnikConfig({
  app: {
    name: string,                     // короткое имя для отчётов
    timeZone?: string,                // сутки для лимитов; по умолчанию "UTC"
  },
  repo: {
    mainBranch: string,               // например "main"
    mainline?: "merge" | "pull-request", // как правка попадает в основную ветку; по умолчанию "merge"
  },
  workbench: {
    image: string,                    // образ разработки приложения (Node, pnpm)
    install: string,                  // команда установки зависимостей
    bashTimeoutMs?: number,           // по умолчанию 600_000
  },
  checks: {
    test: string,                     // команда тестов; код выхода 0 = зелёные
    typecheck?: string,
    services?: string,                // файл compose со службами для тестов (например, временная база)
    eval?: {
      run: string,                    // шаблон: подставляются {scenarios} {repeat} {maxCostUsd} {outDir}
      resultFile: string,             // путь к итогу в {outDir}, формат — deploy-commands.md
      repeat: number,                 // по умолчанию 3
      maxScenarios: number,           // по умолчанию 3
      env: string[],                  // имена обычных переменных для eval; имена с KEY, TOKEN, SECRET, PASS, AUTH, CREDENTIAL,
                                      // PRIVATE, URL, DSN, COOKIE, SESSION — отказ (подсказка от ошибки, не гарантия)
      providers?: Array<{             // модели, к которым eval ходит через прокси врача; по умолчанию []
        name: string,                 // латиница, цифры, дефис; без повторов
        baseUrlEnv: string,           // переменная, в которой eval получит адрес прокси
        keyEnv: string,               // переменная с настоящим ключом у врача; eval получает в ней разовый пропуск
        upstream: string,             // настоящий адрес API модели
        authHeader?: "authorization" | "x-api-key", // по умолчанию "authorization"
        models: Record<string, { input: number, output: number }>, // белый список моделей с ценой за 1 млн токенов, $;
                                      // не пустой; модели нет в списке — прокси отвечает 403
      }>,
      tokenEnv?: string,              // переменная с разовым пропуском; по умолчанию REMONTNIK_EVAL_TOKEN
      proxy?: {                       // пределы прокси модели на прогон eval
        maxRequestBytes?: number,     // 2 МБ; больше — 413
        maxResponseBytes?: number,    // 8 МБ; ответ читается потоком и обрывается на пределе
        maxConcurrentRequests?: number, // 4; лишние — 429
        maxOutputTokens?: number,     // 4096; вставляется в запрос без предела ответа и идёт в бронь запроса
      },
    },
  },
  evalScope: Array<{ paths: string[]; scenarios: string[] | "all" }>,
  closedPaths: string[],              // не попадают в рабочую копию врача, не запускаются
  fixablePaths?: string[],            // где правка врача может менять код; по умолчанию ["src/**"]
  forbidden: {
    schema: string[],                 // маски путей
    money: string[],
    access: string[],
    extra?: string[],                 // дополнительные запреты приложения
    allowDependencyChanges?: boolean, // по умолчанию false
    allowBuildAndDeployChanges?: boolean, // по умолчанию false
  },
  deploy: {
    commands: {                       // контракт — deploy-commands.md
      build: string, promote: string, confirm: string,
      rollback: string, current: string, health: string,
    },
    lockFile: string,                 // общий с ручной выкаткой
  },
  observe?: {
    windowMinutes?: number,           // 30
    healthFailuresToRollback?: number,// 3
    errorRateFactor?: number,         // 3
    minErrorsToRollback?: number,     // 5
    newFingerprintsToRollback?: number, // 3
  },
  limits?: {
    watchModelUsdPerDay?: number,     // 1; потолок модели сторожа (чтение разговоров), свой
    doctorModelUsdPerDay?: number,    // 4; потолок модели врача, свой; вместе со сторожем $5, общего счётчика нет
    evalUsdPerDay?: number,           // 5
    evalUsdPerCase?: number,          // 1; доля одного случая, больше прокси не пропустит
    autoDeploysPerFingerprintPerDay?: number, // 2
    autoDeploysPerDay?: number,       // 5
    maxDiffLines?: number,            // 300
    maxDiffFiles?: number,            // 15
    diagnoseUsdPerCase?: number,      // потолок на поиск причины одного случая
  },
  reports: {
    telegram: {
      botTokenEnv: string,            // имя переменной с токеном бота тревог приложения
      chatIdEnv?: string,             // либо имя переменной с чатом,
      // либо чат отдаёт приложение через сторожа (resolveChatId в watch)
      apiBaseUrlEnv?: string,
      proxyTokenEnv?: string,
    },
  },
  handoff?: {                         // режим лечения, R18; по умолчанию { mode: "self" }
    mode: "self" | "paseo-first",
    paseo?: {                         // обязателен при "paseo-first"
      bridgeUrlEnv: string,           // имя переменной с адресом моста в частной сети
      bridgeSecretEnv: string,        // имя переменной с общим секретом моста
      listenEnv: string,              // имя переменной с адресом частной сети, где врач слушает мост
      acceptTimeoutMs?: number,       // 300_000
      workTimeoutMs?: number,         // 3_600_000
    },
  },
  review?: {                          // чтение законченных разговоров
    botDescription: string,           // что бот должен делать, для рубрики; потолок — limits.watchModelUsdPerDay
    minConfidence?: number,           // 0.7
  },
  browser?: {
    enabled: boolean,
    profile: string,
    allowedOrigins: string[],
    allowedMutations: Array<{ method: string; pathPattern: string }>,
    pagesToCheck: Array<{ url: string; expectText?: string }>,
    loginEntryId?: number,
    live?: {                          // живой экран, R12; только при частной сети
      enabled: boolean,
      linkEnv: string,                // имя переменной с адресом живого экрана в частной сети — для ссылок в отчётах
    },
  },
});
```

## Правила проверки

- `defineRemontnikConfig` проверяет схему и падает с понятной ошибкой на старте врача.
- Маски `forbidden.*` пустыми быть не могут: приложение обязано явно сказать, где у него схема, деньги и доступы. Если чего-то нет — пишется `["<нет>"]` с комментарием.
- Всегда добавляются встроенные запреты (R7), их нельзя убрать.
- Адреса в `allowedOrigins` и `pagesToCheck` в открытых примерах — только `https://app.example.com`.
- `fixablePaths` — белый список правки. Врач проверяет и отправляет правку, только если она меняет код по этим маскам и добавляет новые тесты по маскам тестов (`*.test.*`, `*.spec.*`, `*_test.*`, `*-test.*`, `test_*.py`, папки `test/`, `tests/`, `__tests__/`). Новый тест — только файл по маске файла теста; другой новый файл в `test/`, `tests/`, `__tests__/`, `e2e/` и новые файлы в `__mocks__/`, `__fixtures__/`, `fixtures/`, `__snapshots__/` — не новый тест. Обвязка тестов внутри `src` (`setupTests.*`, `test-utils.*`, `mocks/**`, `testing/**`, `globalSetup.*`) и конфиги сборки (`next.config.*`, `webpack.*`, `rollup.*`, `tsup.*`, `vite.*`, `.swcrc`, `.babelrc*`) защищены и внутри `fixablePaths`. Маски различают регистр, путь с `\` не проходит; непонятная маска — ошибка при загрузке настройки. Всё остальное — «нужен человек» со списком файлов: существующие тесты, настройки запуска тестов и eval, `package.json`, файлы-замки, `.npmrc`, `pnpm-workspace.yaml`, `.pnpmfile.cjs`, `tsconfig*`, `.env*`, сборка, выкатка, сам Ремонтник. Настройки установки, компилятора и окружения защищены и внутри `fixablePaths`. Флаги `allow*` эту защиту не снимают.
