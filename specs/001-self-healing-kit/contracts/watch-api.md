# Контракт: сторож `@ykurilov/remontnik-watch`

## Создание

```ts
import { createWatch } from "@ykurilov/remontnik-watch";

const watch = createWatch({
  appName: string,
  processName: string,                  // "web", "worker"…
  dir: string,                          // папка очереди, из REMONTNIK_WATCH_DIR
  doctor: { url: string; secret: string }, // из окружения
  telegram: {
    botToken: string,
    chatId: string | (() => Promise<string | null>),
    apiBaseUrl?: string,
    proxyToken?: string,
  },
  model?: ModelRouteOptions,            // для чтения разговоров; см. ниже
  review?: { botDescription: string; usdPerDay: number; minConfidence?: number; timeZone?: string },
  release?: () => Promise<string | null>, // текущая версия приложения, для отметки в событии
  redact?: (text: string) => string,    // дополнительная вычистка приложения
  maxQueue?: number,                    // потолок очереди, по умолчанию 1000 (см. data-model: OutboxEntry)
});
```

## Методы

| Метод | Что делает |
|---|---|
| `watch.installProcessHandlers()` | ловит `uncaughtException`, `unhandledRejection`; после записи случая поведение процесса как без сторожа |
| `watch.capture(error, { kind?, where?, context? })` | записать сбой вручную; возвращает `eventId` |
| `watch.wrapModelCatalog(catalog)` | обёртка каталога моделей: ошибки обращений → `model_error` |
| `watch.conversationFinished({ id, messages, meta? })` | поставить законченный разговор в очередь чтения |
| `watch.flush(timeoutMs)` | дождаться отправки очереди при штатной остановке; по сроку — `false`, текущая отправка доживает в фоне |
| `watch.close()` | снять обработчики и замок очереди |
| `watch.stats()` | счётчики очереди и расходов, для проверки здоровья приложения |

Все методы не бросают исключений и не ждут сети в горячем пути: запись в очередь — синхронная дозапись строки, отправка — в фоне. Фоновые таймеры и промисы сторожа тоже не выпускают ошибок в приложение. Отмена запроса к модели (`AbortError`, кнопка «Стоп») — не сбой.

## Подпуть `/agent-chat`

```ts
import { agentChatWatchHooks } from "@ykurilov/remontnik-watch/agent-chat";

const hooks = agentChatWatchHooks(watch, { inner: appHooks, afterTurn: true }); // logError, turnNotStarted, afterTurn
```

- `afterTurn` подключается, только если `afterTurn: true` или у приложения есть свой `inner.afterTurn`. SDK с этим хуком требует хранилище с `setAfterTurnState`; без такого хранилища хук не включать.

- `logError(line)` — строки SDK о сбоях провайдера и хода → `model_error` / `turn_failed`.
- `afterTurn({ stopReason, error, … })` — ход с ошибкой → `turn_failed`; инструмент с ошибкой → `tool_error`.
- Хуки приложения (`inner`) вызываются как раньше, их результат не меняется.

## ModelRouteOptions (из `remontnik-core`)

```ts
{
  primary: { baseUrl?: string; apiKey: string; model: "deepseek-flash"; proxyToken?: string },
  fallback: { baseUrl?: string; apiKey: string; model: "deepseek/deepseek-v4.1-flash-1017"; proxyToken?: string },
  retryPrimaryAfterMs?: number, // 600_000
}
```

Точные идентификаторы моделей проверяются живым тестом при реализации; в коде — одна константа на путь.

## Отправка врачу

`POST {doctor.url}/v1/events` — тело `{ events: IncidentEvent[] }` (до 50), заголовки `X-Remontnik-Signature: sha256=<HMAC от «отметка времени + тело»>`, `X-Remontnik-Timestamp` (секунды; допуск 5 минут). Ответ `200 { accepted: eventId[] }`. Повторная доставка того же `eventId` безопасна. Повторы: 5 с, 30 с, 2 мин, 10 мин, дальше каждые 10 мин.
