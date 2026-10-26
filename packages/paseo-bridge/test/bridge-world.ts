import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NONCE_HEADER, signRequest, signResponse, verifySignedRequest } from '@ykurilov/remontnik-core/signed-http'
import {
  createPaseoBridge,
  startBridgeServer,
  type AgentState,
  type BridgeConfig,
  type BridgeServerLimits,
  type PaseoAgentsPort,
} from '../server/index.js'

// Подставной Paseo, подставной врач и запуск моста на 127.0.0.1 для тестов.

export const SHOP_SECRET = 'test-secret-shop-0001'
export const BLOG_SECRET = 'test-secret-blog-0002'
export const SHOP_AGENT = 'agent-shop-1111'
export const BLOG_AGENT = 'agent-blog-2222'

export class FakePaseo implements PaseoAgentsPort {
  states = new Map<string, AgentState>()
  letters: { agentId: string; text: string }[] = []
  failNextSend = false
  /** Пока не выполнен — отправка висит (Paseo ещё доставляет письмо). */
  sendGate: Promise<void> | null = null
  sendsStarted = 0
  stateDelayMs = 0

  async state(agentId: string): Promise<AgentState> {
    if (this.stateDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.stateDelayMs))
    return this.states.get(agentId) ?? 'missing'
  }

  async send(agentId: string, text: string): Promise<void> {
    this.sendsStarted += 1
    if (this.sendGate) await this.sendGate
    if (this.failNextSend) {
      this.failNextSend = false
      throw new Error('send failed')
    }
    this.letters.push({ agentId, text })
  }

  lettersTo(agentId: string): string[] {
    return this.letters.filter((letter) => letter.agentId === agentId).map((letter) => letter.text)
  }
}

export interface DoctorAnswerPlan {
  status: number
  body?: unknown
  raw?: string
  headers?: Record<string, string>
}

export interface DoctorRequest {
  method: string
  path: string
  body: string
  signatureOk: boolean
}

/** Подставной врач: проверяет подпись моста и отвечает по заданным правилам. */
export class FakeDoctor {
  requests: DoctorRequest[] = []
  reports: { reportId: number; caseId?: number; type: string; short: string; full: string; createdAt: string }[] = []
  acked: number[] = []
  /** Что врач уже считает подтверждённым Paseo до начала проверки (его память, а не память моста). */
  ackedBefore = 0
  /** Старый врач: поля `acked` в ленте нет. */
  omitAckedField = false
  /** Врач отдаёт страницу не больше стольки отчётов, сколько ни проси (обрезка по размеру). */
  pageLimit = Number.POSITIVE_INFINITY
  /** Чем подписывать ответы: своим секретом, чужим или не подписывать. */
  answerSigning: 'own' | 'foreign' | 'none' = 'own'
  /** Свой ответ на запрос вместо обычного. */
  override: ((method: string, path: string) => DoctorAnswerPlan | undefined) | null = null
  private server: Server | null = null
  url = ''

  constructor(private readonly secret: string) {}

  async start(): Promise<void> {
    this.server = createServer((request, response) => {
      void this.handle(request).then((plan) => {
        const raw = plan.raw ?? JSON.stringify(plan.body)
        const nonce = String(request.headers[NONCE_HEADER.toLowerCase()] ?? '')
        const signature =
          this.answerSigning === 'none'
            ? {}
            : signResponse({
                request: { method: request.method ?? 'GET', target: request.url ?? '/', nonce },
                status: plan.status,
                body: raw,
                secret: this.answerSigning === 'own' ? this.secret : 'foreign-secret',
              })
        response.writeHead(plan.status, { 'content-type': 'application/json', ...signature, ...plan.headers })
        response.end(raw)
      })
    })
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve))
    const { port } = this.server.address() as AddressInfo
    this.url = `http://127.0.0.1:${port}`
  }

  async stop(): Promise<void> {
    this.server?.closeAllConnections()
    await new Promise<void>((resolve) => this.server?.close(() => resolve()) ?? resolve())
  }

  private async handle(request: IncomingMessage): Promise<DoctorAnswerPlan> {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(chunk as Buffer)
    const body = Buffer.concat(chunks).toString('utf8')
    const method = request.method ?? 'GET'
    const path = request.url ?? '/'
    const signatureOk = verifySignedRequest({ method, target: path, body, headers: request.headers, secret: this.secret }).ok
    this.requests.push({ method, path, body, signatureOk })
    if (!signatureOk) return { status: 401, body: { error: 'bad_signature' } }
    const planned = this.override?.(method, path)
    if (planned) return planned

    const url = new URL(path, 'http://doctor.invalid')
    if (method === 'GET' && url.pathname === '/v1/reports') {
      const after = Number(url.searchParams.get('after') ?? '0')
      const limit = Number(url.searchParams.get('limit') ?? '50')
      const reports = this.reports.filter((report) => report.reportId > after).slice(0, Math.min(limit, this.pageLimit))
      const acked = Math.max(this.ackedBefore, ...this.acked)
      return { status: 200, body: { reports, last: reports.at(-1)?.reportId ?? after, ...(this.omitAckedField ? {} : { acked }) } }
    }
    if (method === 'POST' && url.pathname === '/v1/reports/ack') {
      this.acked.push((JSON.parse(body) as { upTo: number }).upTo)
      return { status: 200, body: { ok: true } }
    }
    if (method === 'GET' && /^\/v1\/cases\/\d+$/.test(url.pathname)) {
      return { status: 200, body: { case: { id: Number(url.pathname.split('/').at(-1)) } } }
    }
    if (method === 'POST' && /^\/v1\/handoffs\/\d+\/(accepted|result)$/.test(url.pathname)) {
      return { status: 200, body: { ok: true } }
    }
    return { status: 404, body: { error: 'not_found' } }
  }
}

