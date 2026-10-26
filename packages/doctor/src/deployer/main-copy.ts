import { createHash } from 'node:crypto'
import { readdir, readFile, stat } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'
import type { RemontnikConfig } from '@ykurilov/remontnik-core/config'
import type { GitGuard } from '../git-guard/index.js'

// Рабочая копия основной ветки на сервере (contracts/deploy-commands.md): из неё идут `promote`, `rollback`,
// `current` и `health`. Код правки сюда не попадает: `build` собирает его только в контейнере. Если копия всё же
// изменилась (сборка без контейнера, чужая рука), команды выкатки уже не те, что проверял владелец. Поэтому врач
// снимает её отпечаток в начале выкатки и сверяет перед каждой из этих команд.

export interface MainCopySnapshot {
  commit: string
  /** Изменённые и новые файлы по `git status`, кроме файла замка. */
  dirty: string[]
  /** Отпечатки `remontnik.config.*` и скриптов из команд выкатки, в том числе не попавших в git: путь → sha256. */
  files: Record<string, string>
}

export interface MainCopy {
  snapshot(): Promise<MainCopySnapshot>
}

const CONFIG_FILE = /^remontnik\.config\./
const LISTED_LIMIT = 10

const listed = (paths: readonly string[]) => `${paths.slice(0, LISTED_LIMIT).join(', ')}${paths.length > LISTED_LIMIT ? ` и ещё ${paths.length - LISTED_LIMIT}` : ''}`

/** Чем `actual` отличается от `expected`: коммит, новые изменённые файлы, настройка и скрипты; `undefined` — ничем. */
export function mainCopyChange(expected: MainCopySnapshot, actual: MainCopySnapshot): string | undefined {
  const changes: string[] = []
  if (actual.commit !== expected.commit) changes.push(`коммит ${expected.commit.slice(0, 12)} сменился на ${actual.commit.slice(0, 12)}`)
  const known = new Set(expected.dirty)
  const dirty = actual.dirty.filter((path) => !known.has(path))
  if (dirty.length > 0) changes.push(`изменены файлы: ${listed(dirty)}`)
  const paths = [...new Set([...Object.keys(expected.files), ...Object.keys(actual.files)])].sort()
  const touched = paths.filter((path) => expected.files[path] !== actual.files[path])
  if (touched.length > 0) changes.push(`изменены настройка или скрипты выкатки: ${listed(touched)}`)
  return changes.length > 0 ? `рабочая копия основной ветки изменена: ${changes.join('; ')}` : undefined
}

/** Слова команд, похожие на файлы внутри копии: `sh ./scripts/deploy.sh promote` → `scripts/deploy.sh`. */
function scriptCandidates(repoDir: string, commands: Record<string, string>): string[] {
  const found = new Set<string>()
  for (const command of Object.values(commands)) {
    for (const word of command.split(/[\s;&|()<>`]+/)) {
      const token = word.replace(/^['"]+|['"]+$/g, '')
      if (token === '' || token.includes('$') || token.startsWith('-')) continue
      const path = relative(repoDir, resolve(repoDir, token))
      if (path !== '' && !path.startsWith('..') && !isAbsolute(path)) found.add(path)
    }
  }
  return [...found]
}

async function fingerprint(path: string): Promise<string | undefined> {
  try {
    if (!(await stat(path)).isFile()) return undefined
    return createHash('sha256').update(await readFile(path)).digest('hex')
  } catch {
    return undefined
  }
}

export function createMainCopy(options: { guard: GitGuard; deploy: RemontnikConfig['deploy'] }): MainCopy {
  const { guard, deploy } = options
  const repoDir = guard.repoDir
  const lockFile = relative(repoDir, resolve(repoDir, deploy.lockFile))
  /** Замок и его временные файлы появляются в копии по ходу выкатки: это не правка. */
  const isLock = (path: string) => path === lockFile || path.startsWith(`${lockFile}.`)

  return {
    async snapshot() {
      const commit = (await guard.run(['rev-parse', '--verify', 'HEAD^{commit}'])).trim()
      const entries = (await guard.run(['status', '--porcelain=v1', '-z', '--untracked-files=all'])).split('\0')
      const dirty: string[] = []
      for (let index = 0; index < entries.length; index += 1) {
        const entry = entries[index]!
        if (entry.length < 4) continue
        const path = entry.slice(3)
        // Переименование: следом идёт прежнее имя.
        if (entry[0] === 'R' || entry[0] === 'C') index += 1
        if (!isLock(path)) dirty.push(path)
      }
      const files: Record<string, string> = {}
      const configs = (await readdir(repoDir)).filter((name) => CONFIG_FILE.test(name))
      for (const path of [...configs, ...scriptCandidates(repoDir, deploy.commands)]) {
        const hash = await fingerprint(resolve(repoDir, path))
        if (hash !== undefined) files[path] = hash
      }
      return { commit, dirty: dirty.sort(), files }
    },
  }
}
