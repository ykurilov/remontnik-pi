import type { IncomingMessage, ServerResponse } from 'node:http'
import { createGuardedHttp, type GuardedHttpLimits, type GuardedListener } from '../guarded-http/index.js'

// Зеркало реестра пакетов для контейнеров верстака. Им нужен реестр (установка зависимостей), а больше ничего.
// Туннеля нет: соединение с реестром по TLS ставит сам врач, адрес реестра задан здесь, а контейнер выбирает
// только имя пакета. Пропускаются `GET` и `HEAD` метаданных пакета и его архива; путь проверяется до запроса,
// `Host`, куки и прочие заголовки контейнера не уходят. Адреса архивов в метаданных переписываются на зеркало.

export const NPM_REGISTRY = 'https://registry.npmjs.org'

export interface RegistryMirrorOptions {
  /** Реестр; по умолчанию — `registry.npmjs.org`. Другой — только для тестов и своего реестра владельца. */
  upstream?: string
  /** Адрес зеркала, как его видит контейнер (`http://remontnik-gateway:7801`): на него переписываются архивы. */
  publicUrl: string
  maxMetadataBytes?: number
  maxTarballBytes?: number
  upstreamTimeoutMs?: number
  limits?: Partial<GuardedHttpLimits>
  log?: (line: string) => void
}

export interface RegistryMirror {
  upstream: string
  publicUrl: string
  /** Слушать на адресе врача в сети случая. */
  listen(host: string, port: number): Promise<GuardedListener>
  close(): Promise<void>
}