export function makeConfig({ shop: shopDoctor, blog: blogDoctor }: { shop: string; blog: string }, listen = { host: '127.0.0.1', port: 0 }): BridgeConfig {
  return {
    listen,
    apps: new Map([
      ['shop', { agentId: SHOP_AGENT, doctorUrl: shopDoctor, secret: SHOP_SECRET }],
      ['blog', { agentId: BLOG_AGENT, doctorUrl: blogDoctor, secret: BLOG_SECRET }],
    ]),
  }
}

export function freshStateFile(): string {
  return join(mkdtempSync(join(tmpdir(), 'remontnik-bridge-')), 'state.json')
}

export async function startBridge(options: { config: BridgeConfig; paseo: FakePaseo; stateFile?: string; limits?: Partial<BridgeServerLimits> }) {
  const journal: Record<string, unknown>[] = []
  const log = (entry: Record<string, unknown>) => void journal.push(entry)
  const bridge = createPaseoBridge({
    config: options.config,
    paseo: options.paseo,
    stateFile: options.stateFile ?? freshStateFile(),
    idlePollMs: 10,
    deliveryTimeoutMs: 2_000,
    log,
  })
  const server = await startBridgeServer({ listen: options.config.listen, handler: bridge.handler, log, ...(options.limits ? { limits: options.limits } : {}) })
  return {
    bridge,
    server,
    journal,
    async close() {
      await server.close()
      await bridge.dispose()
    },
  }
}

/** Подписанный POST как от врача. `signedFor` — подписать для другого пути (проверка подмены адреса). */
export function signedPostRequest(url: string, payload: unknown, secret: string, signedFor?: string) {
  const body = JSON.stringify(payload)
  const { pathname, search } = new URL(url)
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...signRequest({ method: 'POST', target: signedFor ?? `${pathname}${search}`, body, secret }) },
    body,
  }
}

export async function send(url: string, init: RequestInit) {
  const response = await fetch(url, init)
  return { status: response.status, body: (await response.json()) as Record<string, unknown> }
}

export async function signedPost(url: string, payload: unknown, secret: string, signedFor?: string) {
  return send(url, signedPostRequest(url, payload, secret, signedFor))
}

export async function signedGet(baseUrl: string, pathWithQuery: string, secret: string) {
  return send(`${baseUrl}${pathWithQuery}`, {
    headers: signRequest({ method: 'GET', target: pathWithQuery, body: '', secret }),
  })
}

export function shopTask(overrides: Record<string, unknown> = {}) {
  return {
    app: 'shop',
    taskId: '01JAAAAAAAAAAAAAAAAAAAAAAA',
    caseId: 7,
    kind: 'crash',
    fingerprint: '0123456789abcdef',
    summary: 'Падение при оплате корзины',
    untrusted: { message: 'TypeError: cart is undefined', stack: 'at checkout (src/cart.ts:10:5)' },
    links: { branch: 'remontnik/7-cart', reportIds: [3, 4] },
    ...overrides,
  }
}

/** Ждать условия, без жёстких пауз. */
export async function until(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
  const started = Date.now()
  while (!condition()) {
    if (Date.now() - started > timeoutMs) throw new Error('условие не наступило')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

/** Ключ задачи из письма агенту: им агент подписывает свои команды вместо секрета моста. */
export function taskKeyFrom(letter: string): string {
  const match = /--key ([0-9a-f]{64})/.exec(letter)
  if (!match) throw new Error('в письме нет ключа задачи')
  return match[1]!
}
