import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { INCIDENT_KINDS } from '@ykurilov/remontnik-core/incident'
import { NONCE_HEADER, ReplayGuard, SIGNATURE_HEADER, TIMESTAMP_HEADER, verifySignedRequest } from '@ykurilov/remontnik-core/signed-http'
import { AgentPost, type PaseoAgentsPort } from './agent-post.js'
import type { BridgeApp, BridgeConfig } from './bridge-config.js'
import { BridgeStateStore, type TaskRecord } from './bridge-state.js'
import { DoctorClient, type DoctorAnswer, type FetchLike } from './doctor-client.js'
import { assertPrivateAddress, hostForUrl, type ListenAddress } from './private-address.js'
import { ReportRelay, errorText, type BridgeLog } from './report-relay.js'
import { cancelLetter, taskLetter, UNTRUSTED_LIMITS, type BridgeTask } from './task-text.js'

// HTTP моста (contracts/paseo-bridge.md). Порядок проверок: заголовки подписи → приложение из настройки →
// подпись запроса (метод, путь, тело) секретом этого приложения → повтор подписи → содержимое.
// Неизвестное приложение отвечает так же, как неверная подпись: имена приложений не перебрать.
// Агенту пишется только агент приложения из настройки моста.

export const BRIDGE_MAX_BODY_BYTES = 256 * 1024
const BODY_TIMEOUT_MS = 10_000

const TASK_ID = /^[0-9A-HJKMNP-TV-Z]{26}$/
const FINGERPRINT = /^[A-Za-z0-9:._-]{1,128}$/
const BRANCH = /^[A-Za-z0-9._/-]{1,200}$/
const COMMIT = /^[0-9a-f]{7,40}$/
const VERSION = /^[A-Za-z0-9._+-]{1,100}$/

export type BridgeHandler = (request: IncomingMessage, response: ServerResponse) => Promise<void>

export interface PaseoBridge {
  handler: BridgeHandler
  /** Забрать новые отчёты врача приложения и переслать агенту. */
  pullReports(app: string): Promise<void>
  pullAllReports(): Promise<void>
  /** Paseo сообщил о конце хода агента. */
  agentMayBeIdle(agentId: string): void
  dispose(): Promise<void>
}

export interface PaseoBridgeOptions {
  config: BridgeConfig
  paseo: PaseoAgentsPort
  stateFile: string
  log: BridgeLog
  idlePollMs?: number
  deliveryTimeoutMs?: number
  fetch?: FetchLike
}

class Refusal {
  constructor(
    readonly status: number,
    readonly error: string,
  ) {}
}

type Json = Record<string, unknown>

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  if (response.headersSent) return
  response.writeHead(status, { 'content-type': 'application/json' })
  response.end(JSON.stringify(body))
}

function headerValue(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name.toLowerCase()]
  return Array.isArray(value) ? value[0] : value
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    const timer = setTimeout(() => {
      request.destroy()
      reject(new Refusal(408, 'body_timeout'))
    }, BODY_TIMEOUT_MS)
    request.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > BRIDGE_MAX_BODY_BYTES) {
        clearTimeout(timer)
        request.destroy()
        reject(new Refusal(413, 'too_large'))
      } else chunks.push(chunk)
    })
    request.on('end', () => {
      clearTimeout(timer)
      resolve(Buffer.concat(chunks).toString('utf8'))
    })
    request.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
  })
}

const isObject = (value: unknown): value is Json => value !== null && typeof value === 'object' && !Array.isArray(value)
const isCaseId = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0
const optionalString = (value: unknown, limit: number) =>
  value === undefined || (typeof value === 'string' && value.length <= limit)

function badRequest(): never {
  throw new Refusal(400, 'bad_request')
}

