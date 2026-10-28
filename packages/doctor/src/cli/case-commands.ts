import { parseArgs } from 'node:util'
import { UsageError, type DoctorCommandIo } from './command-io.js'
import { postOwnerCommand } from './owner-command.js'

// `remontnik-doctor case <номер> retry`: снова поставить в работу случай, чьё лечение упало, остановилось после
// повторных сбоев врача или кончилось без излечения. Подписанный `POST /v1/control/cases`, только секретом владельца
// `REMONTNIK_CONTROL_SECRET`.

export const CASE_USAGE = `  remontnik-doctor case <номер случая> retry [--by <кто>]
`

export async function caseCommand(args: string[], io: DoctorCommandIo): Promise<number> {
  const [id, action, ...rest] = args
  if (action !== 'retry') throw new UsageError(`неизвестная команда «case ${id ?? ''} ${action ?? ''}»`.trimEnd())
  const caseId = Number(id)
  if (!/^[1-9]\d*$/.test(id ?? '') || !Number.isSafeInteger(caseId)) throw new UsageError('номер случая — целое число, как в отчёте')
  const {
    values: { by = 'console' },
  } = parseArgs({ args: rest, options: { by: { type: 'string' } } })
  return postOwnerCommand(io, '/v1/control/cases', { caseId, action, by })
}
