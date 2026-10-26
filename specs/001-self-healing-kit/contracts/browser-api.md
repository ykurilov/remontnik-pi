# Контракт: браузер `@ykurilov/remontnik-browser`

Служба в своём контейнере на сервере приложения, только во внутренней сети Docker. Основа — `playwright-core` + Chromium. Прокси выключен, если в профиле не задан.

## Окружение (только имена)

`REMONTNIK_BROWSER_TOKEN` (ключ врача), `REMONTNIK_BROWSER_VAULT_KEY` (32 байта, base64; есть только в этом контейнере), `REMONTNIK_BROWSER_DATA_DIR`, `REMONTNIK_BROWSER_POLICY` (путь к JSON с `allowedOrigins`, `allowedMutations`, профилями), `REMONTNIK_BROWSER_LIVE_LISTEN?`, `REMONTNIK_BROWSER_OWNER_TOKEN?` (живой экран). `REMONTNIK_BROWSER_LISTEN?` — адрес службы, по умолчанию `127.0.0.1:7700`; «все адреса» — только явно (в образе), порт — только во внутреннюю сеть. Для консольных команд — `REMONTNIK_BROWSER_URL?` (по умолчанию `http://127.0.0.1:7700`).

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

Ещё коды отказа: `refused_field` (`fill-password` не в поле пароля), `refused_profile` (вход от другого профиля), `refused_human_control`, `not_found`, `bad_request`, `timeout`. Неверный ключ — HTTP 401; больше 10 неверных за минуту с одного адреса — 429 `too_many_attempts`.

Опасность цели служба проверяет сама — по подписи, тексту и адресу элемента (для `key` Enter/Space — элемента в фокусе, для отправки формы — её кнопок), независимо от `danger`. После `needs_human` доступны только `read` и `shot`, пока владелец не вернёт управление или `read` не перестанет видеть проверку. `fill-password` — только точный origin входа и `https:` (кроме `localhost`/`127.0.0.1`).

## Живой экран (только для владельца)

Отдельный адрес службы, слушает только `REMONTNIK_BROWSER_LIVE_LISTEN` (адрес частной сети). Не включается, если переменная не задана. Ключ — `REMONTNIK_BROWSER_OWNER_TOKEN`, ключ врача сюда не подходит.

| Адрес | Что делает |
|---|---|
| `GET /live?profile=<профиль>` | страница: вход по ключу владельца (куки `HttpOnly`, `SameSite=Strict`), экран, кнопки «Взять управление» / «Вернуть»; работает с телефона |
| `WS /live/stream?profile=` | кадры JPEG от сервера; от владельца — мышь, касания, клавиши, текст (только при взятом управлении) |
| `POST /live/control` | `{ profile, action: "take" \| "release" }` |

Пока управление у владельца, команды врача по HTTP отвечают `{ ok: false, code: "refused_human_control" }`. Связь владельца пропала на 2 минуты — управление возвращается врачу. Кадры не пишутся в журналы и не отдаются по командам врача.

## Консольная `remontnik-browser`

Те же команды для агентов на сервере (`remontnik-browser read -p <профиль>`), плюс управление входами, которое по HTTP недоступно:

- `logins add --site <origin> --login <логин> --profile <профиль> --password-stdin`
- `logins remove <id>`

Пароль читается только из стандартного ввода; в аргументах и журналах его нет.

## Жёсткие правила службы

- Нет команды выполнения своего кода на странице.
- Сетевой замок: изменяющие запросы к сайтам приложения — только по `allowedMutations`; остальные блокируются и пишутся в журнал.
- Переходы верхнего уровня и фреймов — только на `allowedOrigins`; фрейм чужого сайта скрыт из снимка и не принимает действий.
- Не ловится: `GET` с побочным действием и запросы под слишком широкий шаблон `allowedMutations`.
- Фильтр выхода вырезает значения всех сохранённых паролей из любых ответов и журналов (в том числе в HTML, `%xx`, hex, base64); при сбое фильтра текст не выводится. От преобразований страницей не защищает. Пароль короче 8 знаков не сохраняется.
- Куки живого экрана без `Secure`: только частный шифрованный канал или TLS за прокси. Подбор ключей ограничен по адресу клиента.
