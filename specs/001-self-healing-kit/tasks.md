---
description: "Задачи реализации Ремонтника Pi"
---

# Задачи: Ремонтник Pi — набор самолечения приложения

**Вход**: [plan.md](./plan.md), [spec.md](./spec.md), [research.md](./research.md), [data-model.md](./data-model.md), [contracts/](./contracts/), [quickstart.md](./quickstart.md)

**Тесты**: обязательны (конституция, принцип VIII). В каждой истории тесты пишутся первыми и должны упасть по нужной причине до кода.

**Формат**: `[ID] [P?] [История] Описание` — `[P]` можно делать параллельно (другие файлы, нет зависимостей от незаконченных задач).

**Порядок этапов** — как в плане: история 4 (запретные зоны и решение о выкатке) идёт до истории 3 (выкатка), потому что ни одна выкатка не должна появиться раньше замков.

---

## Этап 1: Основа репозитория

**Цель**: монорепозиторий, проверки открытости, выпуск.

- [X] T001 Создать корень pnpm-монорепозитория: `package.json` (`packageManager` pnpm, `engines.node` `>=22.19`, скрипты `test`, `typecheck`, `build`, `verify`), `pnpm-workspace.yaml`, `tsconfig.base.json`, `.nvmrc`, `vitest.config.ts`
- [X] T002 [P] Создать заготовки пакетов `packages/core/package.json`, `packages/watch/package.json`, `packages/doctor/package.json`, `packages/browser/package.json`, `packages/paseo-bridge/package.json` с `exports`; в `packages/doctor/package.json` — `@earendil-works/pi-durable`, `@earendil-works/pi-ai`, `@earendil-works/chord` ровно `1.4.0`
- [X] T003 [P] Создать заготовку учебного приложения `apps/patient/package.json`
- [X] T004 [P] Тест и скрипт точных версий: `scripts/check-pins.test.mjs`, `scripts/check-pins.mjs` — падает, если у pi-durable, pi-ai, chord появился `^`/`~`, или в репозитории есть настройки Dependabot/Renovate
- [X] T005 [P] Тест и скрипт открытости: `scripts/check-public.test.mjs`, `scripts/check-public.mjs` — публичные IPv4, домены вне `example.com`/`.test`/`.invalid`, строки вида ключей; частный запретный список из `~/.config/remontnik/denylist.txt`, если файл есть
- [X] T006 [P] Changesets с группой `fixed` для всех `@ykurilov/remontnik-*`: `.changeset/config.json`, `.changeset/README.md`, `RELEASING.md`, заготовка `CHANGES.md`
- [X] T007 [P] CI `.github/workflows/ci.yml`: установка, тесты, типы, сборка, `check-pins`, `check-public`, `gitleaks` по всей истории
- [X] T008 Скрипт `pnpm verify` (тесты → сборка → типы → check-pins → check-public; сборка до типов — пакеты видят типы друг друга из `dist`) в `package.json`; `README.md` — что это, лицензия MIT; поле `license: "MIT"` во всех `package.json`

**Контрольная точка**: `pnpm verify` зелёный на пустых пакетах.

---

## Этап 2: Общие части — core и «Пациент»

**Цель**: то, без чего не начинается ни одна история. Блокирует все истории.

### Тесты

- [X] T009 [P] Тест настройки `packages/core/src/config/config.test.ts`: схема из contracts/remontnik-config.md; встроенные запреты R7 нельзя убрать; пустые `forbidden.schema|money|access` отклоняются
- [X] T010 [P] Тест отпечатка `packages/core/src/incident/fingerprint.test.ts`: числа, адреса, идентификаторы вырезаются; одинаковый сбой → одинаковый отпечаток; `fingerprint` «sha256, 16 символов»; обрезка `message` «≤ 2000», `stack` «≤ 8000», `context` «≤ 4 КБ»
- [X] T011 [P] Тест вычистки `packages/core/src/redact/redact.test.ts`: ключи, `Bearer`, токены ботов Telegram, почты, телефоны
- [X] T012 [P] Тест пути к модели `packages/core/src/model-route/model-route.test.ts`: переход на запасной при 429, 5xx, сетевой ошибке, тайм-ауте; при прочих 4xx — ошибка; возврат на основной через `retryPrimaryAfterMs` (подменённые часы)
- [X] T013 [P] Тесты `packages/core/src/telegram/telegram.test.ts` (обрезка, токен вырезан из ошибок, прокси-заголовок) и `packages/core/src/signed-http/signed-http.test.ts` (подпись, неверная подпись, старая отметка времени)

### Реализация

