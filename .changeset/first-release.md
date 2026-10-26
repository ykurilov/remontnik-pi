---
'@ykurilov/remontnik-core': minor
'@ykurilov/remontnik-watch': minor
'@ykurilov/remontnik-doctor': minor
'@ykurilov/remontnik-browser': minor
'@ykurilov/remontnik-paseo-bridge': minor
---

Первый выпуск набора самолечения приложений.

- `core`: общие части набора и настройка `remontnik.config.ts` (`defineRemontnikConfig`).
- `watch`: сторож внутри приложения — ловит падения, ошибки модели и инструментов, плохие ответы бота; шлёт случаи врачу и тревоги в Telegram.
- `doctor`: врач на сервере — находит причину, правит в отдельной ветке, проверяет тестами и eval, выкатывает при зелёных проверках, следит и сам откатывает; переживает падения; команда `check-config`.
- `browser`: по желанию — браузер врача для воспроизведения ошибок и проверки страниц.
- `paseo-bridge`: по желанию — режим «сначала Paseo»: случай сперва уходит агенту проекта, врач берёт его сам, только если агент недоступен.
