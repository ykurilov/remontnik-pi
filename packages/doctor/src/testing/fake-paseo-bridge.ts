import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo, Socket } from 'node:net'
import { NONCE_HEADER, signRequest, verifySignedRequest, verifySignedResponse } from '@ykurilov/remontnik-core/signed-http'

// Подставной мост Paseo для тестов режима «сначала Paseo» (contracts/paseo-bridge.md). Со стороны врача — те же
// маршруты, что у настоящего моста (`/health`, `/v1/tasks`, `/v1/tasks/:taskId/cancel`), с проверкой подписи врача.
// Со стороны агента — подписанные вызовы к врачу (`accepted`, `result`, лента отчётов) с проверкой подписи ответа:
// так мост пересылает команды агента. Состояние `health` переключает тест: мост завис, пропал или агента нет.

export type FakeBridgeHealth = 'up' | 'hang' | 'down' | 'agent_missing'

export interface FakeBridgeTask {
  taskId: string
  app: string
  caseId: number
  kind: string
  fingerprint: string
  summary: string
  untrusted: { message: string; stack?: string; excerpt?: string }
  links: { branch?: string; reportIds: number[] }
}

export interface DoctorReply {
  status: number
  body: unknown
}

export interface FakePaseoBridge {
  url: string
  /** Задачи, которые врач отдал мосту. */
  readonly tasks: FakeBridgeTask[]
  /** Отмены задач от врача. */
  readonly cancels: { taskId: string; reason: string }[]
  /** Запросы врача с неверной подписью. */
  readonly badSignatures: number
  health: FakeBridgeHealth
  /** Адрес врача для моста: туда агент шлёт свои команды. */
  connect(doctorBridgeUrl: string): void
  accept(caseId: number): Promise<DoctorReply>
  done(caseId: number, outcome: { commit?: string; version?: string }, options?: { secret?: string }): Promise<DoctorReply>
  cannot(caseId: number, reason: string): Promise<DoctorReply>
  /** Лента отчётов врача, как её читает мост. */
  reports(after?: number): Promise<{ reportId: number; caseId?: number; type: string; short: string; full: string }[]>
  close(): Promise<void>
}

export async function startFakePaseoBridge(options: { secret: string; appName: string; agent?: string }): Promise<FakePaseoBridge> {
  const { secret, appName } = options
  const agent = options.agent ?? 'fake-agent'
  const tasks: FakeBridgeTask[] = []
  const cancels: { taskId: string; reason: string }[] = []
  const sockets = new Set<Socket>()
  let badSignatures = 0
  let doctorUrl: string | undefined

  const send = (response: ServerResponse, status: number, body: unknown) => {
    response.writeHead(status, { 'content-type': 'application/json' })
    response.end(JSON.stringify(body))
  }

  const readBody = (request: IncomingMessage) =>
    new Promise<string>((resolve, reject) => {
      const chunks: Buffer[] = []
      request.on('data', (chunk: Buffer) => chunks.push(chunk))
      request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
      request.on('error', reject)
    })

  const server = createServer((request, response) => {
    void (async () => {
      if (bridge.health === 'down') {
        request.socket.destroy()
        return
      }
      const target = request.url ?? '/'
      const method = request.method ?? 'GET'
      const body = method === 'POST' ? await readBody(request) : ''
      const check = verifySignedRequest({ method, target, body, headers: request.headers, secret })
      if (!check.ok) {
        badSignatures += 1
        send(response, 401, { error: check.reason })
        return
      }
      const url = new URL(target, 'http://bridge.invalid')
      if (method === 'GET' && url.pathname === '/health') {
        if (bridge.health === 'hang') return
        send(response, 200, bridge.health === 'agent_missing' ? { paseo: 'up', agent: 'missing', reason: 'paseo_not_ready' } : { paseo: 'up', agent: 'idle' })
        return
      }
      const parsed = JSON.parse(body) as Record<string, unknown>
      if (parsed.app !== appName) {
        send(response, 401, { error: 'bad_signature' })
        return
      }
      if (method === 'POST' && url.pathname === '/v1/tasks') {
        if (bridge.health === 'agent_missing') return send(response, 503, { error: 'agent_missing' })
        if (bridge.health === 'hang') return
        if (!tasks.some((task) => task.taskId === parsed.taskId)) tasks.push(parsed as unknown as FakeBridgeTask)
        send(response, 200, { queued: true })
        return
      }
      const cancel = /^\/v1\/tasks\/([^/]+)\/cancel$/.exec(url.pathname)
      if (method === 'POST' && cancel) {
        const taskId = decodeURIComponent(cancel[1]!)
        if (!cancels.some((known) => known.taskId === taskId)) cancels.push({ taskId, reason: String(parsed.reason) })
        send(response, 200, { ok: true })
        return
      }
      send(response, 404, { error: 'not_found' })
    })().catch(() => send(response, 500, { error: 'internal' }))
  })
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo

  async function askDoctor(method: 'GET' | 'POST', path: string, payload: unknown, signWith = secret): Promise<DoctorReply> {
    if (!doctorUrl) throw new Error('подставной мост не знает адреса врача')
    const body = method === 'POST' ? JSON.stringify(payload) : ''
    const signature = signRequest({ method, target: path, body, secret: signWith })
    const response = await fetch(`${doctorUrl}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...signature },
      ...(method === 'POST' ? { body } : {}),
      redirect: 'manual',
    })
    const text = await response.text()
    if (signWith === secret && response.status !== 401) {
      const answer = verifySignedResponse({ request: { method, target: path, nonce: signature[NONCE_HEADER] }, status: response.status, body: text, headers: response.headers, secret })
      if (!answer.ok) throw new Error(`подпись ответа врача не прошла проверку (${answer.reason})`)
    }
    return { status: response.status, body: text === '' ? null : JSON.parse(text) }
  }

  const taskOf = (caseId: number): FakeBridgeTask => {
    const task = tasks.findLast((known) => known.caseId === caseId)
    if (!task) throw new Error(`подставному мосту не передавали случай ${caseId}`)
    return task
  }

  const bridge: FakePaseoBridge = {
    url: `http://127.0.0.1:${port}`,
    tasks,
    cancels,
    get badSignatures() {
      return badSignatures
    },
    health: 'up',
    connect(url) {
      doctorUrl = url
    },
    accept: (caseId) => askDoctor('POST', `/v1/handoffs/${caseId}/accepted`, { taskId: taskOf(caseId).taskId, agent }),
    done: (caseId, outcome, sign) =>
      askDoctor(
        'POST',
        `/v1/handoffs/${caseId}/result`,
        {
          taskId: taskOf(caseId).taskId,
          kind: 'done',
          ...(outcome.commit === undefined ? {} : { commit: outcome.commit }),
          deployed: outcome.version !== undefined,
          ...(outcome.version === undefined ? {} : { version: outcome.version }),
        },
        sign?.secret,
      ),
    cannot: (caseId, reason) => askDoctor('POST', `/v1/handoffs/${caseId}/result`, { taskId: taskOf(caseId).taskId, kind: 'cannot', reason }),
    async reports(after = 0) {
      const answer = await askDoctor('GET', `/v1/reports?after=${after}&limit=100`, undefined)
      if (answer.status !== 200) throw new Error(`лента отчётов ответила ${answer.status}`)
      return (answer.body as { reports: Awaited<ReturnType<FakePaseoBridge['reports']>> }).reports
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy()
        server.close(() => resolve())
      }),
  }
  return bridge
}