- [X] T014 [P] `defineRemontnikConfig`, схема и встроенные запреты в `packages/core/src/config/`
- [X] T015 [P] Типы `IncidentEvent` (поля и пределы из data-model.md) и `fingerprint()` в `packages/core/src/incident/`
- [X] T016 [P] Вычистка в `packages/core/src/redact/`
- [X] T017 [P] Путь к модели DeepSeek → OpenRouter на `fetch` (OpenAI-совместимый протокол, ответ JSON) в `packages/core/src/model-route/`; идентификаторы моделей — по одной константе
- [X] T018 [P] Telegram и подпись запросов в `packages/core/src/telegram/`, `packages/core/src/signed-http/`
- [X] T019 [P] Подставные серверы Telegram и OpenAI-совместимой модели для тестов в `packages/core/src/testing/` (подпуть `/testing`)
- [X] T020 «Пациент»: HTTP-сервер со страницами (кабинет со входом, веб-чат с ботом-заглушкой), заложенные ошибки по `PATIENT_BUG` (падение, ошибка «модели», ошибка инструмента, ошибка только на странице, ошибка в «оплате», ухудшающая правка) в `apps/patient/src/`
- [X] T021 «Пациент»: тесты, подставной eval с итогом в формате contracts/deploy-commands.md, файл `apps/patient/remontnik.config.ts`
- [X] T022 «Пациент»: команды выкатки на папках (`releases/<версия>`, `current`, `previous`) — `build`, `promote`, `confirm`, `rollback`, `current`, `health` — в `apps/patient/deploy/` с тестом `apps/patient/deploy/deploy.test.ts`

**Контрольная точка**: core покрыт тестами, «Пациент» запускается, выкатывается и откатывается на папках.

---

## Этап 3: История 1 — Сбой замечен и описан за минуту (P1) 🎯 MVP

**Цель**: сторож ловит сбой, шлёт Telegram сразу и надёжно доставляет случай врачу.

**Независимая проверка**: на «Пациенте» падение, ошибка модели и ошибка инструмента дают по одному сообщению и одному случаю; 50 повторов — один случай со счётчиком; врач выключен — сообщение уходит, случай доходит после включения.

### Тесты

- [X] T023 [P] [US1] Тест очереди `packages/watch/src/outbox/outbox.test.ts`: дозапись JSONL, подтверждение, переживает переоткрытие, сжатие при старте, повторы 5 с / 30 с / 2 мин / 10 мин (подменённые часы), свой файл на процесс
- [X] T024 [P] [US1] Тест сообщений `packages/watch/src/notify/notify.test.ts`: одно сообщение на отпечаток; повтор — только через час и при росте счётчика
- [X] T025 [P] [US1] Тест ловли `packages/watch/src/capture/capture.test.ts`: `uncaughtException`, `unhandledRejection` записаны, поведение процесса не изменилось; свои ошибки — строка `[remontnik]` без случая; в горячем пути нет сети
- [X] T026 [P] [US1] Тест хуков SDK `packages/watch/src/agent-chat/hooks.test.ts`: строки `logError` → `model_error`/`turn_failed`; ошибки `afterTurn` → `turn_failed`/`tool_error`; результат хуков приложения не меняется
- [X] T027 [P] [US1] Тест приёма у врача `packages/doctor/src/intake/intake.test.ts`: подпись верная/неверная/устаревшая; повтор `eventId` безопасен; ответ `accepted`
- [X] T028 [P] [US1] Тест книги случаев `packages/doctor/src/case-book/case-book.test.ts`: склейка по отпечатку, счётчик, один открытый случай на отпечаток, `linkedEventIds` «≤ 50»

### Реализация

- [X] T029 [P] [US1] Очередь в `packages/watch/src/outbox/`
- [X] T030 [P] [US1] Склейка и частота сообщений в `packages/watch/src/notify/`
- [X] T031 [US1] `createWatch`, `installProcessHandlers`, `capture`, `wrapModelCatalog`, `flush`, `stats` в `packages/watch/src/capture/` и `packages/watch/src/index.ts` по contracts/watch-api.md
- [X] T032 [US1] Подпуть `/agent-chat` в `packages/watch/src/agent-chat/`
- [X] T033 [US1] Каркас врача: `Harness.open` с SQLite pi-durable, `resume`, закрытие с ошибкой → выход с ненулевым кодом, `onReport` `task_parked` → Telegram в `packages/doctor/src/service/`
- [X] T034 [US1] HTTP приёма `POST /v1/events` и `GET /health` в `packages/doctor/src/intake/`
- [X] T035 [US1] Книга случаев на документах pi-durable `remontnik.case/<caseId>` в `packages/doctor/src/case-book/`; минимальная очередь отчётов Telegram с повторами и отчёт `case_received` в `packages/doctor/src/reports/`
- [X] T036 [US1] Интеграционный тест `apps/patient/test/cycle/us1-detect.test.ts`: сценарии crash (до приёма врачом), repeat, «врач выключен», «секрет в тексте ошибки»

**Контрольная точка**: история 1 работает отдельно — уже польза: тревога за минуту и запись случая.

---

## Этап 4: История 2 — Причина и проверенная правка (P1)

