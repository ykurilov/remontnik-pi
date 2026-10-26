import { posix } from 'node:path'

// Маски путей вида glob: `**` — любая глубина, `*` и `?` — внутри одной папки, `[..]`, `{a,b}`.
// Маска считается от корня репозитория, точки в именах — обычные символы. Для запретов регистр не важен
// (лишний запрет безопаснее); для белого списка (`matchesAllowMask`) важен, а путь с `\` не подходит вовсе:
// на Linux `SRC/` и `src\x.ts` — не то же самое, что `src/`.
// Маска, подошедшая к папке, охватывает и всё внутри неё: `migrations` закрывает `migrations/001.sql`.
// Расширенные шаблоны (`@(a|b)`, `!(a)`, `+(a)`, `?(a)`, `*(a)`) и отрицание (`!маска`) не поддерживаются:
// такая маска — ошибка настройки, а не тихое несовпадение.

export class PathMaskError extends Error {
  readonly mask: string

  constructor(mask: string, reason: string) {
    super(`Маска пути "${mask}" не поддерживается: ${reason}`)
    this.name = 'PathMaskError'
    this.mask = mask
  }
}

const compiled = new Map<string, RegExp>()

/** Путь от корня репозитория: с `/`, без `./`, `..` внутри пути схлопнуты (иначе маску можно обойти). */
export function normalizeRepoPath(path: string): string {
  return posix.normalize(path.replaceAll('\\', '/'))
}

function normalizeMask(mask: string): string {
  return mask.replaceAll('\\', '/').replace(/^(?:\.?\/)+/, '')
}

function assertSupported(mask: string): void {
  if (mask.startsWith('!')) throw new PathMaskError(mask, 'отрицание "!" в начале')
  if (/[@!+?*]\(/.test(mask)) throw new PathMaskError(mask, 'расширенные шаблоны вида @(a|b)')
  if (/\[(?![^\]]*\])/.test(mask)) throw new PathMaskError(mask, 'не закрыта скобка "["')
  let depth = 0
  for (const char of mask) {
    if (char === '{') depth += 1
    else if (char === '}') {
      if (depth === 0) throw new PathMaskError(mask, 'лишняя скобка "}"')
      depth -= 1
    }
  }
  if (depth !== 0) throw new PathMaskError(mask, 'не закрыта скобка "{"')
}

/** Бросает `PathMaskError`, если маску нельзя разобрать. */
export function assertValidMask(mask: string): void {
  compile(normalizeMask(mask), false)
}

function globToRegExp(mask: string, caseSensitive: boolean): RegExp {
  assertSupported(mask)
  let source = ''
  for (let index = 0; index < mask.length; index += 1) {
    const char = mask[index] as string
    if (char === '*') {
      if (mask[index + 1] === '*') {
        index += 1
        if (mask[index + 1] === '/') {
          index += 1
          source += '(?:.*/)?'
        } else {
          source += '.*'
        }
      } else {
        source += '[^/]*'
      }
    } else if (char === '?') {
      source += '[^/]'
    } else if (char === '[') {
      const end = mask.indexOf(']', index + 1)
      const body = mask.slice(index + 1, end).replace(/^!/, '^')
      source += `[${body.replaceAll('\\', '\\\\')}]`
      index = end
    } else if (char === '{') {
      source += '(?:'
    } else if (char === '}') {
      source += ')'
    } else if (char === ',' && /\{[^}]*$/.test(mask.slice(0, index))) {
      source += '|'
    } else {
      source += char.replace(/[.+^$()|\\/]/g, '\\$&')
    }
  }
  try {
    return new RegExp(`^${source}$`, caseSensitive ? 's' : 'is')
  } catch (error) {
    throw new PathMaskError(mask, error instanceof Error ? error.message : String(error))
  }
}

function compile(mask: string, caseSensitive: boolean): RegExp {
  const key = `${caseSensitive ? 'A' : 'a'}${mask}`
  let pattern = compiled.get(key)
  if (!pattern) {
    pattern = globToRegExp(mask, caseSensitive)
    compiled.set(key, pattern)
  }
  return pattern
}

function matchesNormalized(pattern: RegExp, path: string): boolean {
  const segments = normalizeRepoPath(path).split('/')
  for (let length = segments.length; length > 0; length -= 1) {
    if (pattern.test(segments.slice(0, length).join('/'))) return true
  }
  return false
}

/** Подходит ли путь под маску — сам или любая из его папок. */
export function matchesMask(mask: string, path: string): boolean {
  return matchesNormalized(compile(normalizeMask(mask), false), path)
}

/** Первая подошедшая маска или `undefined`. */
export function firstMatchingMask(masks: readonly string[], path: string): string | undefined {
  return masks.find((mask) => matchesMask(mask, path))
}

export function matchesAnyMask(masks: readonly string[], path: string): boolean {
  return firstMatchingMask(masks, path) !== undefined
}

/** Белый список: регистр важен, путь с `\\` не подходит ни под одну маску. */
export function matchesAllowMask(masks: readonly string[], path: string): boolean {
  if (path.includes('\\')) return false
  return masks.some((mask) => matchesNormalized(compile(normalizeMask(mask), true), path))
}
