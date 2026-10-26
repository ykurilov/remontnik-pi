# Контракт: врач `@ykurilov/remontnik-doctor`

Служба на сервере приложения. Один процесс на приложение (R1). Приём событий и стоп-кран слушают только внутреннюю сеть Docker. Адреса для моста Paseo (`/v1/handoffs/*`, `/v1/reports*`) — только адрес частной сети из настройки `handoff.paseo.listenEnv` (R18); из интернета врача не видно.

## Окружение (только имена)

`REMONTNIK_CONFIG_REPO_DIR` (рабочая копия основной ветки), `REMONTNIK_STATE_DIR`, `REMONTNIK_SHARED_SECRET`, `REMONTNIK_GIT_TOKEN`, `DEEPSEEK_API_KEY`, `DEEPSEEK_BASE_URL?`, `OPENROUTER_API_KEY`, `OPENROUTER_BASE_URL?`, `PROXY_TOKEN?`, переменные из `reports.telegram.*Env`, `REMONTNIK_BROWSER_URL?`, `REMONTNIK_BROWSER_TOKEN?`, `REMONTNIK_REPORTS_TOKEN`, `REMONTNIK_DOCTOR_URL` (для консольных команд: адрес врача в контейнере), переменные из `handoff.paseo.*Env` (адрес моста, секрет моста, адрес частной сети для приёма).

## HTTP

Все запросы, кроме `/health`, подписаны HMAC: от сторожа — общим секретом сторожа (`signBody`), от моста — секретом моста по правилам `contracts/paseo-bridge.md`, «Подпись»: `verifySignedRequest` (метод, путь с запросом, отметка времени, разовая метка, тело), повтор разовой метки — `401 replayed` (`ReplayGuard`); запрос с отметкой раньше запуска врача — `401 stale`. Вид подписи, метка, время и повтор проверяются по заголовкам до чтения тела. `app` в теле POST от моста необязателен (секрет моста уже привязан к приложению); если указан, должен совпасть с приложением врача, иначе — тот же `401 bad_signature`. Ответы на адресах для моста врач подписывает `signResponse` (привязка к разовой метке запроса) и не отвечает перенаправлениями. Свои запросы к мосту врач подписывает `signRequest`. `/v1/reports*` можно ещё забирать с `Authorization: Bearer <REMONTNIK_REPORTS_TOKEN>` (командами по SSH, если моста нет).

| Метод и путь | Тело / ответ | Назначение |
|---|---|---|
| `POST /v1/events` | см. watch-api | приём событий от сторожа |
| `POST /v1/control/deploys` | `{ action: "stop" \| "resume", by }` → `{ autoDeploy }` | стоп-кран (кнопка Telegram через приложение) |
| `GET /v1/reports?after=<reportId>&limit=50` | `{ reports: Report[], last, acked }`: `reports` — по возрастанию номера, `limit` до 100, страница не больше ~200 КиБ (минимум один отчёт); `last` — номер последнего отчёта в ответе или `after`, если новых нет; `acked` — подтверждённый номер | забор отчётов для Paseo |
| `POST /v1/reports/ack` | `{ upTo: reportId }` → `{ ok, acked }` | подтверждение доставки в Paseo; растёт, но не убывает; номер дальше последнего отчёта — `400 bad_request` |
| `POST /v1/handoffs/:caseId/accepted` | `{ taskId, agent }` | агент взял случай (через мост) |
| `POST /v1/handoffs/:caseId/result` | `{ taskId, kind: "done", commit?, deployed, version? }` \| `{ taskId, kind: "cannot", reason }` | итог агента (через мост) |
| `GET /v1/cases/:id` | `Case` + `Treatment` + отчёты | подробности для агентов |
| `GET /health` | `{ ok, harness, queue, autoDeploy, lastError? }` | здоровье врача |

## Консольные команды `remontnik-doctor`

| Команда | Что делает |
|---|---|
| `start` | запустить службу (точка входа контейнера) |
| `status` | открытые случаи, идущая выкатка, расходы за сутки, стоп-кран |
| `deploys stop` / `deploys resume` | стоп-кран |
| `case <id>` | полный отчёт по случаю |
| `case <id> retry` | снова поставить случай в работу (в том числе припаркованную задачу) |
| `fingerprint <fp> release` | снять «нужен человек» после отката |
| `reports pull [--after <id>] [--limit <n>]` / `reports ack <id>` | то же, что HTTP (по ключу `REMONTNIK_REPORTS_TOKEN` на `REMONTNIK_DOCTOR_URL`), для забора по SSH; печатают ответ врача JSON-ом |
| `check-config` | проверить настройку приложения и окружение, не запуская лечение |

## Инструменты модели врача

Постоянный набор (R3): `read`, `write`, `edit`, `bash` — внутри верстака; `case_info` — подробности случая и журналы (уже вычищенные); `browser_*` — команды браузера (при недоступной службе отвечают `unavailable`); `finish_diagnosis` (структурный ответ: причина, уверенность, план правки, затронутые места); `finish_fix` (сообщение коммита, что проверено). Git с удалённым репозиторием, выкатка и eval модели недоступны.
