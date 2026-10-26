import { createWatch } from '@ykurilov/remontnik-watch'

// Сторож: сбой записывается в очередь на диске (REMONTNIK_WATCH_DIR) и уходит врачу, когда процесс запустится снова.
export const watch = createWatch({
  appName: 'mini-app',
  processName: 'web',
  dir: process.env.REMONTNIK_WATCH_DIR,
  doctor: { url: process.env.REMONTNIK_DOCTOR_URL, secret: process.env.REMONTNIK_SHARED_SECRET },
  telegram: {
    botToken: process.env.APP_ALERT_BOT_TOKEN,
    chatId: process.env.APP_ALERT_CHAT_ID,
    // Только для стенда с подставным Telegram; в боевом окружении переменной нет.
    ...(process.env.APP_ALERT_API_BASE_URL ? { apiBaseUrl: process.env.APP_ALERT_API_BASE_URL } : {}),
  },
  // Сборку выкатки врач передаёт процессу приложения в REMONTNIK_VERSION: так сбой привязан к версии.
  release: process.env.REMONTNIK_VERSION ?? null,
})
watch.installProcessHandlers()
