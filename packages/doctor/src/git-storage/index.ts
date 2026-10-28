import { spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { chmod, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

// Своё хранилище git на сервере: bare-репозиторий под пользователем git с git-shell, врач ходит туда по SSH
// ключом развёртывания. Здесь — доступ врача (ключ и known_hosts из окружения, команда ssh для git) и пробы
// защиты хранилища для `check-config`. Пробы говорят с git-receive-pack напрямую: у каждой команды ожидаемое
// старое значение не совпадает с настоящим, поэтому даже без всякой защиты хранилище ни одну не примет.

export type GitSshEnv = Readonly<Record<string, string | undefined>>

export interface SshRemote {
  user?: string
  host: string
  port?: string
  path: string
}

/** `ssh://[user@]host[:port]/path` или `[user@]host:path`; остальное (https, file, локальный путь) — не SSH. */
export function parseSshRemote(url: string): SshRemote | undefined {
  const text = url.trim()
  const full = /^ssh:\/\/(?:([^@/]+)@)?(\[[^\]]+\]|[^:/]+)(?::(\d+))?(\/.*)$/.exec(text)
  const short = full ? undefined : /^(?:([^@/:]+)@)?([^:/\s]+):(?!\/\/)(.+)$/.exec(text)
  const match = full ?? short
  if (!match) return undefined
  const host = match[2]!.replace(/^\[|\]$/g, '')
  if (host.startsWith('-') || match[1]?.startsWith('-')) return undefined
  return { ...(match[1] ? { user: match[1] } : {}), host, ...(full && match[3] ? { port: match[3] } : {}), path: full ? match[4]! : match[3]! }
}

export interface GitSshFile {
  path: string
  content: string
}

export interface GitSshAccess {
  dir: string
  /** Аргументы ssh перед адресом: ключ, known_hosts, без чужих настроек и агента. */
  sshOptions: string[]
  /** Переменные для git врача. */
  env: Record<string, string>
  files: GitSshFile[]
}

/**
 * Закрытый ключ из `REMONTNIK_GIT_SSH_KEY`: файл ключа целиком (переводы строк настоящие или `\n`) или он же в base64
 * одной строкой. Текст ошибки — без значения.
 */
export function decodeSshKey(text: string): string {
  const trimmed = text.trim()
  const pem = /PRIVATE KEY-----/.test(trimmed) ? trimmed.replace(/\\n/g, '\n') : Buffer.from(trimmed, 'base64').toString('utf8').trim()
  if (!/^-----BEGIN [A-Z ]*PRIVATE KEY-----\r?\n[\s\S]+\n-----END [A-Z ]*PRIVATE KEY-----$/.test(pem)) {
    throw new Error('REMONTNIK_GIT_SSH_KEY: не закрытый ключ SSH (нужен файл ключа целиком или он же в base64 одной строкой)')
  }
  return `${pem}\n`
}

const shellQuote = (word: string) => `'${word.replace(/'/g, `'\\''`)}'`

/**
 * Доступ врача к хранилищу по SSH, если задан `REMONTNIK_GIT_SSH_KEY`: что записать в `dir` и как звать ssh.
 * Без побочных действий: файлы пишет `writeGitSshFiles`.
 */
export function gitSshAccess(env: GitSshEnv, dir: string): GitSshAccess | undefined {
  const key = env.REMONTNIK_GIT_SSH_KEY?.trim()
  if (!key) return undefined
  const knownHosts = env.REMONTNIK_GIT_KNOWN_HOSTS?.trim().replace(/\\n/g, '\n')
  if (!knownHosts) throw new Error('врачу нужна переменная REMONTNIK_GIT_KNOWN_HOSTS: без неё ssh не узнает хранилище')
  const keyFile = join(dir, 'key')
  const knownHostsFile = join(dir, 'known_hosts')
  const sshOptions = [
    '-F', '/dev/null',
    '-i', keyFile,
    '-o', 'IdentitiesOnly=yes',
    '-o', 'IdentityAgent=none',
    '-o', `UserKnownHostsFile=${knownHostsFile}`,
    '-o', 'GlobalKnownHostsFile=/dev/null',
    '-o', 'StrictHostKeyChecking=yes',
    '-o', 'BatchMode=yes',
    '-o', 'ConnectTimeout=20',
  ]
  return {
    dir,
    sshOptions,
    env: { GIT_SSH_COMMAND: ['ssh', ...sshOptions].map(shellQuote).join(' '), GIT_SSH_VARIANT: 'ssh' },
    files: [
      { path: keyFile, content: decodeSshKey(key) },
      { path: knownHostsFile, content: `${knownHosts}\n` },
    ],
  }
}

/** Папка только для владельца, файлы 0600: иначе ssh не возьмёт ключ. В контейнере врача — tmpfs, на диск не попадает. */
export async function writeGitSshFiles(access: GitSshAccess): Promise<void> {
  await mkdir(access.dir, { recursive: true, mode: 0o700 })
  await chmod(access.dir, 0o700)
  for (const file of access.files) {
    await writeFile(file.path, file.content, { mode: 0o600 })
    await chmod(file.path, 0o600)
  }
}

export type StorageProbeName = 'status' | 'nonFastForward' | 'deleteBranch' | 'moveTag' | 'deleteTag' | 'foreignBranch'

/** Чем кончилась проба: отказ самого git (причина из отчёта), отказ хука (его код), принята или не отправлена. */
export type StorageProbeOutcome =
  | { kind: 'git'; reason: string }
  | { kind: 'hook'; code: string }
  | { kind: 'accepted' }

export type StorageFailure = 'host-key' | 'denied' | 'network' | 'not-repository' | 'not-git-shell' | 'other'

export interface StorageProbeResult {
  /** Не дошли до хранилища: почему, по тексту ssh и git (сам текст наружу не идёт — в нём адреса). */
  failure?: StorageFailure
  /** Голова основной ветки в хранилище; нет — ветки там нет, пробы не отправлялись. */
  mainHead?: string
  /** Строка состояния хука: версия и куда пользователь git может писать. */
  status?: { version: number; writable: string[] }
  outcomes: Partial<Record<StorageProbeName, StorageProbeOutcome>>
}

export interface StorageProbeOptions {
  remote: SshRemote
  sshOptions: readonly string[]
  mainBranch: string
  /** Коммит в хранилище, который не потомок головы основной ветки (обычно её родитель); нет — без пробы перезаписи. */
  olderCommit: (head: string) => Promise<string | undefined>
  ssh?: string
  env?: Record<string, string | undefined>
  timeoutMs?: number
}

const PROBE_TIMEOUT_MS = 60_000

function pktLine(text: string): Buffer {
  const body = Buffer.from(text, 'utf8')
  return Buffer.concat([Buffer.from((body.length + 4).toString(16).padStart(4, '0')), body])
}

/** Пустой pack: пробам новые объекты не нужны, все их коммиты уже в хранилище. */
function emptyPack(objectFormat: string): Buffer {
  const header = Buffer.from([0x50, 0x41, 0x43, 0x4b, 0, 0, 0, 2, 0, 0, 0, 0])
  return Buffer.concat([header, createHash(objectFormat === 'sha256' ? 'sha256' : 'sha1').update(header).digest()])
}

function classifyFailure(stderr: string): StorageFailure {
  if (/Host key verification failed|REMOTE HOST IDENTIFICATION|host key .*(not known|mismatch)|No \S+ host key is known/i.test(stderr)) return 'host-key'
  if (/Permission denied/i.test(stderr)) return 'denied'
  if (/does not appear to be a git repository|not a git repository|dubious ownership|safe\.directory/i.test(stderr)) return 'not-repository'
  if (/unrecognized command|ключу врача доступны|git-shell|Interactive git shell/i.test(stderr)) return 'not-git-shell'
  if (/Could not resolve|Connection refused|timed out|No route to host|Network is unreachable|Connection closed|Connection reset|kex_exchange/i.test(stderr)) return 'network'
  return 'other'
}

/** Чтение pkt-line из потока ssh: строка, `null` на flush, `undefined` — поток кончился. */
function pktReader(stream: NodeJS.ReadableStream) {
  let buffer = Buffer.alloc(0)
  let ended = false
  let wake: (() => void) | undefined
  stream.on('data', (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk])
    wake?.()
  })
  stream.on('end', () => {
    ended = true
    wake?.()
  })
  stream.on('error', () => {
    ended = true
    wake?.()
  })
  async function need(bytes: number): Promise<boolean> {
    while (buffer.length < bytes) {
      if (ended) return false
      await new Promise<void>((resolve) => (wake = resolve))
      wake = undefined
    }
    return true
  }
  return async function read(): Promise<string | null | undefined> {
    if (!(await need(4))) return undefined
    const length = Number.parseInt(buffer.subarray(0, 4).toString(), 16)
    if (!Number.isInteger(length)) return undefined
    if (length === 0) {
      buffer = buffer.subarray(4)
      return null
    }
    if (!(await need(length))) return undefined
    const line = buffer.subarray(4, length).toString('utf8')
    buffer = buffer.subarray(length)
    return line.replace(/\n$/, '')
  }
}

/**
 * Пробы защиты хранилища одним разговором с git-receive-pack. Ни одна проба не может ничего записать: ссылки проб
 * не существуют, а ожидаемое старое значение у каждой — настоящий коммит, так что даже хранилище без защиты
 * отклонит обновление. Отказ git до хука значит, что держит config; отказ хука — что держит хук.
 */
export async function probeGitStorage(options: StorageProbeOptions): Promise<StorageProbeResult> {
  const { remote } = options
  const target = remote.user ? `${remote.user}@${remote.host}` : remote.host
  const child = spawn(options.ssh ?? 'ssh', [...options.sshOptions, ...(remote.port ? ['-p', remote.port] : []), target, `git-receive-pack ${shellQuote(remote.path)}`], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: Object.fromEntries(Object.entries({ ...process.env, ...options.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' }).filter((entry): entry is [string, string] => entry[1] !== undefined)),
  })
  let stderr = ''
  child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')))
  child.stdin.on('error', () => {})
  const exited = new Promise<void>((resolve) => {
    child.on('close', () => resolve())
    child.on('error', (error) => {
      stderr += String(error)
      resolve()
    })
  })
  const timer = setTimeout(() => child.kill('SIGKILL'), options.timeoutMs ?? PROBE_TIMEOUT_MS)
  const read = pktReader(child.stdout)
  try {
    const refs = new Map<string, string>()
    let capabilities = ''
    for (;;) {
      const line = await read()
      if (line === undefined) {
        await exited
        return { failure: classifyFailure(stderr), outcomes: {} }
      }
      if (line === null) break
      const [head, caps] = line.split('\0')
      if (caps !== undefined) capabilities = caps
      const [oid, ref] = head!.split(' ')
      if (oid && ref && ref !== 'capabilities^{}') refs.set(ref, oid)
    }
    const mainHead = refs.get(`refs/heads/${options.mainBranch}`)
    if (!mainHead) {
      child.stdin.end(Buffer.from('0000'))
      await exited
      return { outcomes: {} }
    }
    const older = await options.olderCommit(mainHead).catch(() => undefined)
    const zero = '0'.repeat(mainHead.length)
    const id = randomBytes(4).toString('hex')
    const commands: Array<{ name: StorageProbeName; old: string; next: string; ref: string }> = [
      { name: 'status', old: older ?? mainHead, next: mainHead, ref: 'refs/remontnik-probe/status' },
      ...(older ? [{ name: 'nonFastForward' as const, old: mainHead, next: older, ref: `refs/heads/remontnik-probe/${id}-rewrite` }] : []),
      { name: 'deleteBranch', old: mainHead, next: zero, ref: `refs/heads/remontnik-probe/${id}-delete` },
      { name: 'moveTag', old: older ?? mainHead, next: mainHead, ref: `refs/tags/remontnik/remontnik-probe-${id}-move` },
      { name: 'deleteTag', old: mainHead, next: zero, ref: `refs/tags/remontnik/remontnik-probe-${id}-delete` },
      { name: 'foreignBranch', old: mainHead, next: mainHead, ref: `refs/heads/remontnik-probe/${id}-foreign` },
    ]
    const objectFormat = /(?:^| )object-format=(\S+)/.exec(capabilities)?.[1] ?? 'sha1'
    const wants = ['report-status', ...(objectFormat !== 'sha1' ? [`object-format=${objectFormat}`] : [])].join(' ')
    child.stdin.end(
      Buffer.concat([
        ...commands.map((command, index) => pktLine(`${command.old} ${command.next} ${command.ref}${index === 0 ? `\0${wants}` : ''}\n`)),
        Buffer.from('0000'),
        emptyPack(objectFormat),
      ]),
    )
    const report = new Map<string, string | true>()
    for (;;) {
      const line = await read()
      if (line === undefined || line === null) break
      const ok = /^ok (\S+)/.exec(line)
      const ng = /^ng (\S+) (.*)$/.exec(line)
      if (ok) report.set(ok[1]!, true)
      if (ng) report.set(ng[1]!, ng[2]!)
    }
    await exited
    const hookCodes = new Map([...stderr.matchAll(/remontnik-guard: отказ (\S+) (\S+):/g)].map((match) => [match[2]!, match[1]!]))
    const statusLine = /remontnik-guard: состояние v(\d+) запись=(\S+)/.exec(stderr)
    const outcomes: StorageProbeResult['outcomes'] = {}
    if (report.size === 0) return { failure: classifyFailure(stderr), mainHead, outcomes }
    for (const command of commands) {
      const answer = report.get(command.ref)
      if (answer === undefined) continue
      const code = hookCodes.get(command.ref)
      outcomes[command.name] = answer === true ? { kind: 'accepted' } : code ? { kind: 'hook', code } : { kind: 'git', reason: answer }
    }
    return {
      mainHead,
      ...(statusLine ? { status: { version: Number(statusLine[1]), writable: statusLine[2] === '-' ? [] : statusLine[2]!.split(',') } } : {}),
      outcomes,
    }
  } finally {
    clearTimeout(timer)
    if (child.exitCode === null) child.kill('SIGKILL')
  }
}
