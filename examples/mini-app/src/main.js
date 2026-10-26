import { createAppServer } from './server.js'
import { watch } from './watch.js'

const port = Number(process.env.PORT ?? 3000)
const host = process.env.HOST ?? '127.0.0.1'

const server = createAppServer({
  version: process.env.REMONTNIK_VERSION ?? 'dev',
  alertBotSecret: process.env.APP_ALERT_WEBHOOK_SECRET,
  // Нажатие кнопки «Остановить автовыкатку» в чате тревог приходит сюда обновлением бота.
  // Ответ на нажатие возвращается прямо в ответе на webhook: бота-объекта в приложении нет.
  alertBotUpdate: async (update) => {
    const query = update.callback_query
    if (!query) return null
    const answer = await watch.handleStopButton(query)
    return answer === null ? null : { method: 'answerCallbackQuery', callback_query_id: query.id, text: answer }
  },
})

server.listen(port, host, () => console.log(`mini-app listening on http://${host}:${port}`))

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close(async () => {
      await watch.flush(5000)
      watch.close()
      process.exit(0)
    })
  })
}
