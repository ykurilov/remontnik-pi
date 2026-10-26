# Подключение Ремонтника к приложению

Инструкция для агента приложения. Пройдите шаги по порядку. Каждый шаг кончается проверкой: она прошла — переходите к следующему.

Ремонтник код приложения не правит: всё ниже делает агент приложения в своём репозитории и на своём сервере. Полный список того, что приложение обязано дать, — [contracts/app-integration.md](../specs/001-self-healing-kit/contracts/app-integration.md). Все поля настройки — [configuration.md](./configuration.md). Что и почему закрыто — [security.md](./security.md).

Сначала спросите владельца только то, чего нельзя узнать из кода:

- репозиторий приложения на GitHub и имя основной ветки;
- сервер приложения и как там идёт ручная выкатка (скрипт, compose);
- чат Telegram для тревог и бот, от имени которого они идут;
- нужен ли браузер врача и режим «сначала Paseo».

Всё остальное — из кода приложения.

## 1. Пакеты

```sh
pnpm add @ykurilov/remontnik-watch @ykurilov/remontnik-core
```

Версии — точные, как во всём проекте. Врач (`@ykurilov/remontnik-doctor`) в приложение не ставится: он работает отдельным контейнером (шаг 7).

## 2. Сторож в коде

Сторож ловит падения и плохие ответы бота и шлёт их врачу. Он ставится в каждый процесс приложения: веб, фоновый работник и так далее.

```ts
import { createWatch } from '@ykurilov/remontnik-watch'

export const watch = createWatch({
  appName: 'my-app',                      // то же, что app.name в remontnik.config.ts
  processName: 'web',                     // у каждого процесса своё имя
  dir: process.env.REMONTNIK_WATCH_DIR!,  // папка очереди; общая для всех процессов приложения
  doctor: { url: process.env.REMONTNIK_DOCTOR_URL!, secret: process.env.REMONTNIK_SHARED_SECRET! },
  telegram: { botToken: process.env.APP_ALERT_BOT_TOKEN!, chatId: process.env.APP_ALERT_CHAT_ID! },
  release: process.env.REMONTNIK_VERSION ?? null,
})
watch.installProcessHandlers()
```

- `installProcessHandlers()` — сразу после создания: ловит `uncaughtException` и `unhandledRejection`. После записи процесс ведёт себя как без сторожа.
- При штатной остановке: `await watch.flush(5000)`, затем `watch.close()`.
- Ручная запись сбоя: `watch.capture(error, { where: 'billing-sync' })`.
- Ошибки обращений к моделям: оберните каталог моделей `watch.wrapModelCatalog(catalog)`.
- `REMONTNIK_DOCTOR_URL` — `http://remontnik-doctor:7800`: врач слушает в сети Docker приложения (шаг 7).
- `createWatch` требует адрес врача и секрет сразу и без них бросает `TypeError`. Тесты, которые запускают процесс приложения, и локальный запуск должны задавать эти переменные (любые значения, свою папку очереди) — иначе приложение не стартует.
- Для подставного Telegram (тесты, стенд) в `telegram` есть необязательное поле `apiBaseUrl`; в боевом окружении его не задают.

**Agent Chat SDK.** Если в приложении стоит наш SDK чата, подключите хуки сторожа поверх своих:

```ts
import { agentChatWatchHooks } from '@ykurilov/remontnik-watch/agent-chat'

const hooks = agentChatWatchHooks(watch, { inner: appHooks, afterTurn: true })
```

`afterTurn: true` — только если хранилище SDK умеет `setAfterTurnState`. Иначе не включайте.

**Чтение разговоров.** Сторож может читать законченные разговоры и замечать плохие ответы бота. Для этого:

- в `createWatch` добавьте `model` (ключи DeepSeek и OpenRouter приложения) и `review` (`botDescription` — что бот должен делать, `limits: config.limits` — дневной потолок `watchModelUsdPerDay`);
- там, где разговор закрывается, вызовите `watch.conversationFinished({ id, messages })`.

Проверка: тест приложения бросает ошибку в процессе со сторожем — в папке очереди появляется запись, `watch.stats()` показывает её в очереди.

## 3. Настройка `remontnik.config.ts`

Файл в корне репозитория. Врач читает его только из основной ветки. Секретов в нём нет: только имена переменных окружения.

