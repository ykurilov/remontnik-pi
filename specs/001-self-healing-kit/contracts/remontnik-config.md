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
      env: string[],                  // имена переменных окружения для eval (отдельные ключи с лимитом)
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
    modelUsdPerDay?: number,          // 5 (сторож + врач)
    evalUsdPerDay?: number,           // 5
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
    botDescription: string,           // что бот должен делать, для рубрики
    usdPerDay?: number,
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
- `fixablePaths` — белый список правки. Врач проверяет и отправляет правку, только если она меняет код по этим маскам и добавляет новые тесты по маскам тестов (`*.test.*`, `*.spec.*`, `*_test.*`, `*-test.*`, `test_*.py`, папки `test/`, `tests/`, `__tests__/`). Новые файлы в `__mocks__/`, `__fixtures__/`, `fixtures/`, `__snapshots__/` — не новый тест. Всё остальное — «нужен человек» со списком файлов: существующие тесты, настройки запуска тестов и eval, `package.json`, файлы-замки, `.npmrc`, `pnpm-workspace.yaml`, `.pnpmfile.cjs`, `tsconfig*`, `.env*`, сборка, выкатка, сам Ремонтник. Настройки установки, компилятора и окружения защищены и внутри `fixablePaths`. Флаги `allow*` эту защиту не снимают.
