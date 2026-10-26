import { startEgressProxy } from '../egress-proxy/index.js'
import { parseListen, startDoctorFromEnv } from '../service/start.js'
import { UsageError, type DoctorCommandIo } from './command-io.js'

// Долгие команды — точки входа контейнеров: служба врача и прокси выхода верстака. Работают до SIGTERM/SIGINT.

export const SERVICE_USAGE = `  remontnik-doctor start            служба врача; всё — из окружения сервера
  remontnik-doctor egress-proxy     прокси выхода верстака к реестру пакетов
`

const DEFAULT_EGRESS_ALLOW = 'registry.npmjs.org'

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

export async function egressProxyCommand(args: string[], io: DoctorCommandIo): Promise<number> {
  if (args.length > 0) throw new UsageError('egress-proxy без аргументов: всё берётся из окружения')
  const listenText = io.env.REMONTNIK_EGRESS_LISTEN?.trim()
  if (!listenText) throw new Error('прокси выхода нужна переменная REMONTNIK_EGRESS_LISTEN (адрес во внутренней сети верстака)')
  const list = (text: string) => text.split(',').map((item) => item.trim()).filter(Boolean)
  const ports = list(io.env.REMONTNIK_EGRESS_PORTS ?? '443').map(Number)
  if (ports.some((port) => !Number.isInteger(port) || port < 1 || port > 65_535)) throw new Error('REMONTNIK_EGRESS_PORTS: нужны номера портов через запятую')
  const proxy = await startEgressProxy({
    listen: parseListen(listenText, 'REMONTNIK_EGRESS_LISTEN'),
    allowedHosts: list(io.env.REMONTNIK_EGRESS_ALLOW ?? DEFAULT_EGRESS_ALLOW),
    allowedPorts: ports,
    log: (line) => io.stderr(`${line}\n`),
  })
  io.stderr(`[прокси выхода] слушаю ${proxy.url}\n`)
  await untilStopped()
  await proxy.close()
  return 0
}
