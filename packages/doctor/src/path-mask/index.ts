import { posix } from 'node:path'

// Маски путей вида glob: `**` — любая глубина, `*` и `?` — внутри одной папки, `[..]`, `{a,b}`.
// Маска считается от корня репозитория, регистр не важен, точки в именах — обычные символы.
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
    else if (char === '}' && depth > 0) depth -= 1
  }
  if (depth !== 0) throw new PathMaskError(mask, 'не закрыта скобка "{"')
}

/** Бросает `PathMaskError`, если маску нельзя разобрать. */
export function assertValidMask(mask: string): void {
  assertSupported(normalizeMask(mask))
}

function globToRegExp(mask: string): RegExp {
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
  return new RegExp(`^${source}$`, 'is')
}

function compile(mask: string): RegExp {
  let pattern = compiled.get(mask)
  if (!pattern) {
    pattern = globToRegExp(mask)
    compiled.set(mask, pattern)
  }
  return pattern
}

/** Подходит ли путь под маску — сам или любая из его папок. */
export function matchesMask(mask: string, path: string): boolean {
  const pattern = compile(normalizeMask(mask))
  const segments = normalizeRepoPath(path).split('/')
  for (let length = segments.length; length > 0; length -= 1) {
    if (pattern.test(segments.slice(0, length).join('/'))) return true
  }
  return false
}

/** Первая подошедшая маска или `undefined`. */
export function firstMatchingMask(masks: readonly string[], path: string): string | undefined {
  return masks.find((mask) => matchesMask(mask, path))
}

export function matchesAnyMask(masks: readonly string[], path: string): boolean {
  return firstMatchingMask(masks, path) !== undefined
}