function parseTask(body: Json): BridgeTask {
  const { app, taskId, caseId, kind, fingerprint, summary, untrusted, links } = body
  if (
    typeof app !== 'string' ||
    typeof taskId !== 'string' ||
    !TASK_ID.test(taskId) ||
    !isCaseId(caseId) ||
    !(INCIDENT_KINDS as readonly unknown[]).includes(kind) ||
    typeof fingerprint !== 'string' ||
    !FINGERPRINT.test(fingerprint) ||
    typeof summary !== 'string' ||
    !isObject(untrusted) ||
    typeof untrusted.message !== 'string' ||
    !optionalString(untrusted.stack, 64 * 1024) ||
    !optionalString(untrusted.excerpt, 64 * 1024) ||
    !isObject(links) ||
    !(links.branch === undefined || (typeof links.branch === 'string' && BRANCH.test(links.branch))) ||
    !Array.isArray(links.reportIds) ||
    links.reportIds.length > 50 ||
    !links.reportIds.every(isCaseId)
  ) {
    badRequest()
  }
  return {
    appName: app,
    taskId,
    caseId,
    kind: kind as BridgeTask['kind'],
    fingerprint,
    summary,
    untrusted: {
      message: untrusted.message as string,
      ...(untrusted.stack === undefined ? {} : { stack: untrusted.stack as string }),
      ...(untrusted.excerpt === undefined ? {} : { excerpt: untrusted.excerpt as string }),
    },
    links: {
      ...(links.branch === undefined ? {} : { branch: links.branch as string }),
      reportIds: links.reportIds as number[],
    },
  }
}

/** Итог агента → тело `POST /v1/handoffs/:caseId/result` у врача. */
function parseResult(body: Json, taskId: string): Json {
  if (body.kind === 'done') {
    if (body.commit !== undefined && (typeof body.commit !== 'string' || !COMMIT.test(body.commit))) badRequest()
    if (body.version !== undefined && (typeof body.version !== 'string' || !VERSION.test(body.version))) badRequest()
    return {
      taskId,
      kind: 'done',
      ...(body.commit === undefined ? {} : { commit: body.commit }),
      deployed: body.version !== undefined,
      ...(body.version === undefined ? {} : { version: body.version }),
    }
  }
  if (body.kind === 'cannot') {
    const reason = body.reason
    if (typeof reason !== 'string' || reason.trim() === '' || reason.length > UNTRUSTED_LIMITS.reason) badRequest()
    return { taskId, kind: 'cannot', reason }
  }
  return badRequest()
}

