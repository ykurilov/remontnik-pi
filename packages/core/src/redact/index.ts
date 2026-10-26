// Вычистка секретов и личных данных из текста ошибок, следов и отчётов.
// Порядок правил важен: сначала длинные и точные (закрытые ключи, токены), потом общие (почты, телефоны).

export interface RedactOptions {
  /** Точные значения, которые надо вырезать всегда: ключи и токены, известные вызывающему. */
  knownSecrets?: readonly string[]
}

type RedactionRule = readonly [pattern: RegExp, replacement: string | ((match: string, ...groups: string[]) => string)]

const PHONE_CANDIDATE = /(?<![\w.:/-])\+?\d[\d ().-]{8,}\d(?![\w.:/-]?\d)/g

const RULES: readonly RedactionRule[] = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[закрытый ключ]'],
  [/(?:(?<=bot)|\b)\d{8,10}:[A-Za-z0-9_-]{30,}/g, '[токен]'],
  [/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}|\bgithub_pat_[A-Za-z0-9_]{30,}/g, '[токен]'],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, '[токен]'],
  [/\bAKIA[0-9A-Z]{16}\b/g, '[ключ]'],
  [/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}/g, '[ключ]'],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}/g, '[токен]'],
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, (_match, scheme) => `${scheme} [токен]`],
  [
    /\b((?:api[_-]?key|apikey|access[_-]?token|auth[_-]?token|token|secret|password|passwd|pwd)["']?\s*[:=]\s*["']?)[^\s"'&,;]{4,}/gi,
    (_match, prefix) => `${prefix}[секрет]`,
  ],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[почта]'],
]

function looksLikePhone(candidate: string): boolean {
  const digits = candidate.replace(/\D/g, '')
  if (digits.length < 10 || digits.length > 15) return false
  if (/^\d{4}-\d{2}-\d{2}/.test(candidate)) return false
  const hasSeparators = /[ ().-]/.test(candidate)
  if (candidate.startsWith('+')) return true
  if (hasSeparators) return /^[\d ()-]+$/.test(candidate) && /[()]|\d \d|\d-\d{2,4}-\d/.test(candidate)
  return digits.length === 11 && /^[78]/.test(digits)
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Вырезает из текста ключи, токены, пароли, почты и телефоны. */
export function redactSecrets(text: string, options: RedactOptions = {}): string {
  let result = text
  for (const secret of options.knownSecrets ?? []) {
    if (secret.length >= 4) result = result.replace(new RegExp(escapeRegExp(secret), 'g'), '[секрет]')
  }
  for (const [pattern, replacement] of RULES) {
    result = result.replace(pattern, replacement as string)
  }
  return result.replace(PHONE_CANDIDATE, (candidate) => (looksLikePhone(candidate) ? '[телефон]' : candidate))
}

/** Вычищает все строки внутри значения (объекты, массивы); исходное значение не меняется. */
export function redactValue<T>(value: T, options: RedactOptions = {}): T {
  if (typeof value === 'string') return redactSecrets(value, options) as T
  if (Array.isArray(value)) return value.map((item) => redactValue(item, options)) as T
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, redactValue(item, options)]),
    ) as T
  }
  return value
}
