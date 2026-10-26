import { checkConfigCommand, CHECK_CONFIG_USAGE } from './check-config.js'
import { UsageError, type DoctorCommandIo } from './command-io.js'
import { deploysCommand, DEPLOYS_USAGE } from './deploys-commands.js'
import { reportsCommand, REPORTS_USAGE } from './reports-commands.js'
import { SERVICE_USAGE, startCommand } from './service-commands.js'

// Консольная `remontnik-doctor`: разбор команды и вызов нужной. Каждая группа команд — свой файл со своей справкой.

export type { DoctorCommandIo } from './command-io.js'

type CommandGroup = (args: string[], io: DoctorCommandIo) => Promise<number>

const COMMAND_GROUPS: Readonly<Record<string, CommandGroup>> = {
  reports: reportsCommand,
  start: startCommand,
  'check-config': checkConfigCommand,
  deploys: deploysCommand,
}

const USAGE = `Использование:
${SERVICE_USAGE}${CHECK_CONFIG_USAGE}${REPORTS_USAGE}${DEPLOYS_USAGE}`

export async function runDoctorCommand(argv: string[], io: DoctorCommandIo): Promise<number> {
  const [group, ...args] = argv
  const run = group !== undefined && Object.hasOwn(COMMAND_GROUPS, group) ? COMMAND_GROUPS[group] : undefined
  try {
    if (!run) throw new UsageError(`неизвестная команда «${group ?? ''}»`)
    return await run(args, io)
  } catch (error) {
    if (error instanceof UsageError || (error as { code?: string }).code?.startsWith('ERR_PARSE_ARGS')) {
      io.stderr(`remontnik-doctor: ${(error as Error).message}\n${USAGE}`)
      return 2
    }
    io.stderr(`remontnik-doctor: ${(error as Error).message ?? String(error)}\n`)
    return 1
  }
}
