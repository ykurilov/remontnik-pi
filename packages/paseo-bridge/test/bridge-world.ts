import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { signBody, verifySignedBody } from '@ykurilov/remontnik-core/signed-http'
import {
  createPaseoBridge,
  startBridgeServer,
  type AgentState,
  type BridgeConfig,
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

  async state(agentId: string): Promise<AgentState> {
    return this.states.get(agentId) ?? 'missing'
  }

  async send(agentId: string, text: string): Promise<void> {
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
  private server: Server | null = null
  url = ''

  constructor(private readonly secret: string) {}

  async start(): Promise<void> {
    this.server = createServer((request, response) => {
      void this.handle(request).then(({ status, body }) => {
        response.writeHead(status, { 'content-type': 'application/json' })
        response.end(JSON.stringify(body))
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

  private async handle(request: IncomingMessage): Promise<{ status: number; body: unknown }> {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(chunk as Buffer)
    const body = Buffer.concat(chunks).toString('utf8')
    const method = request.method ?? 'GET'
    const path = request.url ?? '/'
    const signed = method === 'GET' ? `GET ${path}` : body
    const signatureOk = verifySignedBody({ body: signed, headers: request.headers, secret: this.secret }).ok
    this.requests.push({ method, path, body, signatureOk })
    if (!signatureOk) return { status: 401, body: { error: 'bad_signature' } }

    const url = new URL(path, 'http://doctor.invalid')
    if (method === 'GET' && url.pathname === '/v1/reports') {
      const after = Number(url.searchParams.get('after') ?? '0')
      const limit = Number(url.searchParams.get('limit') ?? '50')
      const reports = this.reports.filter((report) => report.reportId > after).slice(0, limit)
      return { status: 200, body: { reports, last: reports.at(-1)?.reportId ?? after } }
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

export async function startBridge(options: { config: BridgeConfig; paseo: FakePaseo; stateFile?: string }) {
  const bridge = createPaseoBridge({
    config: options.config,
    paseo: options.paseo,
    stateFile: options.stateFile ?? freshStateFile(),
    idlePollMs: 10,
    deliveryTimeoutMs: 2_000,
    log: () => {},
  })
  const server = await startBridgeServer({ listen: options.config.listen, handler: bridge.handler })
  return {
    bridge,
    server,
    async close() {
      await server.close()
      await bridge.dispose()
    },
  }
}

export async function signedPost(url: string, payload: unknown, secret: string) {
  const body = JSON.stringify(payload)
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...signBody(body, secret) },
    body,
  })
  return { status: response.status, body: (await response.json()) as Record<string, unknown> }
}

export async function signedGet(baseUrl: string, pathWithQuery: string, secret: string) {
  const response = await fetch(`${baseUrl}${pathWithQuery}`, { headers: signBody(`GET ${pathWithQuery}`, secret) })
  return { status: response.status, body: (await response.json()) as Record<string, unknown> }
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
