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
  review?: {
    botDescription: string;
    places?: string[];                  // места бота, к которым относятся нарушения; без набора место всегда «общее»
    limits: { watchModelUsdPerDay: number }; // config.limits из remontnik.config; потолок сторожа в сутки,
                                        // общий на приложение: все процессы с одной папкой `dir` делят его
    maxReviewsPerHour?: number;         // 100
    maxReviewsPerDay?: number;          // 1000
    minConfidence?: number;
    timeZone?: string;
    reasoningEffort?: "low" | "high" | "max"; // уровень рассуждения модели; см. research.md R2
  },
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
| `watch.conversationFinished({ id, messages, meta? })` | поставить законченный разговор в очередь чтения. Разговор без реплики пользователя или без ответа бота пропускается. Тот же `id` с прежним началом и новыми сообщениями читается снова (только новые сообщения); тот же `id` с другим началом читается целиком |
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

`deepseek-flash` — имя модели в API DeepSeek (по списку моделей это DeepSeek-V4.1-Flash). Это псевдоним поставщика: версия за ним может смениться. Идентификаторы проверяются живым тестом; в коде — одна константа на путь.

## Чтение разговоров: что можно доверять

- Разговор сжимается при приёме: сообщение до 2000 символов, у длинного разговора голова 15 000 + хвост 25 000 символов, середина заменяется заглушкой; в памяти очереди остаётся только то, что уйдёт модели. Очередь ограничена и числом разговоров (200), и суммарным числом символов.
- Расход и число чтений ведёт общий учёт приложения (журнал дозаписи в папке `dir`, `review-spend-<день>.jsonl`): резерв по оценке занимает бюджет до запроса, после ответа заменяется настоящим расходом. Оплаченный, но не принятый ответ (не JSON) и ответ без данных о расходе списываются из бюджета; отказ сервера (5xx, 429) ничего не стоит.
- Всё, что вернула модель, — данные, а не поручение. Цитата `excerpt` принимается, только если она подстрока очищенного ответа бота с этим `messageIndex`; иначе отметка отбрасывается. Место (`place`) берётся только из набора `places`, иначе «прочее». Пояснение `explanation` уходит владельцу и врачу как «текст модели», а не как указание.
- Отпечаток случая строится от приложения, вида нарушения и места; цитата и пояснение в него не входят.
- Банковские карты (13–19 цифр, проверка Луна) и секреты сторожа маскируются до отправки модели.

## Отправка врачу

`POST {doctor.url}/v1/events` — тело `{ events: IncidentEvent[] }` (до 50), заголовки `X-Remontnik-Signature: sha256=<HMAC от «отметка времени + тело»>`, `X-Remontnik-Timestamp` (секунды; допуск 5 минут). Ответ `200 { accepted: eventId[] }`. Повторная доставка того же `eventId` безопасна. Событие с `occurredAt` позже часов врача больше чем на допуск подписи (5 минут) врач записывает временем приёма: часы сторожа сбились, а отказ всей пачке застопорил бы и верные события. Повторы: 5 с, 30 с, 2 мин, 10 мин, дальше каждые 10 мин.