**Цель**: врач находит причину, правит в своей ветке, проверяет, отчитывается. Без выкатки.

**Независимая проверка**: на «Пациенте» с заложенной ошибкой — ветка с правкой и тестом, проверки зелёные, отчёт; основная ветка и работающая версия не тронуты.

### Тесты

- [X] T037 [P] [US2] Тест обёртки-поставщика `packages/doctor/src/model/provider-fallback.test.ts`: переходы DeepSeek → OpenRouter поверх pi-ai (подставные поставщики)
- [X] T038 [P] [US2] Тест системного промпта `packages/doctor/src/model/system-prompt.test.ts`: постоянный порядок секций; нет времени и номера случая; одинаковые байты для одной основы (кэш)
- [X] T039 [P] [US2] Тест верстака `packages/doctor/src/workbench/workbench.test.ts`: копия от `baseCommit`; `closedPaths` физически отсутствуют; тайм-аут команды; в окружении нет секретов (локальный исполнитель вместо Docker)
- [X] T040 [P] [US2] Тест выбора сценариев `packages/doctor/src/checks/eval-scope.test.ts`: карта путей; предел `maxScenarios`; закрытые сценарии не передаются; правка вне карты → `not_needed`
- [X] T041 [P] [US2] Тест проверок `packages/doctor/src/checks/checks.test.ts`: повтор упавших тестов, разный итог → `flaky`; eval `not_worse`/`worse`/`stand_broken`; кэш основы по паре (коммит, сценарий); потолок денег
- [X] T042 [P] [US2] Тест git-замка `packages/doctor/src/git-guard/git-guard.test.ts` на локальном пустом репозитории: только разрешённые операции; ветка `remontnik/<caseId>-<slug>`; `--force` отклонён; запись в основную ветку — только при `mainline: "merge"` и без `--force`

### Реализация

- [X] T043 [P] [US2] Обёртка-поставщик с запасным путём и сборщик системного промпта в `packages/doctor/src/model/`
- [X] T044 [P] [US2] Верстак: `ContainerExecutionEnv` (`docker exec`, тайм-аут) и локальный исполнитель для тестов, `git worktree` и sparse checkout в `packages/doctor/src/workbench/`; проверить интерфейс окружения выполнения pi-durable 1.4.0 и записать в `packages/doctor/README.md`
- [X] T045 [P] [US2] Git-замок в `packages/doctor/src/git-guard/`
- [X] T046 [US2] Проверки в проверочном контейнере: запуск тестов, разбор JUnit / `REMONTNIK_FAILED`, запуск eval по шаблону, кэш основы в `packages/doctor/src/checks/`
- [X] T047 [US2] Инструменты модели `case_info`, `finish_diagnosis`, `finish_fix`; постоянный набор; `beforeTool` с обязательным тайм-аутом bash в `packages/doctor/src/treatment/tools.ts`
- [X] T048 [US2] Задача pi-durable `remontnik.treatment`: фазы `triage` → `diagnosing` → `fixing` → `verifying` с чекпойнтами; потолок `diagnoseUsdPerCase` → `no_cause_found` в `packages/doctor/src/treatment/`
- [X] T049 [US2] Тексты отчётов `cause_found`, `fix_ready`, `no_cause_found`, `stand_broken` в `packages/doctor/src/reports/texts.ts`
- [X] T050 [US2] Модель по сценарию для тестов в `packages/doctor/src/testing/scripted-model.ts` (на основе `pi-durable/testing`, если подходит)
- [X] T051 [US2] Интеграционный тест `apps/patient/test/cycle/us2-fix.test.ts`: падение → ветка, коммит, тест, зелёные проверки, отчёт, основная ветка не тронута; eval хуже → отчёт; бюджет исчерпан → `no_cause_found`

**Контрольная точка**: истории 1 и 2 вместе — полезный «врач-советчик».

---

## Этап 5: История 4 — Запретные зоны и защита истории (P1)

**Цель**: замки до первой выкатки. Модули T052–T058 можно писать параллельно с этапом 4.

**Независимая проверка**: правка в «оплате», правка существующего теста, причина в SDK — ни одной выкатки, на каждую отчёт с объяснением.

### Тесты

- [X] T052 [P] [US4] Тест запретных зон `packages/doctor/src/forbidden-zones/forbidden-zones.test.ts`: встроенные (`.env*`, имена с `secret`/`credential`, `@ykurilov/agent-chat-*` в `node_modules` и патчах, `remontnik.config.*`, зависимости, файл-замок, `Dockerfile`, выкатка, CI) + маски приложения + признаки SQL
- [X] T053 [P] [US4] Тест осмотра диффа `packages/doctor/src/diff-inspector/diff-inspector.test.ts`: изменён или удалён существующий тест, сценарий eval, рубрика (новые — можно); подозрительное: `process.env`, новые внешние адреса, `child_process`, `eval`/`new Function`, файлы вне проекта; пределы 300 строк / 15 файлов
- [X] T054 [P] [US4] Тест решения `packages/doctor/src/deploy-gate/deploy-gate.test.ts`: каждый код из `GateReason` (`tests_not_green`, `eval_worse`, `forbidden_zone`, `existing_test_changed`, `suspicious_change`, `diff_too_large`, `stop_switch`, `attempts_exhausted`, `needs_human_after_rollback`, `budget_exhausted`, `rebase_conflict`) даёт `report_only`; всё зелёное → `deploy`
- [X] T055 [P] [US4] Тест источника настройки `packages/doctor/src/service/config-source.test.ts`: настройка читается только из рабочей копии основной ветки, правка настройки в ветке врача не действует

