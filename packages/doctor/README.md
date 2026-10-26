# @ykurilov/remontnik-doctor

Врач Ремонтника: служба на сервере приложения. Принимает случаи от сторожа, лечит их в отдельной ветке и сообщает владельцу.
Хранилище и задачи — pi-durable 1.4.0, модели — pi-ai 1.4.0.

## Лечение

Каждый новый случай получает свой разговор (без владельца) и фоновую задачу `remontnik.treatment` в нём —
в той же транзакции, что и сам случай. Задача работает по фазам; каждая фаза заканчивается чекпойнтом,
поэтому перезапуск врача продолжает с последней фазы.

| Фаза | Что делает | Куда дальше |
|---|---|---|
| `triage` | Берёт настройку из основной ветки, запоминает основу (`origin/<mainBranch>`), создаёт верстак, собирает системный промпт, заводит разговор модели | `diagnosing` |
| `diagnosing` | Просит модель найти причину (`diagnose:<caseId>`), следит за расходом | `fixing` или отчёт `no_cause_found` |
| `fixing` | Просит правку и тест (`fix:<caseId>`), коммитит её в ветку `remontnik/<caseId>-<slug>` | `verifying` или отчёт `cause_found` |
| `verifying` | Тесты и eval в отдельных копиях правки и основы, отправка ветки в origin | отчёт `fix_ready`, `cause_found` или `stand_broken` |

Итог задачи — `TreatmentResult`: `outcome`, номер отчёта, ветка, коммит правки, изменённые пути, итог проверок.
Сейчас врач только сообщает (состояние случая `report_only`); решение о выкатке добавит этап 5.

Модель работает в отдельном разговоре, которым владеет задача. Его настройка постоянна для одной основы:
модель, одно расширение `remontnik.doctor`, системный промпт (`model/system-prompt.ts`), папка верстака.
Всё, что меняется от случая к случаю, идёт в сообщениях (`model/case-messages.ts`). Так кэш модели не сбрасывается.

Документ `TreatmentDoc` (`remontnik.treatment`, на разговор модели) хранит верстак, сведения о случае,
диагноз и итог правки. Инструменты `finish_diagnosis` и `finish_fix` пишут в него и заканчивают ход модели.

Инструменты модели, всегда в этом порядке: `read`, `write`, `edit`, `bash`, `case_info`, `finish_diagnosis`, `finish_fix`.
Перехватчик `beforeTool` ставит каждой команде `bash` тайм-аут (не больше `workbench.bashTimeoutMs`) и не пропускает `git`.

Потолок расходов модели на случай — `limits.diagnoseUsdPerCase`, а если его нет — `limits.modelUsdPerDay`.
Расход считается по документу `UsageDoc` разговора модели; превысил — ход модели прерывается.

## Окружение выполнения (pi-durable 1.4.0)

Встроенные инструменты pi-durable (`read`, `write`, `edit`, `bash`) работают не с диском напрямую, а с
окружением выполнения `ExecutionEnv` из `@earendil-works/pi-durable/env`. Его даёт функция
`HarnessOptions.env(target, context)`:

- `target` — `{ conversationId, cwd?, read }`; `read.snapshot(doc, conversationId, context)` читает документы разговора;
- вызывается при каждом вызове инструмента и при сборке промпта, может быть асинхронной;
- `undefined` — окружения нет, инструмент отвечает ошибкой; исключение тоже становится ошибкой инструмента;
- в транзакции Session не вызывается.

`ExecutionEnv` = файловая система + оболочка. Все методы получают `Context` и возвращают `Result` (`ok` / `err`), а не бросают:

- файлы: `readTextFile`, `readTextLines`, `openTextLineReader`, `readBinaryFile`, `openBinaryReader`, `writeFile`,
  `appendFile`, `truncateFile`, `flushFile`, `renameFile`, `fileInfo`, `listDir`, `openDirReader`, `exists`,
  `createDir`, `remove`, `canonicalPath`, `absolutePath`, `joinPath`, `createTempDir`, `createTempFile`, `watch`, `cleanup`;
  ошибки — `FileError` с кодом (`permission_denied`, `not_found` и др.);
- оболочка: `exec(command, { cwd, env, inheritEnv, timeout (секунды), onOutput, spill, window }, context)` →
  `{ exitCode, spillPath? }` или `ExecutionError` (`timeout`, `aborted`, `spawn_error`).

Врач подставляет `createWorkbenchEnvFactory({ runner })`: по `TreatmentDoc` разговора строится `ContainerExecutionEnv`.

- Файлы — только внутри копии. Пути в `.git`, закрытые пути и всё вне копии — `permission_denied`.
  Символьные ссылки разворачиваются до проверки.
- Команды идут через исполнитель (`CommandRunner`):
  - `createDockerRunner` — `docker exec` в контейнере;
  - `createLocalRunner` — на этой машине, для проверок.
- Окружение врача командам не передаётся: только `PATH`, временный `HOME`, `CI=1`, `GIT_DIR=/nonexistent`.
- Тайм-аут обязателен: не больше `maxTimeoutSeconds`.
- `watch` не поддерживается. `spill` и `window` пока не учитываются: вывод приходит целиком.

Закрытых путей (`closedPaths`) в копии нет физически: `git worktree` создаётся без них.

## Для тестов

`@ykurilov/remontnik-doctor/testing`:

- `testRemontnikConfig()` — рабочая настройка приложения;
- `createScriptedModel()` — модель по сценарию поверх подставного поставщика pi-ai: `script(...)` задаёт ответы
  (`callTool`, `say`, `hang`), `requests` хранит, что модель получила, `costPerResponseUsd` задаёт цену ответа.
