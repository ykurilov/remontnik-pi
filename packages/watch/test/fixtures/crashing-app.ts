// Учебный процесс со сторожем: падает так, как велит переменная CRASH_MODE.
import { createWatch } from '@ykurilov/remontnik-watch'

const watch = createWatch({
  appName: 'crashing-app',
  processName: 'web',
  dir: process.env.REMONTNIK_WATCH_DIR ?? '',
  doctor: { url: 'http://127.0.0.1:9', secret: 'test-secret' },
  telegram: { botToken: 'test-bot-token', chatId: 'test-chat', apiBaseUrl: 'http://127.0.0.1:9' },
})
watch.installProcessHandlers()

const mode = process.env.CRASH_MODE
if (mode === 'own-handler') {
  process.on('uncaughtException', (error) => {
    console.log(`app handled: ${error.message}`)
    setTimeout(() => {
      console.log('still alive')
      process.exit(0)
    }, 50)
  })
}

setTimeout(() => {
  if (mode === 'rejection') void Promise.reject(new Error('rejected order 42'))
  else if (mode === 'rejection-own-handler') {
    process.on('unhandledRejection', (reason) => {
      console.log(`app handled rejection: ${(reason as Error).message}`)
      setTimeout(() => process.exit(0), 50)
    })
    void Promise.reject(new Error('rejected order 43'))
  } else throw new Error('crashed on order 41')
}, 10)
