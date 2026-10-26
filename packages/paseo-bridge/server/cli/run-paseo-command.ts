import { parseArgs } from 'node:util'
import { signRequest } from '@ykurilov/remontnik-core/signed-http'
import { DEFAULT_CONFIG_PATH, loadBridgeAddressBook } from '../bridge-config.js'
import { hostForUrl } from '../private-address.js'
import { caseDetailsText } from '../task-text.js'

// Консольная `remontnik-paseo`: агент приложения отчитывается врачу через мост на своём компьютере.
// Команды подписаны ключом задачи из письма моста: `REMONTNIK_PASEO_KEY` или `--key` (флаг виден в списке процессов).
// Секрет моста консольной не нужен и не читается.

export interface PaseoCommandIo {
  env: Record<string, string | undefined>
  stdout(text: string): void
  stderr(text: string): void
  fetch?: typeof fetch
}

const USAGE = `Использование (ключ задачи — в REMONTNIK_PASEO_KEY или флагом --key <ключ>):
  REMONTNIK_PASEO_KEY=<ключ> remontnik-paseo accept <caseId> [--app <имя>]
  REMONTNIK_PASEO_KEY=<ключ> remontnik-paseo done <caseId> [--commit <sha>] [--deployed <версия>] [--app <имя>]
  REMONTNIK_PASEO_KEY=<ключ> remontnik-paseo cannot <caseId> --reason "<текст>" [--app <имя>]
  REMONTNIK_PASEO_KEY=<ключ> remontnik-paseo case <caseId> [--app <имя>]
`

const PATHS = { accept: '/v1/agent/accepted', done: '/v1/agent/result', cannot: '/v1/agent/result', case: '/v1/agent/case' }
type Command = keyof typeof PATHS

class UsageError extends Error {}

function buildPayload(command: Command, caseId: number, values: Record<string, string | undefined>): Record<string, unknown> {
  if (command === 'done') {
    return {
      caseId,
      kind: 'done',
      ...(values.commit === undefined ? {} : { commit: values.commit }),
      ...(values.deployed === undefined ? {} : { version: values.deployed }),
    }
  }
  if (command === 'cannot') {
    if (!values.reason?.trim()) throw new UsageError('для cannot нужна причина: --reason "<текст>"')
    return { caseId, kind: 'cannot', reason: values.reason }
  }
  return { caseId }
}

export async function runPaseoCommand(argv: string[], io: PaseoCommandIo): Promise<number> {
  try {
    const { values, positionals } = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        app: { type: 'string' },
        key: { type: 'string' },
        commit: { type: 'string' },
        deployed: { type: 'string' },
        reason: { type: 'string' },
      },
    })
    const [command, caseText] = positionals
    if (!command || !(command in PATHS)) throw new UsageError(`неизвестная команда «${command ?? ''}»`)
    const caseId = Number(caseText)
    if (!Number.isSafeInteger(caseId) || caseId <= 0) throw new UsageError('номер случая — целое число больше нуля')

    const key = (values['key'] ?? io.env.REMONTNIK_PASEO_KEY)?.trim()
    if (!key) throw new UsageError('нужен ключ задачи из письма моста: REMONTNIK_PASEO_KEY=<ключ> или --key <ключ>')

    const config = loadBridgeAddressBook(io.env.REMONTNIK_PASEO_BRIDGE_CONFIG ?? DEFAULT_CONFIG_PATH)
    let app = values['app']
    if (app === undefined) {
      if (config.apps.size !== 1) throw new UsageError(`в настройке моста несколько приложений — укажи --app <имя>`)
      app = [...config.apps.keys()][0]!
    }
    if (!config.apps.has(app)) throw new UsageError(`приложения «${app}» нет в настройке моста`)

    const body = JSON.stringify({ app, ...buildPayload(command as Command, caseId, values) })
    const path = PATHS[command as Command]
    const url = `http://${hostForUrl(config.listen.host)}:${config.listen.port}${path}`
    const response = await (io.fetch ?? fetch)(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...signRequest({ method: 'POST', target: path, body, secret: key }) },
      body,
      redirect: 'manual',
      signal: AbortSignal.timeout(30_000),
    })
    const text = await response.text()
    if (!response.ok) {
      let code = `HTTP ${response.status}`
      try {
        code = String((JSON.parse(text) as { error?: unknown }).error ?? code)
      } catch {}
      io.stderr(`remontnik-paseo: отказ (${response.status} ${code})\n`)
      return 1
    }
    // Подробности случая содержат тексты пользователей приложения — агенту они идут только блоком данных.
    io.stdout(command === 'case' ? `${caseDetailsText(caseId, JSON.parse(text))}\n` : `${text}\n`)
    return 0
  } catch (error) {
    if (error instanceof UsageError || (error as { code?: string }).code?.startsWith('ERR_PARSE_ARGS')) {
      io.stderr(`remontnik-paseo: ${(error as Error).message}\n${USAGE}`)
      return 2
    }
    io.stderr(`remontnik-paseo: ${(error as Error).message ?? String(error)}\n`)
    return 1
  }
}
