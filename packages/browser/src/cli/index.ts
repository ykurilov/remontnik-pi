// Консольная `remontnik-browser`: те же команды страницы, что у HTTP-службы, плюс управление входами,
// которого по HTTP нет. Пароль — только из стандартного ввода (`--password-stdin`).
import { BROWSER_COMMANDS } from '../actions/index.js'
import { loginVaultPath, openLoginVault, parseVaultKey } from '../vault/index.js'

export interface CliIo {
  env: Record<string, string | undefined>
  stdin: AsyncIterable<Uint8Array | string>
  stdout: (text: string) => void
  stderr: (text: string) => void
  fetch?: typeof fetch
}

const USAGE = `remontnik-browser <команда> -p <профиль> [параметры]

Служба:
  serve                                   запустить службу (настройки из окружения)

Страница (через службу, REMONTNIK_BROWSER_URL и REMONTNIK_BROWSER_TOKEN):
  open | read | back | shot | status -p <профиль>
  url -p <профиль> <адрес>
  click -p <профиль> --ref <e12> --danger <none|submit>
  type -p <профиль> --ref <e12> --text <текст> [--submit] --danger <none|submit>
  key -p <профиль> <клавиша>
  scroll -p <профиль> --direction <up|down|left|right> [--px <число>]
  fill-password -p <профиль> --entry <номер> --ref <e12>

Входы (на сервере браузера, REMONTNIK_BROWSER_DATA_DIR и REMONTNIK_BROWSER_VAULT_KEY):
  logins list [--site <origin>]
  logins add --site <origin> --login <логин> --profile <профиль> --password-stdin
  logins remove <номер>
`

const BOOLEAN_FLAGS = new Set(['submit', 'password-stdin', 'help'])

class UsageError extends Error {}

function parseArguments(argv: readonly string[]) {
  const positional: string[] = []
  const flags = new Map<string, string | true>()
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index]!
    if (argument === '-p' || argument.startsWith('--')) {
      const name = argument === '-p' ? 'profile' : argument.slice(2)
      if (name === 'password') throw new UsageError('пароль в аргументах не принимается: передайте его в стандартный ввод с --password-stdin')
      if (BOOLEAN_FLAGS.has(name)) {
        flags.set(name, true)
        continue
      }
      const value = argv[index + 1]
      if (value === undefined) throw new UsageError(`${argument}: нужно значение`)
      flags.set(name, value)
      index++
    } else {
      positional.push(argument)
    }
  }
  return { positional, flags }
}

function vaultFrom(env: CliIo['env']) {
  const dataDir = env.REMONTNIK_BROWSER_DATA_DIR
  if (!dataDir) throw new UsageError('REMONTNIK_BROWSER_DATA_DIR не задан')
  return openLoginVault({ file: loginVaultPath(dataDir), key: parseVaultKey(env.REMONTNIK_BROWSER_VAULT_KEY) })
}

async function logins(action: string | undefined, rest: string[], flags: Map<string, string | true>, io: CliIo): Promise<number> {
  const vault = vaultFrom(io.env)
  const text = (name: string) => {
    const value = flags.get(name)
    if (typeof value !== 'string' || value === '') throw new UsageError(`нужен --${name}`)
    return value
  }
  switch (action) {
    case 'list': {
      const site = flags.get('site')
      io.stdout(`${JSON.stringify({ logins: vault.list(typeof site === 'string' ? { site } : {}) })}\n`)
      return 0
    }
    case 'add': {
      if (flags.get('password-stdin') !== true) throw new UsageError('пароль читается только из стандартного ввода: добавьте --password-stdin')
      const entry = await vault.add({ site: text('site'), login: text('login'), profile: text('profile') }, io.stdin)
      io.stdout(`${JSON.stringify({ ok: true, entry })}\n`)
      return 0
    }
    case 'remove': {
      const id = Number(rest[0])
      if (!Number.isInteger(id) || id <= 0) throw new UsageError('logins remove <номер>')
      if (!vault.remove(id)) {
        io.stderr(`вход ${id} не найден\n`)
        return 1
      }
      io.stdout(`${JSON.stringify({ ok: true, removed: id })}\n`)
      return 0
    }
    default:
      throw new UsageError('logins list | add | remove')
  }
}

function commandInput(command: string, rest: string[], flags: Map<string, string | true>): Record<string, unknown> {
  const profile = flags.get('profile')
  if (typeof profile !== 'string' || profile === '') throw new UsageError('профиль обязателен: -p <профиль>')
  const input: Record<string, unknown> = { profile }
  const copy = (flag: string, field = flag) => {
    const value = flags.get(flag)
    if (typeof value === 'string') input[field] = value
  }
  switch (command) {
    case 'url':
      input.url = rest[0] ?? flags.get('url')
      break
    case 'key':
      input.key = rest[0] ?? flags.get('key')
      break
    case 'click':
      copy('ref')
      copy('danger')
      break
    case 'type':
      copy('ref')
      copy('text')
      if (flags.get('submit') === true) input.submit = true
      copy('danger')
      break
    case 'scroll':
      copy('direction')
      if (typeof flags.get('px') === 'string') input.px = Number(flags.get('px'))
      break
    case 'fill-password':
      input.entryId = Number(flags.get('entry'))
      copy('ref')
      break
  }
  return input
}

async function callService(command: string, input: Record<string, unknown>, io: CliIo): Promise<number> {
  const token = io.env.REMONTNIK_BROWSER_TOKEN
  if (!token) throw new UsageError('REMONTNIK_BROWSER_TOKEN не задан')
  const base = (io.env.REMONTNIK_BROWSER_URL ?? 'http://127.0.0.1:7700').replace(/\/$/, '')
  const response = await (io.fetch ?? fetch)(`${base}/v1/${command}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(input),
  })
  const text = await response.text()
  io.stdout(`${text}\n`)
  try {
    return (JSON.parse(text) as { ok?: boolean }).ok === true ? 0 : 1
  } catch {
    return 1
  }
}

export async function runBrowserCli(argv: readonly string[], io: CliIo): Promise<number> {
  try {
    const { positional, flags } = parseArguments(argv)
    const [command, ...rest] = positional
    if (!command || flags.get('help') === true) {
      io.stdout(USAGE)
      return command ? 0 : 2
    }
    if (command === 'serve') {
      const { startBrowserServiceFromEnv } = await import('../service/start.js')
      const service = await startBrowserServiceFromEnv(io.env as NodeJS.ProcessEnv)
      io.stderr(`remontnik-browser: служба слушает ${service.url}${service.liveUrl ? `, живой экран ${service.liveUrl}` : ''}\n`)
      for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => void service.close().then(() => process.exit(0)))
      return await new Promise<number>(() => {})
    }
    if (command === 'logins') {
      // Список входов есть и в службе; добавление и удаление — только здесь.
      return await logins(rest[0], rest.slice(1), flags, io)
    }
    if (!(BROWSER_COMMANDS as readonly string[]).includes(command)) throw new UsageError(`нет команды ${command}`)
    return await callService(command, commandInput(command, rest, flags), io)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    io.stderr(`remontnik-browser: ${message}\n${error instanceof UsageError ? `\n${USAGE}` : ''}`)
    return error instanceof UsageError ? 2 : 1
  }
}