### Реализация

- [X] T056 [P] [US4] Запретные зоны в `packages/doctor/src/forbidden-zones/`
- [X] T057 [P] [US4] Осмотр диффа в `packages/doctor/src/diff-inspector/`
- [X] T058 [US4] Решение о выкатке — чистая функция в `packages/doctor/src/deploy-gate/`
- [X] T059 [US4] Источник настройки в `packages/doctor/src/service/config-source.ts`
- [X] T060 [US4] Фаза `gated` в задаче лечения; отчёты `report_only` и `needs_human`; при причине в SDK — готовый текст задачи для агента SDK, в `packages/doctor/src/treatment/`
- [X] T061 [US4] Шаблон правил GitHub `deploy/github-ruleset.json` (основная ветка: запрет принудительной записи и удаления; метки `remontnik/**`: запрет изменения и удаления) и раздел о правах git в `docs/security.md`
- [X] T062 [US4] Интеграционный тест `apps/patient/test/cycle/us4-forbidden.test.ts`: сценарии money, test-edit, «причина в SDK»

**Контрольная точка**: замки на месте и проверены — можно строить выкатку.

---

## Этап 6: История 3 — Безопасная выкатка и самостоятельный откат (P1)

**Цель**: зелёная правка выкатывается сама, с меткой и прежней сборкой; ухудшение — откат за секунды.

**Независимая проверка**: на «Пациенте» зелёная правка выкачена и держится; ухудшающая — откачена врачом сам; откат работает при недоступном git.

### Тесты

- [ ] T063 [P] [US3] Тест порядка выкатки `packages/doctor/src/deployer/deploy-sequence.test.ts`: замок → `current` → метка на прежней версии → `build` → `promote` → `current` = кандидат → `health`; без прежней сборки — отказ; сбой после `promote` → `rollback`
- [ ] T064 [P] [US3] Тест наблюдения `packages/doctor/src/deployer/observer.test.ts` (подменённые часы): 3 провала здоровья, рост частоты ошибок выше множителя и порога, новые отпечатки → откат; тот же отпечаток без ухудшения → `not_helped`; смена `current` → `superseded_by_human`
- [ ] T065 [P] [US3] Тест замка выкатки `packages/doctor/src/deployer/lock.test.ts`: одна выкатка на приложение; ручная выкатка держит замок — врач ждёт
- [ ] T066 [P] [US3] Тест стоп-крана `packages/doctor/src/ledgers/controls.test.ts`: стоп блокирует выкатку; команда и HTTP с подписью

### Реализация

- [ ] T067 [P] [US3] Запуск команд приложения и файл-замок в `packages/doctor/src/deployer/`
- [ ] T068 [US3] Наблюдение с `runtime.sleepUntil` и уровнем ошибок до выкатки из книги случаев в `packages/doctor/src/deployer/observer.ts`
- [ ] T069 [US3] Стоп-кран: документ `remontnik.controls`, `POST /v1/control/deploys`, команды `deploys stop|resume` в `packages/doctor/src/ledgers/controls.ts`, `packages/doctor/src/intake/`, `packages/doctor/src/cli/`
- [ ] T070 [US3] Фазы `deploying` → `observing` → `healed` | `rolled_back` | `not_helped`; после окна — слияние в основную ветку или запрос на слияние по `repo.mainline` через git-замок, в `packages/doctor/src/treatment/`
- [ ] T071 [US3] Отчёты `deployed`, `rolled_back`, `not_helped` (поле снимков экрана) в `packages/doctor/src/reports/texts.ts`
- [ ] T072 [US3] Интеграционный тест `apps/patient/test/cycle/us3-deploy.test.ts`: crash до `healed` с меткой и прежней сборкой; worse → откат меньше чем за минуту; no-git; stop

**Контрольная точка**: P1 закрыт — самолечение работает целиком на «Пациенте».

---

## Этап 7: История 6 — Сторож замечает неадекватные ответы (P2)

**Цель**: чтение законченных разговоров в пределах бюджета. Можно начинать сразу после этапа 3, параллельно с этапами 4–6.

**Независимая проверка**: на выдуманном размеченном наборе плохие ответы отмечены, хорошие — нет, с порогами SC-009.

### Тесты

