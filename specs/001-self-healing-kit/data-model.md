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

`{ event: IncidentEvent, state: "pending" | "delivered", attempts, nextAttemptAt, notify, repeats, lostBefore }`. Изменения — отдельными строками: `{ ack }`, `{ retry, attempts, nextAttemptAt }`, `{ notified }`, `{ repeats, count }`, `{ drop }`, `{ lost }`.

- Подтверждённое врачом событие сразу уходит из памяти; `delivered` — только пока ждёт своей тревоги в Telegram.
- Файл сжимается при старте и на ходу, когда строк вдвое больше записей (не меньше 1000).
- Потолок — `maxQueue` записей (по умолчанию 1000). Повтор отпечатка при полной очереди склеивается в `repeats` последней записи; иначе самые старые вытесняются, новая запись получает `lostBefore`, общий счётчик — `lost`. Врачу `repeats` и `lostBefore` уходят в `context`.
- Замок `outbox-<processName>.lock` (`pid:метка`). Второй живой экземпляр с тем же именем пишет в `outbox-<processName>.<pid>-<метка>.jsonl` и предупреждает строкой `[remontnik]`; хозяин основного файла при старте забирает такие файлы умерших экземпляров.

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
| `appName` | string | из события; ключ склейки — `appName` + `fingerprint` |
| `processName` | string? | процесс первого события (`context.processName`) |
| `fingerprint` | string | один открытый случай на приложение и отпечаток; новые события склеиваются |
| `kind`, `where`, `message`, `stack` | как у события | из первого события |
| `badAnswer` | объект? | только для `bad_answer`: как у события, из первого события; врачу-модели подаётся вычищенным и помеченным как данные, а не поручение |
| `events` | число | счётчик появлений, с учётом `context.repeats` от сторожа |
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

