---
'@ykurilov/remontnik-doctor': patch
'@ykurilov/remontnik-core': patch
'@ykurilov/remontnik-browser': patch
---

- **Приложение в сети сервера (`network_mode: host`).** Такое приложение не подключается к сети Docker. Для него есть добавка `deploy/compose.remontnik.host-app.yml`. Сеть приёма создаёт сам Ремонтник, приём опубликован только на `127.0.0.1` сервера (`REMONTNIK_HOST_PORT`, по умолчанию 7800), у сторожа `REMONTNIK_DOCTOR_URL=http://127.0.0.1:<порт>`. От браузера врача, сетей случая и других машин приём по-прежнему закрыт. Нужен Docker 28 или новее. `check-config` проверяет, что порт опубликован только на `127.0.0.1` и ведёт в сеть приёма (`gw_priority`).
- **`compose.remontnik.yml` читается в Docker Compose v5.** Раньше строка `aliases: [${REMONTNIK_DOCTOR_ALIAS:-…}]` давала ошибку разбора «did not find expected ','». Теперь имя в кавычках.
- **`origin` у `allowedMutations`.** Необязательное поле: точный сайт из `allowedOrigins`, правило действует только на нём. Нужно для входа через отдельный сервис авторизации. Без поля всё как раньше. `origin` вне `allowedOrigins` отклоняют служба браузера при старте и `check-config`.
- **Документы.** Рецепт «вход через сервис авторизации» (шаг 12 `docs/getting-started.md`, `docs/security.md`). Правила по умолчанию: копия кода у врача — чистый клон основной ветки; ручная выкатка — только из закоммиченного состояния с текущей `origin/<основная ветка>`, с примером проверки на `git`; ключи моделей Ремонтника — свои, с месячным лимитом у поставщика; бот тревог — тот же бот, что у приложения.

### Как обновить приложение

1. Поднять `@ykurilov/remontnik-watch` и `@ykurilov/remontnik-core` до новой версии точными версиями. На сервере перевести клон Ремонтника на метку новой версии и пересобрать врача и браузер (`docker compose -f deploy/compose.remontnik.yml up -d --build`, с браузером — ещё `--profile browser`).
2. Приложение запущено с `network_mode: host` — перейти на добавку: в `.env` Ремонтника `REMONTNIK_APP_NETWORK` — новое имя сети приёма (например, `remontnik-intake`; её создаст сам Ремонтник), по желанию `REMONTNIK_HOST_PORT`. Запуск: `docker compose -f deploy/compose.remontnik.yml -f deploy/compose.remontnik.host-app.yml up -d --build`, второй `-f` — во всех командах `docker compose`. У сторожа `REMONTNIK_DOCTOR_URL=http://127.0.0.1:<REMONTNIK_HOST_PORT>`. Приложение в сети Docker — ничего не менять.
3. Вход в кабинет идёт через сервис авторизации на другом сайте — по рецепту шага 12 `docs/getting-started.md`: сайт сервиса в `allowedOrigins`, вход заведён на сайт сервиса, правило формы входа в `allowedMutations` с `origin` сервиса. Одинаково в политике браузера и в `remontnik.config.ts`.
4. Сверить сервер с правилами по умолчанию из `docs/getting-started.md` (шаги 4, 6, 7). Скрипт ручной выкатки отказывает при незакоммиченных правках и без текущей `origin/<основная ветка>` в выкатываемом коммите. Копия у врача — чистый клон. Ключи моделей Ремонтника отдельные, с месячным лимитом.
5. Проверить внутри контейнера врача (`docker compose ... exec doctor remontnik-doctor check-config`): ошибок нет.