- [X] T073 [P] [US6] Выдуманный размеченный набор разговоров `packages/watch/test/fixtures/conversations/*.json` (хорошие и плохие по каждому виду: выдумка, грубость, выход из роли, пропущенный вопрос, обрыв, противоречие инструкции)
- [X] T074 [P] [US6] Тест очереди чтения `packages/watch/src/review/review-queue.test.ts`: бюджет на сутки по поясу настройки; `deferred_budget`; сводка «отложено N»
- [X] T075 [P] [US6] Тест рубрики `packages/watch/src/review/rubric.test.ts`: неизменный префикс байт в байт; личные данные замаскированы до модели; строгий разбор JSON; фильтр `minConfidence`; одинаковые отметки склеены
- [X] T076 [P] [US6] Живой тест качества `packages/watch/test/live/review-quality.live.test.ts`: ≥ 80% плохих найдено, ≤ 10% ложных

### Реализация

- [X] T077 [US6] Чтение разговоров в `packages/watch/src/review/`
- [X] T078 [US6] `watch.conversationFinished` и события `bad_answer` с полями `badAnswer` (`excerpt` «≤ 500», `confidence` «0..1») в `packages/watch/src/index.ts`
- [ ] T079 [US6] Лечение `bad_answer` у врача: сценарии eval по карте промптов, выдержка разговора в `case_info` в `packages/doctor/src/treatment/`
- [X] T080 [US6] «Пациент»: бот с заложенным плохим ответом и вызов `conversationFinished` в `apps/patient/src/bot/`; тест `apps/patient/test/cycle/us6-review.test.ts`

---

## Этап 8: История 5 — Врач переживает падения (P2)

**Цель**: продолжение с места и доводка оборванных выкаток по реальному состоянию.

**Независимая проверка**: врач убит на каждой фазе и запущен снова — случай доведён, выкаток ≤ 1, приложение здорово.

- [ ] T081 [P] [US5] Обвязка тестов падений `packages/doctor/test/crash/crash-harness.ts`: врач — дочерний процесс, `REMONTNIK_TEST_CRASH_AT=<фаза>`, перезапуск
- [ ] T082 [US5] Тесты падений `packages/doctor/test/crash/phases.test.ts`: `triage`, `diagnosing`, `fixing`, `verifying`, `gated`, `deploying` до и после `promote`, `observing` — итог доведён, выкаток ≤ 1, `healthy`
- [ ] T083 [US5] Эффекты «намерение → действие → итог» (`pendingEffect`) для метки, push, `promote`, `rollback` с проверкой через `current` в `packages/doctor/src/treatment/effects.ts`
- [ ] T084 [US5] Перезапуск верстака незавершённого случая при старте (сироты), обработка `interrupted` у bash в `packages/doctor/src/workbench/`
- [ ] T085 [US5] Сбой хранилища → выход и отчёт `doctor_problem`; тревога о припаркованной задаче; команда `case <id> retry` в `packages/doctor/src/service/` и `packages/doctor/src/cli/`
- [ ] T086 [US5] Тест «основной поставщик упал посреди случая» `packages/doctor/test/integration/fallback.test.ts`

---

## Этап 9: История 8 — Браузер Ремонтника (P3)

**Цель**: свой браузер, пароли модель не видит, опасное запрещено. Служба и живой экран (T087–T100, T103–T108) — параллельно с этапами 3–7; инструменты врача (T101–T102, T109) — после этапа 6.

**Независимая проверка**: ошибка «только на странице» воспроизведена; пароль не найден ни в одном выводе; при выключенном браузере цикл проходит.

### Тесты

- [X] T087 [P] [US8] Тест хранилища входов `packages/browser/src/vault/vault.test.ts`: AES-256-GCM туда-обратно; чужой ключ не открывает; список без паролей; добавление только из стандартного ввода
- [X] T088 [P] [US8] Тест замков `packages/browser/src/guard/guard.test.ts`: `send`/`pay`/`delete`/`publish` отклонены; сайты вне `allowedOrigins`; сопоставление `allowedMutations`
- [X] T089 [P] [US8] Тест снимка `packages/browser/src/snapshot/snapshot.test.ts`: номера стабильны на странице; значения полей пароля скрыты; поля, куда впечатан пароль, помечены
- [X] T090 [P] [US8] Браузерный тест `packages/browser/test/e2e/password-never-leaks.spec.ts` против кабинета «Пациента»: вход, кнопка «глаз», смена типа поля, `read`, `shot`, ответы и журналы — пароль найден 0 раз (SC-010)
- [X] T091 [P] [US8] Браузерный тест `packages/browser/test/e2e/policy.spec.ts`: опасные действия, чужой сайт, изменяющий запрос вне списка, страница с капчей и поле одноразового кода → `needs_human`

### Реализация

