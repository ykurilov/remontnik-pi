---
"@ykurilov/remontnik-watch": patch
---

`agentChatWatchHooks(...)` подставляется в `createChatService` и `createChatHandler` Agent Chat SDK без приведения типов: у `AgentChatTurnNotStarted` убрана индексная подпись. Совместимость проверяет тип-тест против настоящего `@ykurilov/agent-chat-core`.
