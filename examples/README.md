# Образцы

Рабочие образцы подключения Ремонтника. Берите из них нужное в своё приложение.

- [`mini-app/`](./mini-app) — маленькое приложение со сторожем (`src/watch.js`), стоп-краном (`src/main.js`), настройкой (`remontnik.config.mjs`) и командами выкатки (`deploy/remontnik-deploy.mjs`). Сбой включается переменной `EXAMPLE_BUG=crash`.
- [`cycle-test/crash-cycle.test.ts`](./cycle-test/crash-cycle.test.ts) — тест полного цикла без настоящей модели: сбой → случай у врача → правка → выкатка → приложение здорово.

Образцы запускаются из репозитория Ремонтника: `pnpm build && pnpm test:examples`. Тест использует пакеты `@ykurilov/remontnik-*` по именам, так что в вашем проекте он работает после установки пакетов (в npm они появятся с выпуском 0.1.0).

## Раскладка и зависимости

- `mini-app/` самодостаточна: её `package.json` зовёт `@ykurilov/remontnik-core` и `@ykurilov/remontnik-watch`. Копируйте её содержимое в корень репозитория вашего приложения. Тест в `cycle-test/` ждёт соседнюю папку `../mini-app`; в своём проекте поправьте `appRoot` и путь к настройке.
- Тесты `cycle-test/` запускают врача в процессе теста, поэтому пакет `@ykurilov/remontnik-doctor` ставится в `devDependencies` (`pnpm add -D @ykurilov/remontnik-doctor`), а не в приложение. Рядом нужен `vitest`.
- Образец команд выкатки запускает приложение процессом `node`: только для стенда и теста. В бою замените запуск на `docker compose`; подробности — в `docs/getting-started.md`, шаг 4.