- [X] T092 [US8] Проверить, даёт ли закреплённая версия `playwright-core` снимок с номерами элементов; выбрать: встроенный или свой обход DOM с `data-remontnik-ref`; записать решение в `packages/browser/README.md`
- [X] T093 [P] [US8] Профили: постоянные контексты Chromium, профиль обязателен, прокси по желанию, в `packages/browser/src/profiles/`
- [X] T094 [P] [US8] Хранилище входов, `fill-password` с проверкой поля и сайта (с фреймами), фильтр выхода в `packages/browser/src/vault/`
- [X] T095 [P] [US8] Замки: перехват запросов, сайты, признаки капчи и кодов в `packages/browser/src/guard/`
- [X] T096 [US8] Снимок страницы в `packages/browser/src/snapshot/`
- [X] T097 [US8] Действия `url`, `back`, `click`, `type`, `key`, `scroll`, `shot` (маска полей пароля) в `packages/browser/src/actions/`
- [X] T098 [US8] HTTP-служба с ключом по contracts/browser-api.md в `packages/browser/src/service/`
- [X] T099 [US8] Консольная `remontnik-browser`, в том числе `logins add --password-stdin` и `logins remove`, в `packages/browser/src/cli/`
- [X] T100 [US8] Образ `deploy/browser.Dockerfile` (Chromium, без прокси по умолчанию)
- [ ] T101 [US8] Инструменты `browser_*` у врача: постоянный набор, ответ `unavailable`, снимки в отчёт, проверка `pagesToCheck` после выкатки, в `packages/doctor/src/browser-tools/`
- [ ] T102 [US8] Интеграционный тест `apps/patient/test/cycle/us8-browser.test.ts`: ошибка «только на странице» воспроизведена и после выкатки страница работает; браузер выключен → цикл проходит с пометкой «без проверки в браузере»


### Живой экран (решение Юрия)

- [X] T103 [P] [US8] Тест доступа `packages/browser/src/live/live-access.test.ts`: без ключа владельца — отказ; ключ врача не подходит; адрес слушается только на `REMONTNIK_BROWSER_LIVE_LISTEN`; переменная не задана — живого экрана нет
- [X] T104 [P] [US8] Тест управления `packages/browser/src/live/control.test.ts` (подменённые часы): владелец взял управление → команды врача `refused_human_control`; вернул → работают; связь владельца пропала на 2 минуты → управление у врача; замки сайтов и запросов действуют при ручном управлении
- [X] T105 [P] [US8] Браузерный тест `packages/browser/test/e2e/live.spec.ts` против «Пациента»: кадры идут; клик, касание и ввод владельца доходят до страницы; кадров нет в ответах врачу и журналах; один случай с узким экраном телефона
- [X] T106 [US8] Трансляция кадров (`newCDPSession`, `Page.startScreencast`) и WebSocket в `packages/browser/src/live/stream.ts`
- [X] T107 [US8] Ввод владельца (`Input.dispatchMouseEvent`, `dispatchKeyEvent`, `insertText`) и замок управления в `packages/browser/src/live/control.ts`
- [X] T108 [US8] Страница живого экрана: вход по ключу, экран, «Взять управление» / «Вернуть», работа с телефона, в `packages/browser/src/live/page/`
- [ ] T109 [US8] Ссылка на живой экран в отчётах `needs_human` от браузера (по `browser.live.linkEnv`), продолжение после «Вернуть», в `packages/doctor/src/browser-tools/` и `packages/doctor/src/reports/texts.ts`

---

## Этап 10: История 7 — Деньги и циклы под контролем (P2)

**Цель**: лимиты попыток и расходов. Параллельно с этапом 8.

**Независимая проверка**: ухудшающая правка — после лимита «нужен человек»; потолок расходов — случай отложен с сообщением.

- [ ] T110 [P] [US7] Тест `packages/doctor/src/ledgers/fingerprint-ledger.test.ts`: 2 выкатки на отпечаток в сутки, 5 на приложение, «нужен человек» после отката, снятие командой
- [ ] T111 [P] [US7] Тест `packages/doctor/src/ledgers/spend-ledger.test.ts`: граница суток по поясу; запас 10%; блок обращения к модели; блок eval
- [ ] T112 [US7] Учёт попыток и команда `fingerprint <fp> release` в `packages/doctor/src/ledgers/fingerprint-ledger.ts`, `packages/doctor/src/cli/`
- [ ] T113 [US7] Учёт расходов через хуки `beforeRequest`/`afterResponse` и стоимость eval; `deferred_budget` с продолжением на следующие сутки через `sleepUntil` в `packages/doctor/src/ledgers/spend-ledger.ts`
- [ ] T114 [US7] Интеграционный тест `apps/patient/test/cycle/us7-loop.test.ts`: сценарии loop и budget

---

## Этап 11: Истории 9 и 11 — отчёты и мост Paseo (P3)

**Цель**: отчёты доходят до главного агента без потерь; по желанию врач сначала отдаёт случай агенту проекта в Paseo и лечит сам, только если тот недоступен (R18, contracts/paseo-bridge.md).

