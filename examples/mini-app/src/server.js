import { createServer } from 'node:http'
import { greet } from './greeting.js'

/**
 * Три адреса, которых ждут команды выкатки и стоп-кран:
 *   GET /health и GET /version — «здоров ли я» и «какая сборка работает» (REMONTNIK_VERSION);
 *   POST /telegram/alerts — обновления бота тревог, оттуда приходит нажатие «Остановить автовыкатку».
 * Плюс сам рабочий адрес POST /api/greet.
 */
export function createAppServer({ version, alertBotUpdate, alertBotSecret }) {
  return createServer(async (request, response) => {
    const send = (status, body) => {
      response.writeHead(status, { 'content-type': 'application/json' })
      response.end(JSON.stringify(body))
    }
    const readJson = async () => {
      const chunks = []
      for await (const chunk of request) chunks.push(chunk)
      try {
        return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
      } catch {
        return {}
      }
    }
    const { method, url } = request
    if (method === 'GET' && url === '/health') return send(200, { ok: true })
    if (method === 'GET' && url === '/version') return send(200, { version })
    if (method === 'POST' && url === '/api/greet') {
      const { name } = await readJson()
      return send(200, { text: greet(String(name ?? 'друг')) })
    }
    if (method === 'POST' && url === '/telegram/alerts' && alertBotUpdate) {
      if (alertBotSecret && request.headers['x-telegram-bot-api-secret-token'] !== alertBotSecret) return send(404, { error: 'not found' })
      return send(200, (await alertBotUpdate(await readJson())) ?? { ok: true })
    }
    return send(404, { error: 'not found' })
  })
}
