# Контракт: браузер `@ykurilov/remontnik-browser`

Служба в своём контейнере на сервере приложения, только во внутренней сети Docker. Основа — `playwright-core` + Chromium. Прокси выключен, если в профиле не задан.

## Окружение (только имена)

`REMONTNIK_BROWSER_TOKEN` (ключ врача), `REMONTNIK_BROWSER_VAULT_KEY` (32 байта, base64; есть только в этом контейнере), `REMONTNIK_BROWSER_DATA_DIR`, `REMONTNIK_BROWSER_POLICY` (путь к JSON с `allowedOrigins`, `allowedMutations`, профилями).

## HTTP `POST /v1/<команда>` с `Authorization: Bearer`

Каждая команда страницы принимает `profile` (обязателен всегда, как `-p` у образца).

| Команда | Вход | Выход |
|---|---|---|
| `open` | `{ profile }` | `{ ok }` |
| `url` | `{ profile, url }` | снимок; отказ `refused_origin` |
| `back` | `{ profile }` | снимок |
| `read` | `{ profile }` | `{ url, title, snapshot }` — текст с номерами элементов `e12`; значения полей пароля скрыты |
| `click` | `{ profile, ref, danger }` | снимок; отказ `refused_danger`, `refused_mutation` |
| `type` | `{ profile, ref, text, submit?, danger }` | снимок |
| `key` | `{ profile, key }` | снимок |
| `scroll` | `{ profile, direction, px? }` | снимок |
| `shot` | `{ profile }` | `{ path }` — JPEG, поля пароля под маской |
| `logins` | `{ site? }` | `{ logins: { id, site, login, profile }[] }` — без паролей |
| `fill-password` | `{ profile, entryId, ref }` | снимок; отказ, если поле не пароль или сайт не тот |
| `status` | `{ profile }` | `{ state: "ready" \| "busy" \| "needs_human", reason? }` |

`danger`: `none` \| `submit` \| `send` \| `pay` \| `delete` \| `publish`. `send`, `pay`, `delete`, `publish` отклоняются всегда.

Любой ответ при капче или запросе кода: `{ ok: false, code: "needs_human", message }`.

## Консольная `remontnik-browser`

Те же команды для агентов на сервере (`remontnik-browser read -p <профиль>`), плюс управление входами, которое по HTTP недоступно:

- `logins add --site <origin> --login <логин> --profile <профиль> --password-stdin`
- `logins remove <id>`

Пароль читается только из стандартного ввода; в аргументах и журналах его нет.

## Жёсткие правила службы

- Нет команды выполнения своего кода на странице.
- Сетевой замок: изменяющие запросы к сайтам приложения — только по `allowedMutations`; остальные блокируются и пишутся в журнал.
- Переходы и запросы верхнего уровня — только на `allowedOrigins`.
- Фильтр выхода вырезает значения всех сохранённых паролей из любых ответов и журналов.
