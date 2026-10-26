import { createHash, randomBytes } from 'node:crypto'
import { isAbsolute, relative, sep } from 'node:path'
import { redactSecrets } from '../redact/index.js'

export const INCIDENT_KINDS = ['crash', 'model_error', 'tool_error', 'turn_failed', 'bad_answer', 'manual'] as const
export type IncidentKind = (typeof INCIDENT_KINDS)[number]

/** Пределы полей события (data-model.md). */
export const INCIDENT_LIMITS = Object.freeze({
  message: 2000,
  stack: 8000,
  contextBytes: 4096,
  contextValue: 256,
  badAnswerExcerpt: 500,
  badAnswerExplanation: 1000,
})

export interface IncidentContext {
  processName?: string
  /** Версия из команды `current` приложения. */
  release?: string | null
  chatId?: string
  model?: string
  provider?: string
  tool?: string
  [key: string]: unknown
}

export interface BadAnswer {
  conversationId: string
  messageIndex: number
  category: string
  excerpt: string
  explanation: string
  /** 0..1 */
  confidence: number
}

/** Одно появление сбоя: очередь сторожа → врач. */
export interface IncidentEvent {
  /** ULID, ключ повторной доставки. */
  eventId: string
  appName: string
  kind: IncidentKind
  /** sha256, 16 символов: вид + место + нормализованный текст. */
  fingerprint: string
  where: string
  message: string
  stack: string
  context: IncidentContext
  badAnswer?: BadAnswer
  /** ISO-время. */
  occurredAt: string
}

export interface IncidentInput {
  appName: string
  kind: IncidentKind
  where: string
  message: string
  stack?: string
  context?: IncidentContext
  badAnswer?: BadAnswer
  occurredAt?: Date
  eventId?: string
}

export interface CreateIncidentOptions {
  /** Дополнительная вычистка приложения, поверх встроенной. */
  redact?: (text: string) => string
  /** Точные значения секретов, известные вызывающему. */
  knownSecrets?: readonly string[]
}

const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi
const ULID = /\b[0-9A-HJKMNP-TV-Z]{26}\b/g
const HEX_ID = /\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{8,}\b/gi
const URL = /\b[a-z][a-z0-9+.-]*:\/\/[^\s'"<>)]+/gi
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g
const IP_WITH_PORT = /\b\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?\b/g
const NUMBER = /\d+(?:[.,]\d+)*/g

/** Текст ошибки без чисел, адресов и идентификаторов: одинаковые сбои дают одинаковый текст. */
export function normalizeErrorText(text: string): string {
  return text
    .replace(URL, '<url>')
    .replace(EMAIL, '<email>')
    .replace(UUID, '<id>')
    .replace(ULID, '<id>')
    .replace(HEX_ID, '<id>')
    .replace(IP_WITH_PORT, '<ip>')
    .replace(NUMBER, '<n>')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Отпечаток сбоя: sha256 от вида, места и нормализованного текста, первые 16 символов. */
export function fingerprint(input: { kind: IncidentKind; where: string; message: string }): string {
  const material = [input.kind, normalizeErrorText(input.where), normalizeErrorText(input.message)].join('\n')
  return createHash('sha256').update(material).digest('hex').slice(0, 16)
}

const STACK_FRAME = /^\s*at (?:(.+?) \()?(.+?):(\d+):(\d+)\)?\s*$/

/** Первая строка следа внутри кода приложения: `путь:строка:столбец функция`. */
export function whereFromStack(stack: string, appRoot: string = process.cwd()): string {
  for (const line of stack.split('\n')) {
    const frame = STACK_FRAME.exec(line)
    if (!frame) continue
    const [, functionName, rawPath = '', lineNumber, column] = frame
    const path = rawPath.startsWith('file://') ? decodeURIComponent(rawPath.slice('file://'.length)) : rawPath
    if (!isAbsolute(path) || path.includes(`${sep}node_modules${sep}`)) continue
    const insideApp = relative(appRoot, path)
    if (insideApp.startsWith('..') || isAbsolute(insideApp)) continue
    const place = `${insideApp.split(sep).join('/')}:${lineNumber}:${column}`
    return functionName ? `${place} ${functionName}` : place
  }
  return ''
}

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

/** Новый ULID: 48 бит времени и 80 бит случайности. */
export function newEventId(now: number = Date.now()): string {
  let time = ''
  let rest = now
  for (let index = 0; index < 10; index += 1) {
    time = CROCKFORD[rest % 32] + time
    rest = Math.floor(rest / 32)
  }
  const random = randomBytes(16)
  let tail = ''
  for (let index = 0; index < 16; index += 1) tail += CROCKFORD[(random[index] ?? 0) % 32]
  return time + tail
}

export function truncateText(text: string, limit: number): string {
  if (text.length <= limit) return text
  const marker = '…[обрезано]'
  let cut = limit - marker.length
  const code = text.charCodeAt(cut - 1)
  if (code >= 0xd800 && code <= 0xdbff) cut -= 1
  return text.slice(0, cut) + marker
}

const KNOWN_CONTEXT_KEYS = ['processName', 'release', 'chatId', 'model', 'provider', 'tool'] as const

function byteSize(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value))
}