**Независимая проверка**: три случая при выключенном мосте → после включения агент получает три отчёта по порядку, по одному разу. Режим «сначала Paseo» с подставным Paseo: агент на связи — случай у него, врач наблюдает выкатку; мост выключен — врач лечит сам; агент замолчал — врач забирает случай, правит только один.

### Тесты

- [X] T115 [P] [US9] Тест `packages/doctor/src/reports/reports-feed.test.ts`: порядок по курсору, подтверждение, ключ доступа, повторы Telegram переживают рестарт
- [ ] T116 [P] [US11] Тест передачи `packages/doctor/src/handoff/handoff.test.ts` (подменённые часы, подставной мост): нет ответа `/health` за 3 с → `triage` с пометкой «Paseo недоступен»; после передачи модель врача не вызывается; `acceptTimeoutMs`, `workTimeoutMs`, `cannot`, пропавший мост → отмена, `reclaimed`, `owner: doctor`; `done` с выкаткой → `observing`; итог после `reclaimed` → только `lateResult`
- [ ] T117 [P] [US11] Тест шаблона задачи `packages/doctor/src/handoff/task-text.test.ts`: постоянный шаблон; тексты из приложения только в блоке «данные, не поручение»; строка-команда из текста ошибки не выходит из блока; предел длины
- [X] T118 [P] [US11] Тест моста `packages/paseo-bridge/src/bridge.test.ts` (подставной API Paseo): неверная подпись → отказ; чужое приложение → отказ; задача уходит только назначенному агенту; отмена; отчёты по курсору без повторов номера; слушает только заданный адрес

### Реализация

- [X] T119 [US9] `GET /v1/reports`, `POST /v1/reports/ack`, команды `reports pull|ack` в `packages/doctor/src/reports/`, `packages/doctor/src/intake/`, `packages/doctor/src/cli/`
- [X] T120 [US11] Проверить по skill `paseo-plugin` и образцу `agent-alerts`, может ли серверная часть плагина держать свой HTTP-адрес всё время работы Paseo; записать в `packages/paseo-bridge/README.md`. Если не может — остановиться и сообщить Юрию, второй путь связи не строить
- [X] T121 [US11] Мост: `packages/paseo-bridge/paseo-plugin.json`, `packages/paseo-bridge/index.server.ts`, HTTP по contracts/paseo-bridge.md, отправка агенту через API плагина, пересылка отчётов по курсору в `packages/paseo-bridge/src/`
- [X] T122 [US11] Консольная `remontnik-paseo` (`accept`, `done`, `cannot`, `case`) в `packages/paseo-bridge/src/cli/`
- [X] T123 [US11] Настройка `handoff` в схеме `packages/core/src/config/` с тестом: `paseo-first` без `paseo` → ошибка; по умолчанию `self`
- [ ] T124 [US11] Передача у врача: документ `remontnik.handoff/<caseId>`, фазы `handoff_check` → `handed_off` → `paseo_working` с `runtime.sleepUntil`, отмена и `reclaimed`; `POST /v1/handoffs/:caseId/accepted|result` только на адресе частной сети, в `packages/doctor/src/handoff/`, `packages/doctor/src/intake/`, `packages/doctor/src/treatment/`
- [ ] T125 [US11] Отчёты `handed_off`, `paseo_done`, `reclaimed` и пометка «Paseo недоступен» в `packages/doctor/src/reports/texts.ts`
- [ ] T126 [US11] Интеграционный тест `apps/patient/test/cycle/us11-paseo.test.ts` с подставным мостом: агент выкатил хуже → врач откатил и сообщил агенту; мост выключен → врач лечит сам; агент замолчал → `reclaimed`, правит один; поздняя выкатка агента → общий замок, наблюдение по этому случаю
- [X] T127 [US9] Интеграционный тест `packages/doctor/test/integration/paseo-feed.test.ts`: отчёты через мост, мост выключен и включён
- [ ] T128 [US11] Раздел «Режим „сначала Paseo“» в `docs/operations.md`: частная сеть и правило доступа «только сервер → порт моста», настройка моста, секрет моста через `secret-handoff`

---

## Этап 12: История 10 — Подключение по инструкции и выпуск (P3)

**Цель**: любой агент подключает набор по инструкции.

**Независимая проверка**: свежий агент по `docs/getting-started.md` подключает набор к копии «Пациента», первый случай проходит весь цикл.