```ts
import { defineRemontnikConfig } from '@ykurilov/remontnik-core/config'

export default defineRemontnikConfig({
  app: { name: 'my-app', timeZone: 'UTC' },
  repo: { mainBranch: 'main' },
  workbench: { image: 'node:22', install: 'pnpm install --frozen-lockfile' },
  checks: { test: 'pnpm test', typecheck: 'pnpm typecheck' },
  evalScope: [],
  closedPaths: [],
  fixablePaths: ['src/**'],
  forbidden: {
    schema: ['src/db/schema/**', 'migrations/**'],
    money: ['src/billing/**'],
    access: ['src/auth/**'],
  },
  deploy: {
    commands: {
      build: 'deploy/remontnik.sh build',
      promote: 'deploy/remontnik.sh promote',
      confirm: 'deploy/remontnik.sh confirm',
      rollback: 'deploy/remontnik.sh rollback',
      current: 'deploy/remontnik.sh current',
      health: 'deploy/remontnik.sh health',
    },
    lockFile: '.remontnik/deploy.lock',
  },
  reports: { telegram: { botTokenEnv: 'APP_ALERT_BOT_TOKEN', chatIdEnv: 'APP_ALERT_CHAT_ID' } },
})
```

Как заполнять:

- `forbidden.schema`, `money`, `access` — где у приложения схема базы, деньги и доступы. Найдите это в коде сами. Пустыми маски быть не могут: зоны нет — пишите `['<нет>']` с комментарием.
- `fixablePaths` — где врач может править код. Узко, только код приложения. Тесты, сборка, выкатка и файлы-замки сюда не входят.
- `closedPaths` — что врач не должен видеть вовсе: личные данные, выгрузки.
- `workbench.image` — образ с той же версией Node, что у приложения. `install` для npm — `npm ci`.

Проверка: `remontnik.config.ts` входит в `include` вашего `tsconfig.json` (иначе `tsc` его не видит), `pnpm exec tsc --noEmit` проходит, а импорт файла не бросает `RemontnikConfigError`.

## 4. Команды выкатки

Врач выкатывает и откатывает командами приложения. Договор — [deploy-commands.md](../specs/001-self-healing-kit/contracts/deploy-commands.md). Коротко:

| Команда | Что должна делать |
|---|---|
| `build` | собрать кандидата из рабочей копии правки; версия — в `REMONTNIK_VERSION`. Код правки выполняется только внутри сборки контейнера. Работающую версию не трогает |
| `promote` | сохранить текущую сборку как прежнюю и запустить кандидата. Выйти с кодом 0, только когда кандидат уже отвечает: сразу после `promote` врач проверяет здоровье и страницы |
| `confirm` | снять отметку «выкатка не подтверждена» |
| `rollback` | вернуть прежнюю сборку, без git и без сети |
| `current` | напечатать `{"version":"<полный sha>","previous":"<sha>"\|null}` — что реально работает |
| `health` | код 0 — здоров; не дольше 30 секунд |

- Команды врач запускает внутри своего контейнера, в рабочей копии основной ветки (или в копии правки для `build`). Там есть `sh`, Node 22, `git` и клиент Docker с compose; нет `curl`, `pnpm` и пакетов приложения. Пишите команды на этом наборе. Папки и файлы, которые команды читают и пишут вне копии, смонтируйте в контейнер врача по тем же путям, что на хосте (том в `deploy/compose.remontnik.yml`).
- Смена ссылки на версию должна быть атомарной: сначала новая ссылка рядом, потом переименование поверх старой. На Linux это `mv -T`, на macOS — `mv -h`. Обычный `mv` на macOS, если старая ссылка ведёт в папку, кладёт новую внутрь папки.
- Замок `deploy.lockFile` — общий с ручной выкаткой. Ручной скрипт создаёт его атомарно (`set -o noclobber`) и удаляет в конце.
- Файлы состояния, которые пишут `promote` и `rollback`, — в `.gitignore`.
- `build` видит только `PATH`, пустой `HOME`, `REMONTNIK_VERSION` и имена из `deploy.buildEnv`. Остальное он берёт из своих файлов на сервере.
- Остальным командам врач передаёт своё окружение без секретов: имена с `URL`, `KEY`, `TOKEN`, `SECRET` и подобными убраны. Адреса (например, проверки здоровья) команды берут из своего файла на сервере. Пример — выкатка «Пациента» `apps/patient/deploy/remontnik-deploy.ts`: адреса здоровья и версии лежат в `settings.json` папки выкаток, `promote` и `rollback` ждут, пока приложение ответит новой версией.

