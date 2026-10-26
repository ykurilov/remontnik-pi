import { watch } from './watch.ts'

/**
 * Обновление бота тревог (webhook). Нажатие «Остановить автовыкатку» уходит сторожу; ответ на нажатие возвращается
 * прямо в ответе на webhook (Telegram выполняет такой ответ как вызов метода). Остальные обновления игнорируются.
 */
export async function handleAlertBotUpdate(update: Record<string, unknown>): Promise<Record<string, unknown> | null> {
  const query = update.callback_query as ({ id: string } & Record<string, unknown>) | undefined
  if (!query) return null
  const answer = await watch.handleStopButton(query)
  return answer === null ? null : { method: 'answerCallbackQuery', callback_query_id: query.id, text: answer }
}