- [ ] T129 [P] [US10] Шаблон `deploy/compose.remontnik.yml` и `deploy/doctor.Dockerfile`: врач с сокетом Docker, верстак без сокета, без секретов и без сети приложения, тома состояния
- [ ] T130 [P] [US10] `docs/getting-started.md` по contracts/app-integration.md: пакеты, сторож, настройка, команды, окружение через `secret-handoff`, по желанию — режим «сначала Paseo», правила GitHub через `gh api`, вход браузера через `logins add --password-stdin`
- [ ] T131 [P] [US10] `docs/configuration.md`, `docs/security.md` (модель паролей и остаток риска, верстак, ключи eval), обновить `README.md`
- [ ] T132 [US10] Команда `remontnik-doctor check-config` с тестом в `packages/doctor/src/cli/check-config.ts`
- [ ] T133 [US10] Проверка подключения свежим агентом (SC-012) на копии «Пациента»; итог записать в `specs/001-self-healing-kit/checklists/install-run.md`
- [ ] T134 [US10] Первая запись changeset и раздел 0.1.0 «Как подключить» в `CHANGES.md`
- [ ] T135 [US10] Вне репозитория: передать агенту первого приложения задачу подключения из частной папки `.private/` через `send_agent_prompt` — после выпуска 0.1.0

---

## Этап 13: Полировка

- [ ] T136 Живая группа `pnpm test:live` на iMac: Docker-сборка врача, браузера, верстака; «Пациент» в контейнерах; настоящий DeepSeek; случай crash до `healed`
- [ ] T137 Отдельный агент-ревьюер безопасности: побег из верстака, секреты в журналах, подпись запросов, хранилище входов, мост Paseo (подписи, шаблон задачи, адрес только в частной сети)
- [ ] T138 [P] Замер горячего пути сторожа ≤ 1 мс на событие `packages/watch/test/perf/capture.bench.ts`
- [ ] T139 [P] `check-public` и `gitleaks` по всей истории; `.private/` не в git
- [ ] T140 Полный прогон всех тестов и браузерных (≤ 5 минут) и проверка всех сценариев [quickstart.md](./quickstart.md)

---

## Зависимости и порядок

### Этапы

- Этап 1 → этап 2 → всё остальное.
- Путь, который определяет срок: 3 → 4 → 5 (встраивание) → 6 → 8 → 11 → 12 → 13.
- Рядом с ним:
  - модули этапа 5 (T052–T058) — параллельно с этапом 4;
  - этап 7 (US6) — после этапа 3, параллельно с 4–6;
  - служба браузера и живой экран (T087–T100, T103–T108) — после этапа 2, параллельно с 3–7; инструменты врача (T101–T102, T109) — после этапа 6;
  - этап 10 (US7) — после этапа 6, параллельно с этапом 8;
  - мост Paseo (T118, T120–T122) — после этапа 2, параллельно с 3–8; передача у врача (T116–T117, T123–T126) — после этапа 8: она правит ту же папку `treatment/`.

### Внутри истории

Тесты → убедиться, что красные по нужной причине → модели и чистые модули → службы → встраивание в задачу лечения → интеграционный тест на «Пациенте».

### Общие файлы — кто их правит

`packages/doctor/src/treatment/` правят этапы 4, 5, 6, 7, 8, 11 — эти части идут **по очереди**, не параллельно. `packages/doctor/src/cli/` и `intake/` — короткие добавления, сливать по одному.

## Параллельный запуск (пример после этапа 2)

```text
Агент А (основной путь): этап 3 → этап 4 → встраивание этапа 5 → этап 6 → …
Агент Б: T052–T058 (замки) → этап 7 (чтение разговоров)
Агент В: T087–T100, T103–T108 (браузер и живой экран) → T118, T120–T122 (мост Paseo)
```

Каждый — в своей копии кода (`git worktree`). Результаты вливаются по одному с прогоном тестов после каждого.

## Стратегия

1. **MVP** — этапы 1–3: тревога за минуту и запись случая. Уже можно ставить в приложение.
2. **Советчик** — + этап 4: проверенные правки в ветках, без выкатки.
3. **Самолечение** — + этапы 5–6: выкатка с замками и откатом.
4. **Надёжность и экономия** — этапы 7, 8, 10.
5. **Глаза и связь** — этапы 9, 11; режим «сначала Paseo» — по желанию.
6. **Для учеников** — этап 12, выпуск 0.1.0 после решения по лицензии.

## Оценка (минуты работы агентов)

| Этап | Задачи | Минуты |
|---|---|---|
| 1 | T001–T008 | 15 |
| 2 | T009–T022 | 35 |
| 3 · US1 | T023–T036 | 45 |
| 4 · US2 | T037–T051 | 90 |
| 5 · US4 | T052–T062 | 30 |
| 6 · US3 | T063–T072 | 60 |
| 7 · US6 | T073–T080 | 40 |
| 8 · US5 | T081–T086 | 45 |
| 9 · US8 | T087–T109 | 195 |
| 10 · US7 | T110–T114 | 25 |
| 11 · US9 + US11 | T115–T128 | 95 |
| 12 · US10 | T129–T135 | 35 |
| 13 | T136–T140 | 40 |
| **Сумма** | **140 задач** | **≈ 750 (≈ 12,5 ч)** |
| **С учётом параллельных** | | **≈ 430 (≈ 7 ч)** |
