import { startDoctorFromEnv } from '../service/start.js'
import { UsageError, type DoctorCommandIo } from './command-io.js'

// Долгие команды — точки входа контейнеров: служба врача. Работают до SIGTERM/SIGINT.

export const SERVICE_USAGE = `  remontnik-doctor start            служба врача; всё — из окружения сервера
`

function untilStopped(): Promise<void> {
  return new Promise((resolve) => {
    process.once('SIGTERM', resolve)
    process.once('SIGINT', resolve)
  })
}

export async function startCommand(args: string[], io: DoctorCommandIo): Promise<number> {
  if (args.length > 0) throw new UsageError('start без аргументов: всё берётся из окружения')
  const doctor = await startDoctorFromEnv(io.env, { log: (line) => io.stderr(`${line}\n`) })
  io.stderr(`[врач] слушаю ${doctor.url}\n`)
  await untilStopped()
  await doctor.close()
  return 0
}