режим «сначала Paseo» (R18):
received → handoff_check → triage                 (мост не отвечает)
handoff_check → handed_off → paseo_working
paseo_working → observing                         (агент выкатил)
paseo_working → healed_by_paseo                   (агент сделал без выкатки; итог — у агента)
handed_off | paseo_working → reclaimed → triage    (срок вышел, «не смог», мост пропал)
```

Закрыты только `healed` и `healed_by_paseo`: после них тот же отпечаток открывает новый случай. Повторы после `report_only`, `needs_human` и других итогов без лечения склеиваются в открытый случай — владелец уже знает о сбое, второй случай был бы шумом.

Отчёт `case_received` пишется в той же транзакции, что и новый случай.

### Handoff — передача агенту Paseo (документ `remontnik.handoff/<caseId>`)

| Поле | Тип | Правила |
|---|---|---|
| `caseId` | число | один документ на случай |
| `owner` | `paseo` \| `doctor` | врач лечит сам только после записи `doctor` |
| `taskId` | ULID | номер задачи у моста |
| `sentAt`, `acceptedAt?`, `finishedAt?` | время | |
| `acceptDeadline`, `workDeadline` | время | из `handoff.paseo.acceptTimeoutMs` / `workTimeoutMs` |
| `result?` | `{ kind: "done", commit?, deployed: boolean, version? }` \| `{ kind: "cannot", reason ≤ 1000 }` | |
| `reclaimReason?` | `bridge_unreachable` \| `accept_timeout` \| `work_timeout` \| `cannot` | |
| `lateResult?` | как `result` | итог, пришедший после `reclaimed`; только в отчёт |

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

`{ verdict: "deploy" | "report_only", reasons: GateReason[] }`; `GateReason` — код из списка R6 (`tests_not_green`, `eval_worse`, `forbidden_zone`, `protected_path` — правка вне `fixablePaths` или в том, чем врач её проверяет и собирает, `existing_test_changed`, `suspicious_change`, `diff_too_large`, `stop_switch`, `attempts_exhausted`, `needs_human_after_rollback`, `budget_exhausted`, `rebase_conflict`, `facts_invalid` — факты неполные или невозможные: нет данных = нет выкатки) + подробности (пути, числа).

### Deployment — выкатка (документ `remontnik.deployment/<id>`)

| Поле | Тип |
|---|---|
| `deploymentId` | число |
| `caseId`, `appName`, `fingerprint` | случай и его отпечаток |
| `previousVersion` | полный sha из `current` до выкатки |
| `lockToken` | случайный знак выкатки в строке замка: по нему врач узнаёт свой замок |
| `taskId?` | задача pi-durable, которая ведёт выкатку: умерла — замок выкатки брошен |
| `mainCopy?` | снимок рабочей копии основной ветки в начале: `{ commit, dirty: { путь: sha256 }, files: { путь: sha256 } }`; в `dirty` дописываются файлы своих `promote` и `rollback` |
| `preDeployTag` | `remontnik/pre-deploy/<дата>-<caseId>-<deploymentId>` |
| `candidateVersion` | sha правки |
| `candidateDir` | рабочая копия правки, где идёт `build` |
| `stage` | `starting` \| `locked` \| `tagging` \| `building` \| `promoting` \| `observing` \| `rolling_back` \| `confirming` \| `done` — шаг, с которого выкатка продолжится после перезапуска |
| `startedAt`, `promotedAt`, `endedAt`, `waitingLockSince?`, `lockWaitReportedAt?`, `leftoverLockReportedAt?` | время; `promotedAt` — когда `current` подтвердил кандидата; `lockWaitReportedAt` — когда позвал человека из-за долгого замка; `leftoverLockReportedAt?` — из-за `<замок>.stale-*` |
| `baseline` | `{ errorsPerHour, knownFingerprints7d[] }` |
| `observeUntil`, `nextTickAt` | конец окна и следующий тик наблюдения |
| `observation`, `lastTick` | сбои здоровья подряд, итоги последних проверок, число проверок окна и последний замер ошибок |
| `promoteRequested` | намерение `promote` записано: дальше по `current` видно, прошёл ли он |
| `promoteLaunched?` | `promote` запускали (записано прямо перед запуском): только после него новые файлы копии могут быть его |
| `promoteReturnedAt?` | когда `promote` вернулся: с этой минуты считаются ошибки кандидата |
| `outcome` | `in_progress` \| `holding` \| `not_helped` \| `rolled_back` \| `superseded_by_human` \| `rollback_failed` \| `refused` \| `abandoned` (замок потерян посреди выкатки или её задача умерла) |
| `refusal` | при `refused`: `stop_switch` \| `current_unavailable` \| `no_previous_build` \| `already_running` \| `tag_failed` \| `build_failed` \| `promote_failed` \| `main_copy_changed` \| `lock_lost` \| `unconfirmed_version` |
| `rollbackCause`, `rollbackReason`, `rollbackAttempts`, `nextRollbackAt?` | почему откатывал (в том числе `current_unavailable`, `reverted`, `main_copy_changed`), сколько законченных попыток (не больше 3) и когда следующая |
| `rollbackLaunches?` | все запуски `rollback`, и прерванные падением врача; записывается до запуска, не больше 6 |
| `mainCopyChange?` | чем рабочая копия основной ветки разошлась со снимком во время отката |
| `healthyAfterRollback`, `healthAfterRollback` | здоровье после отката |
| `supersededBy`, `confirmFailed`, `detail` | версия человека, сбой `confirm`, хвост вывода для отчёта |
| `abandonedBy?` | какая выкатка сняла замок этой, когда её задача умерла |

Повтор той же правки по тому же случаю находит прежнюю выкатку (индекс `remontnik.deployment-index`), а не начинает вторую. В том же индексе `abandonedVersions` — кандидаты брошенных выкаток (задача умерла или замок потерян), успевших записать намерение `promote`: такая версия не считается прежней, пока владелец её не подтвердит (`deploys confirm`).

### ErrorHour — ошибки приложения по часам (документ `remontnik.error-hour/<app>/<YYYY-MM-DDTHH>`)

`{ minutes: { [минута]: число }, fingerprints: { [fp]: { count, lastAt } }, overflow }` — не больше 200 отпечатков в часе. Пишется книгой случаев вместе с приёмом события. Из него — уровень ошибок до выкатки (больший из «последний час» и «сутки / 24») и известные за 7 дней отпечатки.

Список записанных часов приложения — `remontnik.error-hour-index/<app>`: `{ hours: ["YYYY-MM-DDTHH"], seeded?: true }`. Когда начинается новый час, часы старше 8 дней от самого нового удаляются в той же записи; запоздавшее событие старше этого срока не считается. Часы, записанные до появления списка, врач один раз на приложение находит перебором за 60 дней, вносит в список и удаляет старые; после этого в списке `seeded: true`.

### FingerprintLedger — защита от циклов (документ `remontnik.ledger`)

`{ [fingerprint]: { autoDeploys: { at, deploymentId }[], rolledBackAt?, needsHuman: boolean } }` + `{ deploysToday: { day, count } }`. Снятие `needsHuman` — только командой владельца.

### SpendLedger (документ `remontnik.spend`)

`{ day, modelUsd, evalUsd, limits: { modelUsd, evalUsd } }`. Перед каждым обращением к модели и перед каждым прогоном eval — проверка; учёт с запасом 10% (R1).

Бронь eval случая: `{ reservedUsd, actualUsd?, observedUsd?, inFlightUsd? }`. Бронируется доля случая (`limits.evalUsdPerCase`, не больше остатка дня) прямо перед запуском команды eval. `observedUsd` (факт) и `inFlightUsd` (брони запросов в пути) пишет прокси врача по ходу прогона; бронь запроса записывается до его отправки поставщику. Обрыв или перезапуск закрывают бронь суммой `observedUsd + inFlightUsd`; ничего не записано — нулём.

### Controls (документ `remontnik.controls`)

`{ autoDeploy: "on" | "stopped", stoppedBy?, stoppedAt? }`. Меняется командой `remontnik-doctor deploys stop|resume` и подписанным `POST /v1/control/deploys` `{ action: "stop" | "resume", by }`; состояние видно в `/health` (`autoDeploy`).

### Report — отчёт (документ `remontnik.report/<reportId>`)

| Поле | Тип |
|---|---|
| `reportId` | число, по порядку (курсор для Paseo) |
| `caseId` | число? |
| `type` | `case_received` \| `cause_found` \| `fix_ready` \| `deployed` \| `rolled_back` \| `not_helped` \| `needs_human` \| `no_cause_found` \| `budget_reached` \| `stand_broken` \| `doctor_problem` \| `handed_off` \| `paseo_done` \| `reclaimed` |
| `short` | string ≤ 1000 (для Telegram) |
| `full` | Markdown |
| `screenshots` | пути к снимкам браузера?, не больше 10 |
| `telegram` | `{ state: "pending" | "sent" | "failed" | "not_needed", attempts, messageId? }`; `not_needed` — только для журнала и Paseo (например, `case_received`: о сбое владелец уже узнал от сторожа) |
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

`{ ok: true, ... } | { ok: false, code: "refused_danger" | "refused_origin" | "refused_mutation" | "refused_human_control" | "needs_human" | "not_found" | "unavailable" | "timeout", message }`.

## Настройка приложения

Описана контрактом [contracts/remontnik-config.md](./contracts/remontnik-config.md).
