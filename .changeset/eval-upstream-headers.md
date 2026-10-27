---
'@ykurilov/remontnik-doctor': patch
'@ykurilov/remontnik-core': patch
---

- **Заголовки к поставщику модели в eval.** У поставщика `checks.eval.providers[]` есть необязательное поле `upstreamHeaders`: список `{ name, valueEnv }`. Нужно, когда сервер приложения достаёт до поставщика только через свой обратный прокси, а тому нужен ещё один секрет (например, токен прокси). `valueEnv` — переменная в окружении врача, как `keyEnv`. Значение ставит только прокси врача: одноимённый заголовок от eval не проходит, в eval, отчёты и журналы значение не попадает. Нельзя задать заголовки прокси (`authorization`, `x-api-key`, `api-key`, `proxy-*`, `host`, `content-length`, `content-type`, `cookie`, `forwarded`, `x-forwarded-*`, `x-real-ip`, `accept-encoding`, заголовки соединения). Нет переменной у врача — ошибка `check-config`, eval не запускается. Без поля всё как раньше.

### Как обновить приложение

Если поставщику eval нужен свой заголовок:

1. Поднять `@ykurilov/remontnik-watch` и `@ykurilov/remontnik-core` до новой версии точными версиями. На сервере перевести клон Ремонтника на метку новой версии и пересобрать врача (`docker compose -f deploy/compose.remontnik.yml up -d --build`).
2. В `remontnik.config.ts` у поставщика добавить `upstreamHeaders: [{ name: '<имя заголовка>', valueEnv: '<ИМЯ_ПЕРЕМЕННОЙ>' }]`.
3. Значение положить в окружение врача (файл окружения Ремонтника на сервере) под этим именем через `secret-handoff` и перезапустить врача.
4. Проверить внутри контейнера врача: `remontnik-doctor check-config` — ошибок нет.

Если заголовок не нужен — ничего не менять.