export function createPaseoBridge(options: PaseoBridgeOptions): PaseoBridge {
  const { config, log } = options
  const state = new BridgeStateStore(options.stateFile, log)
  const replays = new ReplayGuard()
  /** Запросы, подписанные до запуска моста, не принимаются: память повторов после перезапуска пуста. */
  const startedAt = Date.now()
  /** Задачи, которые сейчас принимаются: повтор того же `taskId` ждёт первый приём, а не пишет второе письмо. */
  const receiving = new Map<string, Promise<Json>>()
  /** Итоги, которые сейчас уходят врачу. */
  const resultsInFlight = new Set<string>()
  const post = new AgentPost(options.paseo, {
    idlePollMs: options.idlePollMs ?? 15_000,
    deliveryTimeoutMs: options.deliveryTimeoutMs ?? 10 * 60_000,
  })
  const doctors = new Map<string, DoctorClient>()
  const doctor = (app: string): DoctorClient => {
    let client = doctors.get(app)
    if (!client) {
      client = new DoctorClient(config.apps.get(app)!, options.fetch)
      doctors.set(app, client)
    }
    return client
  }
  const relay = new ReportRelay({ config, state, post, doctor, log })
  const deliveries = new Set<Promise<unknown>>()

  const track = (work: Promise<unknown>) => {
    deliveries.add(work)
    void work.finally(() => deliveries.delete(work))
  }

  function deliverTask(task: BridgeTask, record: TaskRecord): void {
    const stillWanted = () => state.task(record.taskId)?.status === 'queued'
    track(
      post
        .deliver(record.agentId, taskLetter(task), stillWanted)
        .then((outcome) => {
          log({ event: 'task_delivery', app: record.appName, caseId: record.caseId, taskId: record.taskId, outcome })
          if (outcome !== 'sent' || state.moveTask(record.taskId, 'queued', 'delivered')) return
          // Отмена пришла, пока Paseo отправлял задачу: агент её уже получил — сказать ему остановиться.
          const now = state.task(record.taskId)
          if (now?.status === 'cancelled') deliverCancel(now, now.cancelReason ?? '')
        })
        .catch((error: unknown) =>
          log({ event: 'task_delivery', app: record.appName, caseId: record.caseId, taskId: record.taskId, outcome: 'failed', reason: errorText(error) }),
        ),
    )
  }

  function deliverCancel(record: TaskRecord, reason: string): void {
    track(
      post
        .deliver(record.agentId, cancelLetter({ appName: record.appName, caseId: record.caseId, reason }))
        .then((outcome) => log({ event: 'cancel_delivery', app: record.appName, taskId: record.taskId, outcome }))
        .catch((error: unknown) =>
          log({ event: 'cancel_delivery', app: record.appName, taskId: record.taskId, outcome: 'failed', reason: errorText(error) }),
        ),
    )
  }

  async function health(entry: BridgeApp): Promise<Json> {
    const agentState = await post.state(entry.agentId)
    if (agentState === 'not_ready') return { paseo: 'up', agent: 'missing', reason: 'paseo_not_ready' }
    return { paseo: 'up', agent: agentState }
  }

  async function receiveTask(app: string, entry: BridgeApp, body: Json): Promise<Json> {
    const task = parseTask(body)
    const known = state.task(task.taskId)
    if (known) {
      if (known.appName !== app) badRequest()
      return { queued: true }
    }
    const pending = receiving.get(task.taskId)
    if (pending) return pending
    const work = acceptTask(app, entry, task)
    receiving.set(task.taskId, work)
    try {
      return await work
    } finally {
      receiving.delete(task.taskId)
    }
  }

  async function acceptTask(app: string, entry: BridgeApp, task: BridgeTask): Promise<Json> {
    const agentState = await post.state(entry.agentId)
    if (agentState === 'missing' || agentState === 'not_ready') throw new Refusal(503, 'agent_missing')
    const record: TaskRecord = {
      taskId: task.taskId,
      appName: app,
      caseId: task.caseId,
      agentId: entry.agentId,
      status: 'queued',
      receivedAt: new Date().toISOString(),
    }
    state.addTask(record)
    log({ event: 'task_received', app, caseId: task.caseId, taskId: task.taskId })
    deliverTask(task, record)
    return { queued: true }
  }

  function cancelTask(app: string, pathTaskId: string, body: Json): Json {
    if (body.taskId !== pathTaskId || typeof body.reason !== 'string' || body.reason.length > UNTRUSTED_LIMITS.reason) {
      badRequest()
    }
    const record = state.task(pathTaskId)
    if (!record || record.appName !== app) throw new Refusal(404, 'unknown_task')
    if (record.status === 'cancelled') return { ok: true }
    const wasDelivered = record.status === 'delivered'
    // Задача ещё в очереди: письмо либо не уйдёт (проверка перед отправкой), либо уже уходит —
    // тогда «остановись» отправит доставка задачи, когда Paseo закончит отправку.
    state.moveTask(record.taskId, record.status, 'cancelled', { cancelReason: body.reason as string })
    log({ event: 'task_cancelled', app, caseId: record.caseId, taskId: record.taskId, wasDelivered })
    if (wasDelivered) deliverCancel(record, body.reason as string)
    return { ok: true }
  }

  function taskForAgentCommand(app: string, body: Json): TaskRecord {
    if (!isCaseId(body.caseId)) badRequest()
    const record = state.taskForCase(app, body.caseId)
    if (!record) throw new Refusal(404, 'unknown_task')
    return record
  }

  async function forwardResult(app: string, record: TaskRecord, body: Json): Promise<DoctorAnswer> {
    const result = parseResult(body, record.taskId)
    if (record.resultSent || resultsInFlight.has(record.taskId)) throw new Refusal(409, 'result_already_sent')
    // После отмены врач ждёт только позднюю выкатку («сделано»), «не смог» ему уже не нужен.
    if (record.status === 'cancelled' && result.kind !== 'done') throw new Refusal(409, 'task_cancelled')
    resultsInFlight.add(record.taskId)
    try {
      log({ event: 'agent_result', app, caseId: record.caseId, taskId: record.taskId, kind: result.kind as string })
      const answer = await askDoctor(app, (client) => client.post(`/v1/handoffs/${record.caseId}/result`, result))
      if (answer.status >= 200 && answer.status < 300) state.markResultSent(record.taskId)
      return answer
    } finally {
      resultsInFlight.delete(record.taskId)
    }
  }

  async function askDoctor(app: string, work: (client: DoctorClient) => Promise<DoctorAnswer>): Promise<DoctorAnswer> {
    try {
      return await work(doctor(app))
    } catch (error) {
      log({ event: 'doctor_unreachable', app, reason: errorText(error) })
      throw new Refusal(502, 'doctor_unreachable')
    }
  }

  async function route(request: IncomingMessage): Promise<DoctorAnswer> {
    const target = request.url ?? '/'
    const url = new URL(target, 'http://bridge.invalid')
    const method = request.method ?? 'GET'

    if (!headerValue(request, SIGNATURE_HEADER) || !headerValue(request, TIMESTAMP_HEADER)) {
      request.resume()
      throw new Refusal(401, 'missing')
    }

    if (method === 'GET' && url.pathname === '/health') {
      request.resume()
      const entry = config.apps.get(url.searchParams.get('app') ?? '')
      verify(request, method, target, '', entry)
      return { status: 200, body: await health(entry!) }
    }
    if (method !== 'POST') throw new Refusal(404, 'not_found')

    const raw = await readBody(request)
    let body: unknown
    try {
      body = JSON.parse(raw)
    } catch {
      badRequest()
    }
    if (!isObject(body) || typeof body['app'] !== 'string') badRequest()
    const app = body['app']
    const entry = config.apps.get(app)
    verify(request, method, target, raw, entry)
    if (!entry) throw new Refusal(401, 'bad_signature')

    const cancel = /^\/v1\/tasks\/([^/]+)\/cancel$/.exec(url.pathname)
    if (url.pathname === '/v1/tasks') return { status: 200, body: await receiveTask(app, entry, body) }
    if (cancel) return { status: 200, body: cancelTask(app, decodeURIComponent(cancel[1]!), body) }
    if (url.pathname === '/v1/reports/notify') {
      void relay.pull(app)
      return { status: 200, body: { ok: true } }
    }
    if (url.pathname === '/v1/agent/accepted') {
      const record = taskForAgentCommand(app, body)
      if (record.status === 'cancelled') throw new Refusal(409, 'task_cancelled')
      log({ event: 'agent_accepted', app, caseId: record.caseId, taskId: record.taskId })
      return askDoctor(app, (client) =>
        client.post(`/v1/handoffs/${record.caseId}/accepted`, { taskId: record.taskId, agent: record.agentId }),
      )
    }
    if (url.pathname === '/v1/agent/result') {
      return forwardResult(app, taskForAgentCommand(app, body), body)
    }
    if (url.pathname === '/v1/agent/case') {
      const record = taskForAgentCommand(app, body)
      return askDoctor(app, (client) => client.get(`/v1/cases/${record.caseId}`))
    }
    throw new Refusal(404, 'not_found')
  }

  function verify(request: IncomingMessage, method: string, target: string, body: string, entry: BridgeApp | undefined): void {
    if (!entry) throw new Refusal(401, 'bad_signature')
    const check = verifySignedRequest({ method, target, body, headers: request.headers, secret: entry.secret, notBefore: startedAt })
    if (!check.ok) throw new Refusal(401, check.reason)
    if (!replays.firstSeen(headerValue(request, NONCE_HEADER)!)) throw new Refusal(401, 'replayed')
  }

  const handler: BridgeHandler = async (request, response) => {
    try {
      const answer = await route(request)
      sendJson(response, answer.status, answer.body)
    } catch (error) {
      if (error instanceof Refusal) {
        log({ event: 'request_refused', path: (request.url ?? '/').split('?')[0], status: error.status, reason: error.error })
        sendJson(response, error.status, { error: error.error })
        return
      }
      log({ event: 'request_failed', path: (request.url ?? '/').split('?')[0], reason: errorText(error) })
      sendJson(response, 500, { error: 'internal' })
    }
  }

  return {
    handler,
    pullReports: (app) => relay.pull(app),
    pullAllReports: async () => {
      await Promise.all([...config.apps.keys()].map((app) => relay.pull(app)))
    },
    agentMayBeIdle: (agentId) => post.agentMayBeIdle(agentId),
    async dispose() {
      post.dispose()
      await Promise.allSettled([...deliveries])
    },
  }
}

export interface BridgeServer {
  url: string
  /** Сам сервер Node — для проверок. */
  node: Server
  close(): Promise<void>
}

/**
 * Слушать только заданный адрес частной сети. Публичный адрес, «все адреса» и имя хоста — ошибка до запуска.
 * Ошибки сервера после запуска (например, `EMFILE`) пишутся в журнал: без обработчика они уронили бы процесс плагина.
 */
export async function startBridgeServer(options: {
  listen: ListenAddress
  handler: BridgeHandler
  log?: BridgeLog
}): Promise<BridgeServer> {
  assertPrivateAddress(options.listen.host, 'адрес моста')
  const server = createServer((request, response) => {
    void options.handler(request, response)
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.listen.port, options.listen.host, () => {
      server.off('error', reject)
      resolve()
    })
  })
  server.on('error', (error) => options.log?.({ event: 'server_error', reason: errorText(error) }))
  const { address, port } = server.address() as AddressInfo
  return {
    url: `http://${hostForUrl(address)}:${port}`,
    node: server,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
}
