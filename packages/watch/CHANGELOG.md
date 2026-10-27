# @ykurilov/remontnik-watch

## 0.1.3

### Patch Changes

- Updated dependencies [b053d83]
  - @ykurilov/remontnik-core@0.1.3

## 0.1.2

### Patch Changes

- @ykurilov/remontnik-core@0.1.2

## 0.1.1

### Patch Changes

- 07720e7: `agentChatWatchHooks(...)` подставляется в `createChatService` и `createChatHandler` Agent Chat SDK без приведения типов: у `AgentChatTurnNotStarted` убрана индексная подпись. Совместимость проверяет тип-тест против настоящего `@ykurilov/agent-chat-core`.
- Updated dependencies [07720e7]
  - @ykurilov/remontnik-core@0.1.1

## 0.1.0

### Minor Changes

- f0c536c: Первый выпуск набора самолечения приложений.
  
  - `core`: общие части набора и настройка `remontnik.config.ts` (`defineRemontnikConfig`).
  - `watch`: сторож внутри приложения — ловит падения, ошибки модели и инструментов, плохие ответы бота; шлёт случаи врачу и тревоги в Telegram.
  - `doctor`: врач на сервере — находит причину, правит в отдельной ветке, проверяет тестами и eval, выкатывает при зелёных проверках, следит и сам откатывает; переживает падения; команда `check-config`.
  - `browser`: по желанию — браузер врача для воспроизведения ошибок и проверки страниц.
  - `paseo-bridge`: по желанию — режим «сначала Paseo»: случай сперва уходит агенту проекта, врач берёт его сам, только если агент недоступен.

### Patch Changes

- Updated dependencies [f0c536c]
- Updated dependencies [787ed76]
  - @ykurilov/remontnik-core@0.1.0
