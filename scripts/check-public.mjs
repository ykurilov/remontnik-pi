// Проверка открытости: в дереве репозитория не должно быть публичных IPv4,
// настоящих доменов и строк, похожих на ключи. Частный запретный список лежит
// вне репозитория: ~/.config/remontnik/denylist.txt (или путь из REMONTNIK_DENYLIST).
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const SKIPPED_DIRECTORIES = new Set(['node_modules', '.git', '.private', 'dist', 'coverage'])
const SKIPPED_FILES = new Set(['pnpm-lock.yaml'])
const BINARY_EXTENSIONS = /\.(png|jpe?g|gif|webp|ico|pdf|zip|gz|sqlite|db|woff2?|ttf)$/i

const SAFE_DOMAIN_SUFFIXES = ['example.com', 'example.org', 'example.net', 'test', 'invalid', 'localhost']
// Публичные сервисы, на которые ссылается документация. Расширять осторожно.
const KNOWN_PUBLIC_DOMAINS = [
  'github.com',
  'githubusercontent.com',
  'npmjs.com',
  'npmjs.org',
  'nodejs.org',
  'pnpm.io',
  'typescriptlang.org',
  'vitest.dev',
  'playwright.dev',
  'docker.com',
  'telegram.org',
  'openrouter.ai',
  'deepseek.com',
  'anthropic.com',
  'opensource.org',
  'keepachangelog.com',
  'conventionalcommits.org',
  'semver.org',
]
// Настоящие верхние зоны. Расширения файлов (.md, .sh, .ts, .json) сюда не входят.
const REAL_TOP_LEVEL_DOMAINS = [
  'com', 'org', 'net', 'io', 'ru', 'su', 'cloud', 'dev', 'app', 'ai', 'shop', 'info', 'biz',
  'xyz', 'online', 'site', 'tech', 'co', 'de', 'fr', 'uk', 'us', 'eu', 'ua', 'by', 'kz', 'club',
  'store',
]

const IPV4 = /(?<![\d.])(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?![\d]|\.\d)/g
const DOMAIN = new RegExp(
  `(?<![\\w@.-])((?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\\.)+(?:${REAL_TOP_LEVEL_DOMAINS.join('|')}))(?![\\w-])`,
  'gi',
)
const SECRET_PATTERNS = [
  ['ключ вида sk-', /\bsk-[A-Za-z0-9_-]{20,}/],
  ['токен бота Telegram', /\b\d{8,10}:[A-Za-z0-9_-]{30,}/],
  ['токен GitHub', /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}/],
  ['токен Slack', /\bxox[abprs]-[A-Za-z0-9-]{10,}/],
  ['ключ AWS', /\bAKIA[0-9A-Z]{16}\b/],
  ['заголовок Bearer с токеном', /\bBearer\s+[A-Za-z0-9._~+/-]{20,}/],
  ['закрытый ключ', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
]

function isPrivateOrReservedIp([a, b, c]) {
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 192 && b === 0 && c === 2) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224
  )
}

function isSafeDomain(domain) {
  const lower = domain.toLowerCase()
  return [...SAFE_DOMAIN_SUFFIXES, ...KNOWN_PUBLIC_DOMAINS].some(
    (suffix) => lower === suffix || lower.endsWith(`.${suffix}`),
  )
}

function listFiles(directory, found = []) {
  for (const entry of readdirSync(directory)) {
    if (SKIPPED_DIRECTORIES.has(entry) || SKIPPED_FILES.has(entry)) continue
    const full = join(directory, entry)
    if (statSync(full).isDirectory()) listFiles(full, found)
    else if (!BINARY_EXTENSIONS.test(entry)) found.push(full)
  }
  return found
}

function readDenylist(path) {
  if (!path || !existsSync(path)) return []
  return readFileSync(path, 'utf8')
    .split('\n')
    .map((line) => line.trim().toLowerCase())
    .filter((line) => line !== '' && !line.startsWith('#'))
}

export function defaultDenylistPath() {
  return process.env.REMONTNIK_DENYLIST ?? join(homedir(), '.config', 'remontnik', 'denylist.txt')
}

export function checkPublic(rootDirectory, { denylistPath = defaultDenylistPath() } = {}) {
  const problems = []
  const denylist = readDenylist(denylistPath)

  for (const file of listFiles(rootDirectory)) {
    const text = readFileSync(file, 'utf8')
    if (text.includes('\0')) continue
    const name = relative(rootDirectory, file)

    text.split('\n').forEach((line, index) => {
      const place = `${name}:${index + 1}`

      for (const match of line.matchAll(IPV4)) {
        const parts = match.slice(1, 5).map(Number)
        if (parts.every((part) => part <= 255) && !isPrivateOrReservedIp(parts)) {
          problems.push(`${place}: публичный IPv4-адрес`)
        }
      }
      for (const match of line.matchAll(DOMAIN)) {
        if (!isSafeDomain(match[1])) problems.push(`${place}: домен вне example.com/.test/.invalid`)
      }
      for (const [label, pattern] of SECRET_PATTERNS) {
        if (pattern.test(line)) problems.push(`${place}: ${label}`)
      }
      const lower = line.toLowerCase()
      if (denylist.some((word) => lower.includes(word))) {
        problems.push(`${place}: слово из частного запретного списка`)
      }
    })
  }

  return problems
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const problems = checkPublic(process.cwd())
  if (problems.length > 0) {
    console.error(problems.join('\n'))
    process.exit(1)
  }
  console.log('check-public: секретов, настоящих адресов и доменов не найдено')
}