const MAX_METADATA_BYTES = 64 * 1024 * 1024
const MAX_TARBALL_BYTES = 256 * 1024 * 1024
const UPSTREAM_TIMEOUT_MS = 120_000
const NAME = '[A-Za-z0-9][A-Za-z0-9._~-]*'
// `/name`, `/@scope/name`, `/@scope%2fname`; архив — `<пакет>/-/<файл>.tgz`.
const PACKAGE_PATH = new RegExp(`^/(?:(@${NAME})(?:/|%2[fF]))?(${NAME})(?:/-/(${NAME}\\.tgz))?$`)
const ACCEPT = /^[\w.+\-/*;=, ]{1,200}$/

class Refusal extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
  }
}

/** Путь запроса → путь в реестре или отказ. Строка запроса отбрасывается. */
export function registryPath(url: string): { path: string; tarball: boolean } {
  const queryAt = url.indexOf('?')
  const path = queryAt === -1 ? url : url.slice(0, queryAt)
  const match = PACKAGE_PATH.exec(path)
  if (!match) throw new Refusal(400, 'зеркало отдаёт только пакеты: /имя, /@область/имя и их архивы')
  const [, scope, name, file] = match
  if ([scope, name, file].some((part) => part !== undefined && /(^|[@/])\.\.?($|\/)/.test(part))) throw new Refusal(400, 'недопустимое имя пакета')
  const packagePath = scope ? `/${scope}/${name}` : `/${name}`
  // Метаданные пакета с областью реестр отдаёт по `%2f`, архив — по обычному пути.
  if (file) return { path: `${packagePath}/-/${file}`, tarball: true }
  return { path: scope ? `/${scope}%2f${name}` : packagePath, tarball: false }
}

function checkedUrl(text: string, what: string, protocols: string[]): URL {
  const url = new URL(text)
  if (!protocols.includes(url.protocol) || url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) {
    throw new Error(`${what}: нужен адрес вида ${protocols[0]}//host[:port]`)
  }
  return url
}

/** Метаданные с адресами архивов реестра, переписанными на зеркало. Чужие адреса остаются: контейнер до них не дотянется. */
function rewriteTarballs(body: Buffer, upstream: string, publicUrl: string): Buffer {
  const document = JSON.parse(body.toString('utf8')) as { versions?: Record<string, { dist?: { tarball?: unknown } }> }
  for (const version of Object.values(document.versions ?? {})) {
    const tarball = version?.dist?.tarball
    if (typeof tarball === 'string' && tarball.startsWith(`${upstream}/`)) version.dist!.tarball = `${publicUrl}${tarball.slice(upstream.length)}`
  }
  return Buffer.from(JSON.stringify(document))
}

export function createRegistryMirror(options: RegistryMirrorOptions): RegistryMirror {
  const upstream = checkedUrl(options.upstream ?? NPM_REGISTRY, 'адрес реестра', ['https:', 'http:']).origin
  const publicUrl = checkedUrl(options.publicUrl, 'publicUrl зеркала', ['http:']).origin
  const maxMetadataBytes = options.maxMetadataBytes ?? MAX_METADATA_BYTES
  const maxTarballBytes = options.maxTarballBytes ?? MAX_TARBALL_BYTES
  const upstreamTimeoutMs = options.upstreamTimeoutMs ?? UPSTREAM_TIMEOUT_MS

  function reply(response: ServerResponse, status: number, text: string): void {
    if (response.headersSent) {
      response.destroy()
      return
    }
    response.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', connection: 'close' })
    response.end(text)
  }

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.method !== 'GET' && request.method !== 'HEAD') throw new Refusal(405, 'зеркало только читает: GET и HEAD')
    const target = registryPath(request.url ?? '')
    const accept = request.headers.accept
    const headers: Record<string, string> = { 'user-agent': 'remontnik-registry-mirror', ...(accept && ACCEPT.test(accept) ? { accept } : {}) }
    const signal = AbortSignal.timeout(upstreamTimeoutMs)
    let upstreamResponse: Response
    try {
      upstreamResponse = await fetch(`${upstream}${target.path}`, { method: request.method, headers, redirect: 'manual', signal })
    } catch (error) {
      throw signal.aborted ? new Refusal(504, 'реестр не ответил в срок') : new Refusal(502, `реестр недоступен: ${(error as Error).message}`)
    }
    if (upstreamResponse.status >= 300 && upstreamResponse.status < 400) throw new Refusal(502, 'реестр ответил перенаправлением: зеркало по нему не идёт')
    const limit = target.tarball ? maxTarballBytes : maxMetadataBytes
    const declared = Number(upstreamResponse.headers.get('content-length') ?? '0')
    if (declared > limit) throw new Refusal(502, 'ответ реестра больше предела')
    const contentType = upstreamResponse.headers.get('content-type') ?? 'application/octet-stream'
    const passed: Record<string, string> = { 'content-type': contentType }
    for (const name of ['etag', 'last-modified']) {
      const value = upstreamResponse.headers.get(name)
      if (value) passed[name] = value
    }

    const chunks: Buffer[] = []
    let size = 0
    const streaming = target.tarball && upstreamResponse.ok
    try {
      for await (const chunk of upstreamResponse.body ?? []) {
        size += chunk.length
        if (size > limit) throw new Refusal(502, 'ответ реестра больше предела')
        if (streaming) {
          if (!response.headersSent) response.writeHead(upstreamResponse.status, passed)
          response.write(chunk)
        } else chunks.push(Buffer.from(chunk))
      }
    } catch (error) {
      if (error instanceof Refusal) throw error
      throw signal.aborted ? new Refusal(504, 'реестр не ответил в срок') : new Refusal(502, 'ответ реестра оборвался')
    }
    if (streaming) {
      if (!response.headersSent) response.writeHead(upstreamResponse.status, passed)
      response.end()
      return
    }
    let body: Buffer = Buffer.concat(chunks)
    if (upstreamResponse.ok && request.method === 'GET' && /json/i.test(contentType)) {
      try {
        body = rewriteTarballs(body, upstream, publicUrl)
      } catch {
        throw new Refusal(502, 'метаданные реестра не разобрались')
      }
    }
    response.writeHead(upstreamResponse.status, { ...passed, 'content-length': String(body.length) })
    response.end(request.method === 'HEAD' ? undefined : body)
  }

  const http = createGuardedHttp((request, response) => {
    response.on('error', () => {})
    handle(request, response).catch((error: unknown) => {
      if (error instanceof Refusal) {
        if (error.status >= 500) options.log?.(`[зеркало] ${request.method} ${request.url}: ${error.message}`)
        return reply(response, error.status, error.message)
      }
      options.log?.(`[зеркало] сбой: ${(error as Error).message}`)
      reply(response, 500, 'сбой зеркала')
    })
  }, options.limits)

  return { upstream, publicUrl, listen: (host, port) => http.listen(host, port), close: () => http.close() }
}
