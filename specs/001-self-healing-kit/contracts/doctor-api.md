# Контракт: врач `@ykurilov/remontnik-doctor`

Служба на сервере приложения. Один процесс на приложение (R1). Слушает только внутреннюю сеть Docker.

## Окружение (только имена)

`REMONTNIK_CONFIG_REPO_DIR` (рабочая копия основной ветки), `REMONTNIK_STATE_DIR`, `REMONTNIK_SHARED_SECRET`, `REMONTNIK_GIT_TOKEN`, `DEEPSEEK_API_KEY`, `DEEPSEEK_BASE_URL?`, `OPENROUTER_API_KEY`, `OPENROUTER_BASE_URL?`, `PROXY_TOKEN?`, переменные из `reports.telegram.*Env`, `REMONTNIK_BROWSER_URL?`, `REMONTNIK_BROWSER_TOKEN?`, `REMONTNIK_REPORTS_TOKEN`.

## HTTP

Все запросы, кроме `/health`, подписаны HMAC общего секрета (как у сторожа) или несут `Authorization: Bearer <REMONTNIK_REPORTS_TOKEN>` (только `/v1/reports*`).

| Метод и путь | Тело / ответ | Назначение |
|---|---|---|
| `POST /v1/events` | см. watch-api | приём событий от сторожа |
| `POST /v1/control/deploys` | `{ action: "stop" \| "resume", by }` → `{ autoDeploy }` | стоп-кран (кнопка Telegram через приложение) |
| `GET /v1/reports?after=<reportId>&limit=50` | `{ reports: Report[], last }` | забор отчётов для Paseo |
| `POST /v1/reports/ack` | `{ upTo: reportId }` | подтверждение доставки в Paseo |
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
| `reports pull --after <id>` / `reports ack <id>` | то же, что HTTP, для забора по SSH |
| `check-config` | проверить настройку приложения и окружение, не запуская лечение |

## Инструменты модели врача

Постоянный набор (R3): `read`, `write`, `edit`, `bash` — внутри верстака; `case_info` — подробности случая и журналы (уже вычищенные); `browser_*` — команды браузера (при недоступной службе отвечают `unavailable`); `finish_diagnosis` (структурный ответ: причина, уверенность, план правки, затронутые места); `finish_fix` (сообщение коммита, что проверено). Git с удалённым репозиторием, выкатка и eval модели недоступны.
