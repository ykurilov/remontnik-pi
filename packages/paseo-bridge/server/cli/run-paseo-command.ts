import { parseArgs } from 'node:util'
import { signBody } from '@ykurilov/remontnik-core/signed-http'
import { DEFAULT_CONFIG_PATH, loadBridgeConfig } from '../bridge-config.js'
import { hostForUrl } from '../private-address.js'

// Консольная `remontnik-paseo`: агент приложения отчитывается врачу через мост на своём компьютере.

export interface PaseoCommandIo {
  env: Record<string, string | undefined>
  stdout(text: string): void
  stderr(text: string): void
  fetch?: typeof fetch
}

const USAGE = `Использование:
  remontnik-paseo accept <caseId> [--app <имя>]
  remontnik-paseo done <caseId> [--commit <sha>] [--deployed <версия>] [--app <имя>]
  remontnik-paseo cannot <caseId> --reason "<текст>" [--app <имя>]
  remontnik-paseo case <caseId> [--app <имя>]
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
        commit: { type: 'string' },
        deployed: { type: 'string' },
        reason: { type: 'string' },
      },
    })
    const [command, caseText] = positionals
    if (!command || !(command in PATHS)) throw new UsageError(`неизвестная команда «${command ?? ''}»`)
    const caseId = Number(caseText)
    if (!Number.isSafeInteger(caseId) || caseId <= 0) throw new UsageError('номер случая — целое число больше нуля')

    const config = loadBridgeConfig(io.env.REMONTNIK_PASEO_BRIDGE_CONFIG ?? DEFAULT_CONFIG_PATH)
    let app = values['app']
    if (app === undefined) {
      if (config.apps.size !== 1) throw new UsageError(`в настройке моста несколько приложений — укажи --app <имя>`)
      app = [...config.apps.keys()][0]!
    }
    const entry = config.apps.get(app)
    if (!entry) throw new UsageError(`приложения «${app}» нет в настройке моста`)

    const body = JSON.stringify({ app, ...buildPayload(command as Command, caseId, values) })
    const url = `http://${hostForUrl(config.listen.host)}:${config.listen.port}${PATHS[command as Command]}`
    const response = await (io.fetch ?? fetch)(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...signBody(body, entry.secret) },
      body,
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
    io.stdout(command === 'case' ? `${JSON.stringify(JSON.parse(text), null, 2)}\n` : `${text}\n`)
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
