import { createWatch } from '@ykurilov/remontnik-watch'

export const watch = createWatch({
  appName: 'patient-onboard',
  processName: 'web',
  dir: process.env.REMONTNIK_WATCH_DIR!,
  doctor: { url: process.env.REMONTNIK_DOCTOR_URL!, secret: process.env.REMONTNIK_SHARED_SECRET! },
  telegram: {
    botToken: process.env.APP_ALERT_BOT_TOKEN!,
    chatId: process.env.APP_ALERT_CHAT_ID!,
    // Только для стенда с подставным Telegram; в боевом окружении переменной нет.
    ...(process.env.APP_ALERT_API_BASE_URL ? { apiBaseUrl: process.env.APP_ALERT_API_BASE_URL } : {}),
  },
  release: process.env.REMONTNIK_VERSION ?? null,
})
watch.installProcessHandlers()
