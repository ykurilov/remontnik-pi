# Модель данных: Ремонтник Pi

Где живёт: у сторожа — файлы очереди в папке `REMONTNIK_WATCH_DIR` приложения; у врача — документы и задачи pi-durable в одном файле SQLite (`REMONTNIK_STATE_DIR/doctor.sqlite`); у браузера — зашифрованный файл входов и папки профилей на своём томе.

## Сторож

### IncidentEvent — одно появление сбоя (очередь сторожа → врач)

| Поле | Тип | Правила |
|---|---|---|
| `eventId` | ULID | уникален; ключ повторной доставки |
| `appName` | string | из настройки |
| `kind` | `crash` \| `model_error` \| `tool_error` \| `turn_failed` \| `bad_answer` \| `manual` | |
| `fingerprint` | string (sha256, 16 символов) | вид + место + нормализованный текст (R10) |
| `where` | string | первая строка следа внутри кода приложения, или имя инструмента/модели |
| `message` | string ≤ 2000 | после вычистки секретов и личных данных |
| `stack` | string ≤ 8000 | после вычистки |
| `context` | объект ≤ 4 КБ | `processName`, `release` (версия из `current`), `chatId`, `model`, `provider`, `tool` |
| `badAnswer` | объект? | только для `bad_answer`: `conversationId`, `messageIndex`, `category`, `excerpt` ≤ 500, `explanation`, `confidence` 0..1 |
| `occurredAt` | ISO-время | |

### OutboxEntry — строка JSONL очереди

`{ event: IncidentEvent, state: "pending" | "delivered", attempts, nextAttemptAt }`. Подтверждение пишется отдельной строкой `{ ack: eventId }`. Файл сжимается при старте: подтверждённые строки старше суток выбрасываются.

### LocalIncidentState — счётчики для Telegram у сторожа

`{ fingerprint, count, firstSeenAt, lastSeenAt, lastNotifiedAt, lastNotifiedCount }`. Правило повтора сообщения: прошёл час с `lastNotifiedAt` и `count > lastNotifiedCount`.

### ConversationReviewJob

`{ conversationId, finishedAt, messages (после маскировки), meta, state: "queued" | "reviewed" | "deferred_budget", findings[] }`.

### WatchSpend — расход сторожа за сутки

`{ day (по поясу из настройки), usd, reviews, deferred }`.

## Врач

### Case — случай (документ `remontnik.case/<caseId>`)

| Поле | Тип | Правила |
|---|---|---|
| `caseId` | число, по порядку | |
| `fingerprint` | string | один открытый случай на отпечаток; новые события склеиваются |
| `kind`, `where`, `message`, `stack` | как у события | из первого события |
| `events` | число | счётчик |
| `firstSeenAt`, `lastSeenAt` | время | |
| `linkedEventIds` | ULID[] ≤ 50 | последние |
| `state` | см. ниже | |
| `treatmentTaskId` | string? | задача pi-durable |
| `reportIds` | number[] | |

**Состояния случая**:

```text
received → triage → diagnosing → fixing → verifying → gated
gated → deploying → observing → healed
gated → report_only            (решение «только отчёт»)
observing → rolled_back → needs_human
observing → not_helped         (тот же отпечаток повторился без ухудшения)
diagnosing → no_cause_found    (бюджет исчерпан)
любое → deferred_budget        (потолок расходов; продолжится завтра)
любое → stand_broken           (сломан стенд проверок)
```

### Treatment — лечение (чекпойнт задачи `remontnik.treatment`)

| Поле | Тип |
|---|---|
| `caseId` | число |
| `baseCommit` | sha основы |
| `branch` | `remontnik/<caseId>-<slug>` |
| `worktreePath` | путь на сервере |
| `conversationId` | переписка pi-durable с моделью |
| `commits` | `{ sha, message }[]` |
| `changedFiles` | `{ path, added, removed, status }[]` |
| `checks` | `CheckResult` |
| `gate` | `GateDecision` |
| `spendUsd` | число |
| `phase` | имя фазы задачи |
| `pendingEffect` | `EffectIntent?` — намерение внешнего действия, записанное до его выполнения |

