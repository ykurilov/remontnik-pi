import { posix } from 'node:path'

// Маски путей вида glob: `**` — любая глубина, `*` и `?` — внутри одной папки, `[..]`, `{a,b}`.
// Маска считается от корня репозитория, регистр не важен, точки в именах — обычные символы.

const compiled = new Map<string, RegExp>()

/** Путь от корня репозитория: с `/`, без `./`, `..` внутри пути схлопнуты (иначе маску можно обойти). */
export function normalizeRepoPath(path: string): string {
  return posix.normalize(path.replaceAll('\\', '/'))
}

function globToRegExp(mask: string): RegExp {
  let source = ''
  let braceDepth = 0
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
      if (end === -1) {
        source += '\\['
      } else {
        const body = mask.slice(index + 1, end).replace(/^!/, '^')
        source += `[${body.replaceAll('\\', '\\\\')}]`
        index = end
      }
    } else if (char === '{') {
      braceDepth += 1
      source += '(?:'
    } else if (char === '}' && braceDepth > 0) {
      braceDepth -= 1
      source += ')'
    } else if (char === ',' && braceDepth > 0) {
      source += '|'
    } else {
      source += char.replace(/[.+^$()|\\/]/g, '\\$&')
    }
  }
  source += ')'.repeat(braceDepth)
  return new RegExp(`^${source}$`, 'is')
}

export function matchesMask(mask: string, path: string): boolean {
  let pattern = compiled.get(mask)
  if (!pattern) {
    pattern = globToRegExp(mask)
    compiled.set(mask, pattern)
  }
  return pattern.test(normalizeRepoPath(path))
}

/** Первая подошедшая маска или `undefined`. */
export function firstMatchingMask(masks: readonly string[], path: string): string | undefined {
  return masks.find((mask) => matchesMask(mask, path))
}

export function matchesAnyMask(masks: readonly string[], path: string): boolean {
  return firstMatchingMask(masks, path) !== undefined
}