function shortenValue(value: unknown): unknown {
  if (typeof value === 'string') return truncateText(value, INCIDENT_LIMITS.contextValue)
  if (value === null || typeof value !== 'object') return value
  const json = JSON.stringify(value)
  return json.length <= INCIDENT_LIMITS.contextValue ? value : truncateText(json, INCIDENT_LIMITS.contextValue)
}

/** Контекст не больше 4 КБ: известные поля в первую очередь, остальные — пока влезают. */
export function boundContext(context: IncidentContext): IncidentContext {
  if (byteSize(context) <= INCIDENT_LIMITS.contextBytes) return context
  const bounded: IncidentContext = {}
  const keys = [
    ...KNOWN_CONTEXT_KEYS.filter((key) => key in context),
    ...Object.keys(context).filter((key) => !(KNOWN_CONTEXT_KEYS as readonly string[]).includes(key)),
  ]
  for (const key of keys) {
    const candidate = { ...bounded, [key]: shortenValue(context[key]), truncated: true }
    if (byteSize(candidate) <= INCIDENT_LIMITS.contextBytes) bounded[key] = candidate[key]
  }
  bounded.truncated = true
  return bounded
}

/** Готовое событие: вычищено, обрезано по пределам, с отпечатком. */
export function createIncidentEvent(input: IncidentInput, options: CreateIncidentOptions = {}): IncidentEvent {
  const redactOptions = { knownSecrets: options.knownSecrets ?? [] }
  const clean = (text: string): string => {
    const builtIn = redactSecrets(text, redactOptions)
    return options.redact ? options.redact(builtIn) : builtIn
  }
  const where = truncateText(clean(input.where), 500)
  const message = truncateText(clean(input.message), INCIDENT_LIMITS.message)
  const context = boundContext(mapStrings(input.context ?? {}, clean))
  const event: IncidentEvent = {
    eventId: input.eventId ?? newEventId(input.occurredAt?.getTime()),
    appName: input.appName,
    kind: input.kind,
    fingerprint: fingerprint({ kind: input.kind, where, message }),
    where,
    message,
    stack: truncateText(clean(input.stack ?? ''), INCIDENT_LIMITS.stack),
    context,
    occurredAt: (input.occurredAt ?? new Date()).toISOString(),
  }
  if (input.badAnswer) {
    event.badAnswer = {
      ...input.badAnswer,
      excerpt: truncateText(clean(input.badAnswer.excerpt), INCIDENT_LIMITS.badAnswerExcerpt),
      explanation: truncateText(clean(input.badAnswer.explanation), INCIDENT_LIMITS.badAnswerExplanation),
      confidence: Math.min(1, Math.max(0, input.badAnswer.confidence)),
    }
  }
  return event
}

function mapStrings<T>(value: T, map: (text: string) => string): T {
  if (typeof value === 'string') return map(value) as T
  if (Array.isArray(value)) return value.map((item) => mapStrings(item, map)) as T
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, mapStrings(item, map)])) as T
  }
  return value
}
