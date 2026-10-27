// Последний замок: из любого ответа и журнала службы вырезаются значения всех сохранённых паролей,
// в том числе в видах, в которых они попадают в адреса, формы, HTML и JSON.
// От преобразований самой страницей (переворот, часть пароля, своё шифрование) фильтр не защищает.

export interface OutputFilter {
  text(text: string): string
  value<T>(value: T): T
}

const PLACEHOLDER = '[пароль скрыт]'

const escapeHtml = (text: string, entities: Record<string, string>) => text.replace(/[&<>"']/g, (char) => entities[char] ?? char)
const NAMED = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }
const NAMED_WITH_QUOTE = { ...NAMED, "'": '&#39;' }
const DECIMAL = { '&': '&#38;', '<': '&#60;', '>': '&#62;', '"': '&#34;', "'": '&#39;' }
const HEXADECIMAL = { '&': '&#x26;', '<': '&#x3c;', '>': '&#x3e;', '"': '&#x22;', "'": '&#x27;' }

/** Виды, где регистр важен: сам пароль, JSON, HTML, base64. */
function exactVariants(password: string): string[] {
  const bytes = Buffer.from(password)
  const json = JSON.stringify(password).slice(1, -1)
  return [
    password,
    password.replace(/\s+/g, ' ').trim(),
    json,
    JSON.stringify(json).slice(1, -1),
    escapeHtml(password, NAMED),
    escapeHtml(password, NAMED_WITH_QUOTE),
    escapeHtml(password, DECIMAL),
    new URLSearchParams({ p: password }).toString().slice(2),
    bytes.toString('base64'),
    bytes.toString('base64').replace(/=+$/, ''),
    bytes.toString('base64url'),
  ]
}

const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567'

function base32(bytes: Buffer): string {
  let bits = 0
  let value = 0
  let output = ''
  for (const byte of bytes) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      output += BASE32[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  return bits > 0 ? output + BASE32[(value << (5 - bits)) & 31] : output
}

/**
 * Виды, где регистр букв не важен: %xx-кодирование и hex. И виды из имени хоста: браузер переводит его в строчные
 * буквы, поэтому base64 там сравнивается без регистра, а base32 — обычная запись в DNS.
 */
function caseFreeVariants(password: string): string[] {
  const bytes = Buffer.from(password)
  return [
    encodeURIComponent(password),
    [...bytes].map((byte) => `%${byte.toString(16).padStart(2, '0')}`).join(''),
    bytes.toString('hex'),
    escapeHtml(password, HEXADECIMAL),
    bytes.toString('base64url'),
    base32(bytes),
  ]
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

function alternation(variants: Iterable<string>, flags: string): RegExp | null {
  // Длинные варианты первыми: короткий не должен разрезать длинный.
  const unique = [...new Set(variants)].filter((variant) => variant !== '').sort((a, b) => b.length - a.length)
  return unique.length === 0 ? null : new RegExp(unique.map(escapeRegExp).join('|'), flags)
}

export function createOutputFilter(knownPasswords: () => readonly string[]): OutputFilter {
  let compiledFor: readonly string[] | null = null
  let patterns: RegExp[] = []

  function patternsFor(passwords: readonly string[]): RegExp[] {
    if (passwords !== compiledFor) {
      compiledFor = passwords
      patterns = [alternation(passwords.flatMap(exactVariants), 'g'), alternation(passwords.flatMap(caseFreeVariants), 'gi')].filter(
        (pattern): pattern is RegExp => pattern !== null,
      )
    }
    return patterns
  }

  function text(input: string): string {
    return patternsFor(knownPasswords()).reduce((result, pattern) => result.replace(pattern, PLACEHOLDER), input)
  }

  function value<T>(input: T): T {
    if (typeof input === 'string') return text(input) as T
    if (Array.isArray(input)) return input.map((item) => value(item)) as T
    if (input !== null && typeof input === 'object') {
      return Object.fromEntries(Object.entries(input).map(([key, item]) => [key, value(item)])) as T
    }
    return input
  }

  return { text, value }
}
