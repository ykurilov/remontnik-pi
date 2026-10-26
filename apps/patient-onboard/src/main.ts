import { handleAlertBotUpdate } from './alert-bot.ts'
import { parsePatientBug } from './bugs.ts'
import { createPatientServer } from './server.ts'
import { watch } from './watch.ts'

const bug = parsePatientBug(process.env.PATIENT_BUG)
const port = Number(process.env.PORT ?? 3000)
const host = process.env.HOST ?? '127.0.0.1'
const server = createPatientServer({
  bug,
  version: process.env.REMONTNIK_VERSION ?? 'dev',
  alertBotUpdate: handleAlertBotUpdate,
  alertBotSecret: process.env.APP_ALERT_WEBHOOK_SECRET,
  reportError: (report) => watch.capture(report.error, { where: report.kind === 'crash' ? report.where : report.kind }),
})

server.listen(port, host, () => {
  const address = server.address()
  const actualPort = typeof address === 'object' && address ? address.port : port
  console.log(`patient listening on http://${host}:${actualPort}${bug ? ` (PATIENT_BUG=${bug})` : ''}`)
})

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    server.close(async () => {
      await watch.flush(5000)
      watch.close()
      process.exit(0)
    })
  })
}
