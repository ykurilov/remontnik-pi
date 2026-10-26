import type { IncomingMessage, ServerResponse } from 'node:http'
import { once } from 'node:events'
import { Readable } from 'node:stream'
import type { ReadableStream as WebReadableStream } from 'node:stream/web'
import { createGuardedHttp, type GuardedHttpLimits, type GuardedListener } from '../guarded-http/index.js'

// Зеркало реестра пакетов для контейнеров верстака. Им нужен реестр (установка зависимостей), а больше ничего.
// Туннеля нет: соединение с реестром по TLS ставит сам врач, адрес реестра задан здесь, а контейнер выбирает
// только имя пакета. Пропускаются `GET` и `HEAD` метаданных пакета и его архива; путь проверяется до запроса,
// `Host`, куки и прочие заголовки контейнера не уходят. Адреса архивов в метаданных переписываются на зеркало.
//
// Ответ идёт потоком: у реестра забирается не больше, чем прочёл контейнер, а метаданные переписываются по ходу,
// без разбора JSON. Память врача держат пределы размера (после распаковки), срок записи и число одновременных ответов.

export const NPM_REGISTRY = 'https://registry.npmjs.org'

export interface RegistryMirrorOptions {
  /** Реестр; по умолчанию — `registry.npmjs.org`. Другой — только для тестов и своего реестра владельца. */
  upstream?: string
  /** Адрес зеркала, как его видит контейнер (`http://remontnik-gateway:7801`): на него переписываются архивы. */
  publicUrl: string
  maxMetadataBytes?: number
  maxTarballBytes?: number
  upstreamTimeoutMs?: number
  /** Клиент не забирает ответ дольше этого — соединение рвётся. */
  writeTimeoutMs?: number
  /** Одновременных ответов реестра во всём зеркале. */
  maxConcurrentResponses?: number
  /** Сколько запрос ждёт места среди одновременных ответов, потом — `503`. */
  queueTimeoutMs?: number
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
const WRITE_TIMEOUT_MS = 60_000
const MAX_CONCURRENT_RESPONSES = 32
const QUEUE_TIMEOUT_MS = 30_000
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

/**
 * Замена `from` на `to` по кускам потока: совпадение, разрезанное между кусками, тоже находится. Так адреса архивов
 * реестра в метаданных переписываются на зеркало без разбора JSON. Чужие адреса остаются: контейнер до них не дотянется.
 */
export function createReplacer(from: string, to: string): { push(chunk: Buffer): Buffer; end(): Buffer } {
  const pattern = Buffer.from(from)
  const replacement = Buffer.from(to)
  let carry = Buffer.alloc(0)
  return {
    push(chunk) {
      const data = carry.length > 0 ? Buffer.concat([carry, chunk]) : chunk
      const parts: Buffer[] = []
      let at = 0
      for (let found = data.indexOf(pattern, at); found !== -1; found = data.indexOf(pattern, at)) {
        parts.push(data.subarray(at, found), replacement)
        at = found + pattern.length
      }
      // Хвост, где может начинаться совпадение, ждёт следующего куска.
      const keep = Math.max(at, data.length - (pattern.length - 1))
      parts.push(data.subarray(at, keep))
      carry = Buffer.from(data.subarray(keep))
      return Buffer.concat(parts)
    },
    end() {
      return carry
    },
  }
}

/** Места для одновременных ответов: лишний запрос ждёт, не дождался — отказ; ушёл из очереди — место не занимает. */
function createSlots(max: number, waitMs: number): { acquire(signal: AbortSignal): Promise<() => void> } {
  let busy = 0
  const waiting: (() => void)[] = []
  const release = () => {
    const next = waiting.shift()
    if (next) next()
    else busy -= 1
  }
  return {
    acquire(signal) {
      const once = () => {
        let done = false
        return () => {
          if (done) return
          done = true
          release()
        }
      }
      if (busy < max) {
        busy += 1
        return Promise.resolve(once())
      }
      return new Promise((resolve, reject) => {
        const leave = (refusal: Refusal) => {
          clearTimeout(timer)
          signal.removeEventListener('abort', gone)
          waiting.splice(waiting.indexOf(grant), 1)
          reject(refusal)
        }
        const grant = () => {
          clearTimeout(timer)
          signal.removeEventListener('abort', gone)
          resolve(once())
        }
        const gone = () => leave(new Refusal(499, 'клиент ушёл'))
        const timer = setTimeout(() => leave(new Refusal(503, 'зеркало занято, повторите позже')), waitMs)
        waiting.push(grant)
        signal.addEventListener('abort', gone, { once: true })
      })
    },
  }
}

export function createRegistryMirror(options: RegistryMirrorOptions): RegistryMirror {
  const upstream = checkedUrl(options.upstream ?? NPM_REGISTRY, 'адрес реестра', ['https:', 'http:']).origin
  const publicUrl = checkedUrl(options.publicUrl, 'publicUrl зеркала', ['http:']).origin
  const maxMetadataBytes = options.maxMetadataBytes ?? MAX_METADATA_BYTES
  const maxTarballBytes = options.maxTarballBytes ?? MAX_TARBALL_BYTES
  const upstreamTimeoutMs = options.upstreamTimeoutMs ?? UPSTREAM_TIMEOUT_MS
  const writeTimeoutMs = options.writeTimeoutMs ?? WRITE_TIMEOUT_MS
  const slots = createSlots(options.maxConcurrentResponses ?? MAX_CONCURRENT_RESPONSES, options.queueTimeoutMs ?? QUEUE_TIMEOUT_MS)

  function reply(response: ServerResponse, status: number, text: string): void {
    if (response.headersSent || response.closed) {
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
    // Клиент ушёл — место в очереди освобождается, запрос к реестру отменяется; реестр молчит дольше срока — тоже.
    const gone = new AbortController()
    response.once('close', () => gone.abort())
    if (response.closed) gone.abort()
    if (gone.signal.aborted) return
    const release = await slots.acquire(gone.signal)
    // Ответ закрылся, пока место выдавалось: оно возвращается сразу.
    if (gone.signal.aborted) {
      release()
      return
    }
    response.once('close', release)
    const signal = AbortSignal.any([AbortSignal.timeout(upstreamTimeoutMs), gone.signal])
    let upstreamResponse: Response
    try {
      upstreamResponse = await fetch(`${upstream}${target.path}`, { method: request.method, headers, redirect: 'manual', signal })
    } catch (error) {
      throw signal.aborted ? new Refusal(504, 'реестр не ответил в срок') : new Refusal(502, `реестр недоступен: ${(error as Error).message}`)
    }
    const body = upstreamResponse.body
    try {
      if (upstreamResponse.status >= 300 && upstreamResponse.status < 400) throw new Refusal(502, 'реестр ответил перенаправлением: зеркало по нему не идёт')
      const limit = target.tarball ? maxTarballBytes : maxMetadataBytes
      const declared = Number(upstreamResponse.headers.get('content-length') ?? '0')
      if (declared > limit) throw new Refusal(502, 'ответ реестра больше предела')
    } catch (error) {
      await body?.cancel().catch(() => {})
      throw error
    }
    const contentType = upstreamResponse.headers.get('content-type') ?? 'application/octet-stream'
    const passed: Record<string, string> = { 'content-type': contentType }
    for (const name of ['etag', 'last-modified']) {
      const value = upstreamResponse.headers.get(name)
      if (value) passed[name] = value
    }
    if (request.method === 'HEAD' || !body) {
      await body?.cancel().catch(() => {})
      response.writeHead(upstreamResponse.status, passed)
      response.end()
      return
    }

    // Длина после переписывания другая, поэтому ответ идёт частями (chunked). Заголовки уходят с первым куском:
    // ответ больше предела уже в первом куске получает 502. Запись ждёт, пока клиент читает (drain); не читает
    // дольше срока — соединение рвётся, запрос к реестру отменяется.
    response.statusCode = upstreamResponse.status
    for (const [name, value] of Object.entries(passed)) response.setHeader(name, value)
    const limit = target.tarball ? maxTarballBytes : maxMetadataBytes
    const replacer = !target.tarball && upstreamResponse.ok && /json/i.test(contentType) ? createReplacer(`"${upstream}/`, `"${publicUrl}/`) : undefined
    const write = async (chunk: Buffer) => {
      if (chunk.length === 0 || response.write(chunk)) return
      try {
        await once(response, 'drain', { signal: AbortSignal.any([gone.signal, AbortSignal.timeout(writeTimeoutMs)]) })
      } catch {
        response.destroy()
        throw new Refusal(502, gone.signal.aborted ? 'клиент ушёл' : 'клиент не забирает ответ в срок')
      }
    }
    let size = 0
    try {
      for await (const chunk of Readable.fromWeb(body as WebReadableStream<Uint8Array>)) {
        size += chunk.length
        if (size > limit) throw new Refusal(502, 'ответ реестра больше предела')
        await write(replacer ? replacer.push(chunk) : chunk)
      }
      if (replacer) await write(replacer.end())
    } catch (error) {
      gone.abort()
      if (error instanceof Refusal) throw error
      throw signal.aborted && !gone.signal.aborted ? new Refusal(504, 'реестр не ответил в срок') : new Refusal(502, 'ответ реестра оборвался')
    }
    response.end()
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
