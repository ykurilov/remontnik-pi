import type { GitGuard } from '../git-guard/index.js'

// Файлы настройки (R7): сама `remontnik.config.*` и всё, что она подключает из репозитория, с вложенными.
// Список строится по тексту файлов, без их выполнения, поэтому его можно получить на любой ревизии: и на основе,
// и на правке врача. Свои файлы подключаются только строкой в кавычках по относительному пути.
// Лишнее в списке (строка, похожая на импорт, в комментарии) безвредно: такой файл просто защищён от правки.
// Пропустить файл список не может: врач выполняет настройку в копии, где лежат только файлы из списка,
// и отказывает любому импорту вне его (`service/config-source.ts`).

export const CONFIG_FILE_NAMES = ['remontnik.config.ts', 'remontnik.config.mts', 'remontnik.config.js', 'remontnik.config.mjs', 'remontnik.config.json']

/** Сколько файлов может подключить настройка: больше — уже не данные, а приложение. */
const MAX_CONFIG_FILES = 200
const SPECIFIER = /(?:\bfrom|\bimport|\bimport\s*\(|\brequire\s*\()\s*(['"])([^'"\r\n]+)\1/g
const REPO_ROOT = 'file:///repo/'

export interface ConfigFiles {
  /** Пути от корня репозитория: файл настройки, подключённые им файлы и `package.json`, задающие их тип модулей. */
  files: string[]
  /** Импорты, которые врач не поддерживает (абсолютный путь, выход из репозитория). Пусто — всё в порядке. */
  problems: string[]
}

/** Путь от корня репозитория, куда ведёт относительный импорт; не свой файл (пакет, модуль Node) — `undefined`. */
function resolveOwnFile(from: string, specifier: string): { path: string } | { problem: string } | undefined {
  if (/^\.{1,2}\//.test(specifier)) {
    const url = new URL(specifier, REPO_ROOT + from)
    if (!url.href.startsWith(REPO_ROOT)) return { problem: `${from}: импорт ${specifier} ведёт за пределы репозитория` }
    return { path: decodeURIComponent(url.pathname.slice(new URL(REPO_ROOT).pathname.length)) }
  }
  if (specifier.startsWith('/') || /^file:/i.test(specifier)) {
    return { problem: `${from}: импорт ${specifier} — абсолютный путь; свои файлы подключайте по относительному пути` }
  }
  return undefined
}

function directoriesUp(path: string): string[] {
  const parts = path.split('/').slice(0, -1)
  return parts.map((_, index) => parts.slice(0, parts.length - index).join('/')).concat('')
}

/**
 * Файл настройки и всё, что он подключает. `read` отдаёт текст файла по пути от корня репозитория
 * или `undefined`, если файла нет. Несуществующий импорт пропускается: выполнение настройки его не найдёт само.
 */
export async function collectConfigFiles(entry: string, read: (path: string) => Promise<string | undefined>): Promise<ConfigFiles> {
  const files = new Set<string>()
  const problems: string[] = []
  const queue = [entry]
  const scopes = new Set<string>()
  while (queue.length > 0) {
    const path = queue.shift()!
    if (files.has(path)) continue
    const text = await read(path)
    if (text === undefined) continue
    files.add(path)
    if (files.size > MAX_CONFIG_FILES) {
      problems.push(`настройка подключает больше ${MAX_CONFIG_FILES} файлов`)
      break
    }
    // Тип модулей файла (`"type"` ближайшего `package.json`) меняет то, как выполняется настройка.
    for (const directory of directoriesUp(path)) {
      const manifest = directory === '' ? 'package.json' : `${directory}/package.json`
      if (scopes.has(manifest) || (await read(manifest)) !== undefined) {
        scopes.add(manifest)
        break
      }
    }
    if (path.endsWith('.json')) continue
    for (const match of text.matchAll(SPECIFIER)) {
      const target = resolveOwnFile(path, match[2]!)
      if (!target) continue
      if ('problem' in target) problems.push(target.problem)
      else queue.push(target.path)
    }
  }
  for (const manifest of scopes) files.add(manifest)
  return { files: [...files].sort(), problems: [...new Set(problems)] }
}

/** Файлы настройки на ревизии `revision` (по git, без рабочей копии). Нет файла настройки — пустой список. */
export async function configFilesAt(guard: Pick<GitGuard, 'listFiles' | 'run'>, revision: string): Promise<string[]> {
  const tracked = new Set(await guard.listFiles(revision))
  const read = async (path: string) => (tracked.has(path) ? guard.run(['show', `${revision}:${path}`]) : undefined)
  const found = new Set<string>()
  for (const name of CONFIG_FILE_NAMES.filter((candidate) => tracked.has(candidate))) {
    for (const file of (await collectConfigFiles(name, read)).files) found.add(file)
  }
  return [...found].sort()
}

/**
 * Файлы настройки и на основе правки, и на самой правке: файл, который настройка подключала до правки
 * или подключает после неё, правка менять не может.
 */
export async function configFilesOfFix(guard: Pick<GitGuard, 'listFiles' | 'run'>, base: string, head: string): Promise<string[]> {
  const [before, after] = await Promise.all([configFilesAt(guard, base), configFilesAt(guard, head)])
  return [...new Set([...before, ...after])].sort()
}