Проверка: на сервере вручную `build` → `promote` → `current` показывает новую версию → `rollback` → `current` показывает прежнюю.

## 5. Eval и службы для тестов

**Eval** — если у приложения есть сценарии с настоящей моделью. В `checks.eval`:

- `run` — шаблон команды с `{scenarios}`, `{repeat}`, `{maxCostUsd}`, `{outDir}`;
- `resultFile` — итог в формате договора;
- `providers` — модели, к которым eval ходит через прокси врача. Настоящий ключ лежит у врача под именем `keyEnv`. Eval получает в той же переменной разовый пропуск, а в `baseUrlEnv` — адрес прокси;
- `env` — только несекретные переменные.

Для eval заведите отдельный ключ модели с маленьким лимитом и отдельную базу для прогонов. `evalScope` связывает пути кода со сценариями.

**Службы для тестов** — если тестам нужна база. Файл compose в репозитории, путь — в `checks.services`. Правила:

- образ закреплён по отпечатку: `postgres:17-alpine@sha256:<64 знака>` (отпечаток — `docker buildx imagetools inspect postgres:17-alpine`);
- без портов, томов, сетей и `env_file`; база — с `healthcheck`;
- вместо `$` пишите `$$`;
- файл не должен попадать в `fixablePaths`.

Тесты ходят к базе по имени службы (`db:5432`). Пример — в [configuration.md](./configuration.md#службы-для-тестов).

Проверка: `pnpm test` зелёный в чистой копии; `remontnik-doctor check-config` (шаг 8) не ругается на службы.

## 6. Окружение сервера

Секреты — только в окружении сервера. Ни в репозитории, ни в чате, ни в настройке их нет. Владелец передаёт их через `secret-handoff`: значение вводится в скрытом окне и ложится файлом на сервер. В инструкциях и отчётах — только имена.

Два файла окружения, оба с правами `0600`, вне репозитория.

**Врач** (`REMONTNIK_ENV_FILE`):

| Переменная | Что это |
|---|---|
| `REMONTNIK_SHARED_SECRET` | общий секрет сторожа и врача; тот же — в окружении приложения |
| `REMONTNIK_CONTROL_SECRET` | секрет владельца: снимает стоп-кран и «нужен человек». Отличается от общего. Приложению не выдаётся |
| `REMONTNIK_GIT_TOKEN` | ключ git врача: только этот репозиторий, право записи, не личный ключ владельца |
| `DEEPSEEK_API_KEY`, `OPENROUTER_API_KEY` | ключи модели врача |
| `APP_ALERT_BOT_TOKEN`, `APP_ALERT_CHAT_ID` | бот и чат тревог: имена — из `reports.telegram` |
| ключи из `checks.eval.providers[].keyEnv` | настоящие ключи моделей для eval |
| `REMONTNIK_REPORTS_TOKEN` | по желанию: забор отчётов командой по SSH |
| `REMONTNIK_BROWSER_TOKEN` | если есть браузер врача |

**Приложение**: `REMONTNIK_SHARED_SECRET`, `REMONTNIK_DOCTOR_URL`, `REMONTNIK_WATCH_DIR`, бот и чат тревог.

Несекретные настройки контейнера врача (`REMONTNIK_APP_DIR`, `REMONTNIK_STATE_DIR`, `REMONTNIK_APP_NETWORK`, `DOCKER_GID` и другие) — в `.env` рядом с файлом compose. Список — в шапке [`deploy/compose.remontnik.yml`](../deploy/compose.remontnik.yml).

## 7. Врач на сервере

1. На сервере — рабочая копия основной ветки приложения. Врач читает настройку из неё и выкатывает из неё. Зависимости приложения в ней ставить не нужно. Настройка — это код, который врач выполняет как есть; запрет на лишние импорты — не защита, а понятная ошибка вместо падения `ERR_MODULE_NOT_FOUND`. Из настройки (и из её соседних файлов) можно подключать: пакеты Ремонтника, которые есть у врача (сейчас только `@ykurilov/remontnik-core`; `@ykurilov/remontnik-watch` у врача нет, его там не подключайте), встроенные модули Node и свои файлы по относительному пути. Любой другой пакет даёт ошибку «настройка должна быть данными; импорт X не поддерживается». Соседние файлы настройки тоже не должны тянуть сторонние пакеты и лежать в запретных зонах (например, `remontnik.config.<имя>.ts` или путь из `forbidden.extra`): иначе врач сможет поправить их и тем изменить настройку. `check-config` предупреждает о таком файле.
2. Файл [`deploy/compose.remontnik.yml`](../deploy/compose.remontnik.yml) собирает образы из корня репозитория Ремонтника (`context: ..`), поэтому запускайте его из клона этого репозитория, а не из копии одного файла. Переменные из его шапки задайте в оболочке, в `.env` рядом с файлом или ключом `--env-file`. `DOCKER_GID` на Linux — `stat -c %g /var/run/docker.sock`; в Docker Desktop на Mac сокет принадлежит группе `0`.
3. Запустите из корня репозитория Ремонтника:

   ```sh
   docker compose -f deploy/compose.remontnik.yml up -d --build
   ```

Врач подключается к сети Docker приложения и слушает порт 7800 только там. Наружу порт не публикуется.

## 8. Проверка настройки

```sh
docker compose -f deploy/compose.remontnik.yml exec doctor remontnik-doctor check-config
```

Врач уже запущен (шаг 7): проверка ищет его контейнер по имени `remontnik-doctor`, а одноразовый контейнер `run --rm` называется иначе и проверку Docker не проходит.

Команда проверяет всё, на чём споткнётся старт врача:

- настройку основной ветки;
- переменные окружения — все недостающие сразу;
- что секрет владельца отличается от общего;
- Docker и сети случая;
- закрепление образов служб;
- правила GitHub, если есть `gh`.

Ответ — список «что не так — как исправить». Код выхода не нулевой, если есть ошибки. Секретов и адресов в выводе нет. Исправляйте, пока не будет «ошибок нет».

## 9. Правила GitHub

Врач может добавлять ветки и метки, но не стирать и не переписывать. Это держат правила репозитория из [`deploy/github-ruleset.json`](../deploy/github-ruleset.json). Применяет владелец через `gh`, вошедший под его именем:

```sh
jq -c '.[]' deploy/github-ruleset.json | while read -r ruleset; do
  printf '%s' "$ruleset" | gh api --method POST /repos/OWNER/REPO/rulesets --input -
done
gh api /repos/OWNER/REPO/rulesets
```

Последняя команда показывает оба набора с `enforcement: active`. Повторный запуск создаёт дубликаты; обновление — `PUT` на `/repos/OWNER/REPO/rulesets/ID`. `check-config` проверяет правила сам.

## 10. Правила приложения

Конституция, `AGENTS.md`, `CLAUDE.md` и прочие правила приложения не должны запрещать автоматическую выкатку врачом. Если запрещают, согласуйте правку с владельцем.

## 11. Стоп-кран

Под отчётами врача о выкатке и о готовой правке стоит кнопка «Остановить автовыкатку». Бот тревог принадлежит приложению, поэтому нажатие приходит к нему. Приложение передаёт нажатие сторожу:

```ts
// В обработчике обновлений бота тревог (webhook или опрос), до своих кнопок:
if (update.callback_query) {
  const answer = await watch.handleStopButton(update.callback_query)
  if (answer !== null) {
    await bot.answerCallbackQuery(update.callback_query.id, { text: answer })
    return
  }
}
```

`handleStopButton` проверяет, что нажали в чате тревог, и отправляет врачу подписанный общим секретом стоп. Он возвращает текст для ответа на нажатие или `null`, если кнопка не его. Бросать он не умеет: при сбое в тексте будет совет остановить из консоли.

Остановить из консоли сервера:

```sh
docker compose -f deploy/compose.remontnik.yml exec doctor remontnik-doctor deploys stop --by owner
```

Снова пустить выкатки — `deploys resume`, только с секретом владельца. Кнопкой этого сделать нельзя.

Проверка: нажмите кнопку под любым отчётом о выкатке. Бот ответит «Автовыкатка остановлена», а следующий отчёт придёт без кнопки, с припиской «Стоп-кран включён».

## 12. Браузер врача (по желанию)

Нужен, если врачу надо смотреть страницы приложения.

1. Учётка Ремонтника в кабинете приложения — отдельная, с минимальными правами.
2. Политика браузера (`browser-policy.json`): только сайты приложения в `allowedOrigins` и узкие `allowedMutations`.
3. Ключи браузера (`REMONTNIK_BROWSER_TOKEN`, `REMONTNIK_BROWSER_VAULT_KEY`) — через `secret-handoff` в `REMONTNIK_BROWSER_ENV_FILE`.
4. Запуск: `docker compose -f deploy/compose.remontnik.yml --profile browser up -d --build`.
5. Вход сохраняет владелец в консоли сервера. Пароль — только через стандартный ввод, в аргументах и журналах его нет:

   ```sh
   docker compose -f deploy/compose.remontnik.yml exec -T browser \
     remontnik-browser logins add --site https://app.example.com --login remontnik@example.com --profile remontnik --password-stdin < password-file
   ```

   Номер входа (команда `logins list`) — в `browser.loginEntryId` настройки.

Пароль короче 8 знаков не сохраняется. Как пароль скрыт от модели — в [security.md](./security.md#пароли-браузера).

## 13. Режим «сначала Paseo» (по желанию)

В этом режиме врач сначала отдаёт случай агенту приложения в Paseo на компьютере владельца. Тот чинит по своим правилам. Не взял или не смог — врач лечит сам. Наблюдение и откат врач делает в любом случае. Договор — [paseo-bridge.md](../specs/001-self-healing-kit/contracts/paseo-bridge.md).

1. Частная сеть между сервером и компьютером владельца (например, Tailscale).
2. Мост `@ykurilov/remontnik-paseo-bridge` — плагин Paseo на компьютере владельца. Настройка — `~/.config/remontnik/paseo-bridge.json`: адрес частной сети, агент приложения, адрес врача, файл с секретом моста.
3. В настройке приложения:

   ```ts
   handoff: {
     mode: 'paseo-first',
     paseo: { bridgeUrlEnv: 'REMONTNIK_BRIDGE_URL', bridgeSecretEnv: 'REMONTNIK_BRIDGE_SECRET', listenEnv: 'REMONTNIK_BRIDGE_LISTEN' },
   },
   ```

4. Секрет моста — через `secret-handoff` в окружение врача и в файл моста. Адрес моста и адрес врача в частной сети — тоже в окружение врача.

Агент приложения отчитывается командами `remontnik-paseo accept | done | cannot`. Частная сеть, правила доступа, порт врача в Docker и секрет моста по шагам — [operations.md](./operations.md#режим-сначала-paseo).

## 14. Проверка всего цикла без настоящей модели

Нужна, чтобы убедиться, что сбой доходит до врача, правка выкатывается и приложение выздоравливает, без денег и сети. Врач в тесте запускается в процессе теста, его модель подставная; сторож, git и команды выкатки настоящие.

- Пакет `@ykurilov/remontnik-doctor` ставится в тестовую папку, не в приложение. Подставная модель и готовая настройка — `@ykurilov/remontnik-doctor/testing` (`createScriptedModel`, `callTool`; [README врача](../packages/doctor/README.md#для-тестов)). Подставной Telegram — `startFakeTelegram` из `@ykurilov/remontnik-core/testing`.
- Образец полного цикла «сбой → правка → выкатка → `healed`» — [`apps/patient/test/cycle/us3-deploy.test.ts`](../apps/patient/test/cycle/us3-deploy.test.ts): `startDoctorService` с `createLocalRunner()` и `allowUnisolatedRunner: true` (только для тестов), `createGitGuard`, `createServerDeployer` с вашими командами выкатки, часы врача, которые перескакивают окно наблюдения.
- Подставная модель правит код по сценарию. Существующие тесты приложения правка менять не может, поэтому тест, который закрепляет сам сбой как ожидаемое поведение, провалит выкатку: такие тесты уберите или перепишите заранее.

## Готово, когда

- `check-config` пишет «ошибок нет»;
- тестовый сбой в приложении приходит врачу и в Telegram;
- ручной `rollback` возвращает прежнюю версию.
