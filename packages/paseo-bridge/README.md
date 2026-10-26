# @ykurilov/remontnik-paseo-bridge

Мост Paseo для режима «сначала Paseo» (R18, `specs/001-self-healing-kit/contracts/paseo-bridge.md`). Плагин Paseo на компьютере владельца: принимает подписанные запросы врача по частной сети и пишет назначенному агенту приложения. Агент отчитывается командой `remontnik-paseo`.

## Может ли серверная часть плагина держать свой HTTP-адрес (T120)

**Вывод: может.** Проверено по skill `paseo-plugin`, образцу `agent-alerts`, документации плагинов (paseo.sh, 26.10.2026) и коду `@getpaseo/server` 0.13.0 (`plugins/runtime.js`, `plugins/plugin-process.js`).

- Серверная часть (`index.server.ts`) — отдельный процесс Node. Paseo запускает его при загрузке плагина, то есть при старте службы Paseo, и держит, пока плагин включён. Останавливает при перезагрузке, выключении и удалении плагина и при остановке службы Paseo.
- В процессе доступны все возможности Node, в том числе `node:http`. Документация прямо велит закрывать в функции очистки «таймеры, наблюдатели, сокеты». Значит, свой сервер — разрешённый ресурс плагина.
- Процесс не засыпает между запросами. Компьютер уснул — уснул и мост, врач видит это по `/health` и лечит сам.

Оговорки, которые учтены в мосте:

1. **Доступ к Paseo приходит не сразу.** Paseo создаёт подключение плагина до вызова `contribute`, но отдаёт его только в контексте хука или RPC, не в самом `contribute`. Мост берёт его из первого хука о жизни агентов, как `agent-alerts`. Пока ни один хук не пришёл (сразу после старта Paseo и до первой активности агентов), `/health` отвечает `agent: "missing"` с `reason: "paseo_not_ready"`, и врач лечит сам.
2. **Отправка прерывает работающего агента.** `agents.ref(id).send` без опции прерывает текущий ход. Мост пишет агенту только когда тот свободен. Если агент занят, письмо ждёт конца хода. Не дождался — врач заберёт случай по сроку принятия.
3. **Упавший процесс Paseo сам не поднимает.** Плагин переходит в состояние ошибки. Мост перестаёт отвечать, врач лечит сам. Поднять: `paseo plugin reload remontnik-paseo-bridge`.
4. **Адрес частной сети может появиться позже Paseo.** При загрузке Mac служба Paseo стартует раньше, чем Tailscale получит адрес. Мост повторяет попытку слушать каждые 30 секунд.
5. **Код плагина — только в `server/`.** Сборщик Paseo принимает модули плагина только из `client/`, `server/`, `shared/` и файлов `index.*` в корне. Поэтому код моста лежит в `server/`, а не в `src/`, как было в плане.

## HTTP моста (вызывает врач)

Мост слушает только адрес из настройки. Адрес должен быть частным: `100.64.0.0/10` (Tailscale), `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `fd00::/8` или `127.0.0.1` для проверок. Публичный адрес, `0.0.0.0` и имя хоста мост отвергает и не слушает.

Подпись — `@ykurilov/remontnik-core/signed-http` (HMAC-SHA256 над `<секунды>.<тело>`), секрет моста для своего приложения. Тело POST — JSON, в нём всегда есть `app`. У GET подписывается строка `GET <путь с запросом>`, например `GET /health?app=shop`.

| Метод и путь | Тело → ответ |
|---|---|
| `GET /health?app=<имя>` | → `{ paseo: "up", agent: "idle" \| "running" \| "missing", reason? }` |
| `POST /v1/tasks` | `{ app, taskId, caseId, kind, fingerprint, summary, untrusted: { message, stack?, excerpt? }, links: { branch?, reportIds } }` → `{ queued: true }`; повтор того же `taskId` — `{ queued: true }` без второго письма |
| `POST /v1/tasks/:taskId/cancel` | `{ app, taskId, reason }` → `{ ok: true }`; `taskId` в теле должен совпадать с путём |
| `POST /v1/reports/notify` | `{ app, last }` → `{ ok: true }`; мост сам забирает отчёты |

Отказы: `401` (`missing`, `bad_signature`, `stale`), `403 unknown_app`, `400 bad_request`, `404 unknown_task`, `503 agent_missing`, `413 too_large`. В ответах и журнале нет секрета и текста ошибок приложения.

## Команды агента `remontnik-paseo`

Агент вызывает их на том же компьютере. Команда читает настройку моста, подписывает запрос секретом приложения и идёт к мосту. Мост проверяет, что у него есть задача по этому случаю, и пересылает врачу.

| Команда | Куда уходит у врача |
|---|---|
| `remontnik-paseo accept <caseId>` | `POST /v1/handoffs/:caseId/accepted` `{ taskId, agent }` |
| `remontnik-paseo done <caseId> [--commit <sha>] [--deployed <версия>]` | `POST /v1/handoffs/:caseId/result` `{ taskId, kind: "done", commit?, deployed, version? }` |
| `remontnik-paseo cannot <caseId> --reason "<текст>"` | `POST /v1/handoffs/:caseId/result` `{ taskId, kind: "cannot", reason }` |
| `remontnik-paseo case <caseId>` | `GET /v1/cases/:caseId` |

`--app <имя>` нужен, только если в настройке моста больше одного приложения. Путь к настройке можно задать переменной `REMONTNIK_PASEO_BRIDGE_CONFIG`.

## Отчёты

Мост забирает отчёты врача по курсору (`GET /v1/reports?after=<курсор>&limit=50`), пишет их агенту по порядку и подтверждает (`POST /v1/reports/ack` `{ upTo }`). Курсор хранится у моста и сдвигается до отправки письма: номер отчёта дважды не уходит. Отправка не удалась — курсор возвращается. Агента нет — отчёты ждут у врача. Мост забирает отчёты по `notify`, при старте и раз в минуту.

## Настройка у владельца

`~/.config/remontnik/paseo-bridge.json` — вне репозиториев:

```json
{
  "listen": "100.64.0.10:7710",
  "apps": {
    "shop": {
      "agentId": "<идентификатор агента Paseo>",
      "doctorUrl": "http://100.64.0.20:7720",
      "secretFile": "/Users/owner/.config/remontnik/secrets/shop-bridge"
    }
  }
}
```

`doctorUrl` — тоже только частный адрес. Секрет моста кладётся в файл через `secret-handoff`, в настройке — только путь. Состояние моста (задачи, курсоры отчётов) — `~/.local/share/remontnik-paseo-bridge/state.json`.

Установка: включить плагины в Paseo, затем `paseo plugin install <папка пакета>` или `paseo plugin install npm:@ykurilov/remontnik-paseo-bridge`, проверить `paseo plugin ls` (`running`) и `paseo plugin logs remontnik-paseo-bridge`. Подробно — `docs/operations.md`, раздел «Режим „сначала Paseo“».
