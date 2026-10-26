// «Пациент» со сторожем в отдельном процессе: для сценария настоящего падения.
import type { AddressInfo } from 'node:net'
import { createWatch } from '@ykurilov/remontnik-watch'
import { parsePatientBug } from '../../src/bugs.ts'
import { createPatientServer } from '../../src/server.ts'
import { reportToWatch } from './watch-glue.ts'

const watch = createWatch({
  appName: 'patient',
  processName: 'web',
  dir: process.env.REMONTNIK_WATCH_DIR ?? '',
  doctor: { url: process.env.DOCTOR_URL ?? '', secret: process.env.REMONTNIK_SHARED_SECRET ?? '' },
  telegram: { botToken: process.env.ALERT_BOT_TOKEN ?? '', chatId: 'owner-chat', apiBaseUrl: process.env.TELEGRAM_API_BASE_URL ?? '' },
})
watch.installProcessHandlers()

const server = createPatientServer({ bug: parsePatientBug(process.env.PATIENT_BUG), reportError: reportToWatch(watch) })
server.listen(0, '127.0.0.1', () => {
  console.log(`listening ${(server.address() as AddressInfo).port}`)
})
