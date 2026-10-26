# @ykurilov/remontnik-browser

Свой браузер врача Ремонтника: снимки страниц с номерами элементов, действия, сохранённые входы, живой экран владельца. Основа — `playwright-core` (точная версия) и Chromium. Пароль никогда не попадает к модели: ни в снимок, ни в ответ, ни в журнал.

## Запуск

```sh
remontnik-browser serve
```

Окружение:

| Переменная | Что это |
|---|---|
| `REMONTNIK_BROWSER_TOKEN` | ключ врача, не короче 16 знаков |
| `REMONTNIK_BROWSER_VAULT_KEY` | ключ хранилища входов: 32 байта в base64 |
| `REMONTNIK_BROWSER_DATA_DIR` | профили, входы (`logins.json`), снимки экрана |
| `REMONTNIK_BROWSER_POLICY` | путь к JSON: `allowedOrigins`, `allowedMutations`, `profiles` |
| `REMONTNIK_BROWSER_LISTEN` | адрес службы, по умолчанию `0.0.0.0:7700` |
| `REMONTNIK_BROWSER_LIVE_LISTEN` | адрес живого экрана, только частная сеть; не задан — живого экрана нет |
| `REMONTNIK_BROWSER_OWNER_TOKEN` | ключ владельца, не совпадает с ключом врача |
| `REMONTNIK_BROWSER_URL` | для консольных команд: адрес службы, по умолчанию `http://127.0.0.1:7700` |

Политика:

```json
{
  "allowedOrigins": ["https://app.example.com"],
  "allowedMutations": [{ "method": "POST", "pathPattern": "/api/chat" }],
  "profiles": [{ "name": "remontnik", "viewport": { "width": 1280, "height": 800 } }]
}
```

В `pathPattern` знак `*` — один кусок пути, `**` — весь остаток. Прокси задаётся в профиле (`proxy.server`, имя и пароль — через имена переменных `usernameEnv`, `passwordEnv`).

Образ: `deploy/browser.Dockerfile`.

## HTTP

`POST /v1/<команда>`, заголовок `Authorization: Bearer <ключ врача>`, тело — JSON. `GET /health` — без ключа.

| Команда | Вход | Успех |
|---|---|---|
| `open` | `{ profile }` | `{ ok }` — запускает профиль |
| `read`, `back` | `{ profile }` | `{ ok, url, title, snapshot }` |
| `url` | `{ profile, url }` | то же |
| `click` | `{ profile, ref, danger }` | то же |
| `type` | `{ profile, ref, text, submit?, danger }` | то же |
| `key` | `{ profile, key }` | то же |
| `scroll` | `{ profile, direction, px? }` | то же |
| `shot` | `{ profile }` | `{ ok, path }` — JPEG, поля пароля под маской |
| `logins` | `{ site? }` | `{ ok, logins: [{ id, site, login, profile }] }` |
| `fill-password` | `{ profile, entryId, ref }` | снимок |
| `status` | `{ profile }` | `{ ok, state: ready \| busy \| needs_human, reason? }` |

Отказ — `{ ok: false, code, message }`:

| `code` | Когда |
|---|---|
| `refused_origin` | сайт вне `allowedOrigins`; вход из хранилища от другого сайта |
| `refused_danger` | `danger` = `send`, `pay`, `delete`, `publish` |
| `refused_mutation` | изменяющий запрос вне `allowedMutations` (в `message` — метод и путь) |
| `refused_field` | `fill-password` не в поле пароля |
| `refused_profile` | вход из хранилища от другого профиля |
| `refused_human_control` | управление у владельца |
| `needs_human` | капча или запрос одноразового кода |
| `not_found` | нет профиля, номера элемента или входа |
| `bad_request` | неверный вход, например нет `danger` |
| `timeout` | страница не ответила вовремя |

HTTP-коды: неверный ключ — 401, неизвестная команда — 404, тело не объект — 400, сбой службы — 500 с `code: internal`.

## Консоль

```sh
remontnik-browser read -p remontnik
remontnik-browser click -p remontnik --ref e12 --danger none
remontnik-browser logins add --site https://app.example.com --login demo@example.com --profile remontnik --password-stdin
remontnik-browser logins list
remontnik-browser logins remove 3
```

Добавить и удалить вход можно только в консоли на сервере браузера. Пароль читается только из стандартного ввода; `--password` отклоняется.

## Живой экран

`GET /live?profile=<профиль>` на `REMONTNIK_BROWSER_LIVE_LISTEN`. Вход по ключу владельца, куки `HttpOnly`, `SameSite=Strict`. Не больше 5 попыток входа в минуту. Кадры идут по `WS /live/stream`, ввод владельца доходит, только пока он взял управление. Пока управление у владельца, врач получает `refused_human_control`. Нет связи с владельцем 2 минуты — управление возвращается врачу. Замки сайтов и запросов действуют и при ручном управлении.

## Решение T092: номера элементов

Закреплённая `playwright-core` 1.64.1 сама даёт снимок с номерами: `page.ariaSnapshot({ mode: 'ai' })` выдаёт `[ref=e12]`, а `page.getByRef('e12')` находит элемент. Номер того же элемента не меняется между снимками. Внутри фреймов номера вида `f1e2`.

Берём встроенные номера и дерево (`ariaSnapshotJSON`), а текст снимка собираем сами. Причина: встроенный текст показывает значение поля пароля открыто и не отличает поле пароля от обычного поля. Свой обход DOM с `data-remontnik-ref` не нужен: он менял бы страницу и повторял готовое.

Как скрываем пароль:

- Поле с `type=password` или `autocomplete=current-password`/`new-password` помечается «[поле пароля]» и остаётся помеченным, даже если страница сменит тип поля (кнопка «глаз»).
- Поле, куда служба вписала пароль, помечается «[пароль вписан]» навсегда.
- Значения таких полей в снимке — «[скрыто]», на снимке экрана — под маской.
- Последняя страховка — фильтр выхода: он вырезает все сохранённые пароли (как есть, в адресе, в JSON и в base64) из ответов и журналов.

## Замки паролей

1. Каждый вход шифруется AES-256-GCM; сайт, профиль и логин входят в проверку подлинности.
2. Пароль попадает в хранилище только из стандартного ввода.
3. `fill-password` вписывает только в поле пароля и только на сайте входа или его поддомене, в том числе внутри фрейма.
4. Команды выполнения своего кода на странице нет.
5. Снимок скрывает значения.
6. Снимок экрана закрывает поля маской.
7. Фильтр выхода вырезает пароли из всего, что уходит наружу.