### CheckResult

`{ tests: { status: "green" | "red" | "flaky" | "not_run", failed: string[], durationMs }, eval: { status: "not_needed" | "not_worse" | "worse" | "stand_broken" | "not_run", scenarios: { id, basePass, candidatePass, repeats }[], costUsd }, browser: "checked" | "unavailable" | "skipped" }`

### GateDecision

`{ verdict: "deploy" | "report_only", reasons: GateReason[] }`; `GateReason` — код из списка R6 (`tests_not_green`, `eval_worse`, `forbidden_zone`, `existing_test_changed`, `suspicious_change`, `diff_too_large`, `stop_switch`, `attempts_exhausted`, `needs_human_after_rollback`, `budget_exhausted`, `rebase_conflict`) + подробности (пути, числа).

### Deployment — выкатка (документ `remontnik.deployment/<id>`)

| Поле | Тип |
|---|---|
| `deploymentId` | число |
| `caseId` | число |
| `previousVersion` | строка из `current` до выкатки |
| `preDeployTag` | `remontnik/pre-deploy/<дата>-<caseId>` |
| `candidateVersion` | sha правки |
| `startedAt`, `promotedAt`, `endedAt` | время |
| `baseline` | `{ errorsPerHour, knownFingerprints7d[] }` |
| `observeUntil` | время конца окна |
| `outcome` | `in_progress` \| `holding` \| `rolled_back` \| `superseded_by_human` \| `rollback_failed` |
| `rollbackReason` | string? |

### FingerprintLedger — защита от циклов (документ `remontnik.ledger`)

`{ [fingerprint]: { autoDeploys: { at, deploymentId }[], rolledBackAt?, needsHuman: boolean } }` + `{ deploysToday: { day, count } }`. Снятие `needsHuman` — только командой владельца.

### SpendLedger (документ `remontnik.spend`)

`{ day, modelUsd, evalUsd, limits: { modelUsd, evalUsd } }`. Перед каждым обращением к модели и перед каждым прогоном eval — проверка; учёт с запасом 10% (R1).

### Controls (документ `remontnik.controls`)

`{ autoDeploy: "on" | "stopped", stoppedBy?, stoppedAt? }`.

### Report — отчёт (документ `remontnik.report/<reportId>`)

| Поле | Тип |
|---|---|
| `reportId` | число, по порядку (курсор для Paseo) |
| `caseId` | число? |
| `type` | `case_received` \| `cause_found` \| `fix_ready` \| `deployed` \| `rolled_back` \| `not_helped` \| `needs_human` \| `no_cause_found` \| `budget_reached` \| `stand_broken` \| `doctor_problem` |
| `short` | string ≤ 1000 (для Telegram) |
| `full` | Markdown |
| `screenshots` | пути к снимкам браузера? |
| `telegram` | `{ state: "pending" | "sent" | "failed", attempts, messageId? }` |
| `createdAt` | время |

## Браузер

### LoginEntry — сохранённый вход (зашифрованный файл)

| Поле | Тип | Правила |
|---|---|---|
| `id` | число | |
| `site` | origin (`https://…`) | пароль вписывается только сюда и на поддомены |
| `login` | string | показывается в `logins` |
| `secret` | шифротекст AES-256-GCM | наружу не отдаётся никогда |
| `profile` | string | вход только в этом профиле |
| `createdAt` | время | |

### BrowserProfile

`{ name, dataDir, proxy?: { server, usernameEnv?, passwordEnv? } }` — из настройки; прокси выключен по умолчанию.

### BrowserPolicy (из настройки приложения)

`{ allowedOrigins: string[], allowedMutations: { method, pathPattern }[], pagesToCheck: { url, expectText? }[] }`.

### ActionResult

`{ ok: true, ... } | { ok: false, code: "refused_danger" | "refused_origin" | "refused_mutation" | "needs_human" | "not_found" | "unavailable" | "timeout", message }`.

## Настройка приложения

Описана контрактом [contracts/remontnik-config.md](./contracts/remontnik-config.md).
