# Выпуск

Все пакеты `@ykurilov/remontnik-*` выходят одной версией через [changesets](https://github.com/changesets/changesets).

1. Для каждой правки пакета: `pnpm changeset`.
2. Перед выпуском на основной ветке: `pnpm verify`, затем `pnpm check-history --trees` (`gitleaks` и `check-public` по всей истории, `.private/` вне git) и `check-public` с частным запретным списком (`~/.config/remontnik/denylist.txt`, вне репозитория).
3. `pnpm changeset version` — поднимает версии и пишет журнал изменений пакетов.
4. В [CHANGES.md](./CHANGES.md) добавить раздел новой версии: что изменилось и «Как обновить приложение» — пошагово, для агента, который обновляет приложение.
5. `pnpm build && pnpm changeset publish`, затем метка git `v<версия>`.

Пока версия `0.x`: `minor` — новая возможность или ломающее изменение, `patch` — исправление.

`@earendil-works/pi-durable`, `pi-ai` и `chord` закреплены точно и не обновляются сами. Обновление — отдельная задача: прочитать их журнал изменений, поднять версию вручную, прогнать тесты, включая падения.
