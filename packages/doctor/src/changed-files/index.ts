import { matchesAnyMask } from '../path-mask/index.js'

/** Один изменённый файл правки врача: то, что даёт `git diff` относительно основной ветки. */
export interface ChangedFile {
  /** Путь от корня репозитория, с `/`. */
  path: string
  /** Прежний путь, если файл переименован. */
  previousPath?: string
  status: 'added' | 'modified' | 'deleted' | 'renamed'
  added: number
  removed: number
  /** Дифф файла в формате unified. Нет у двоичных файлов. */
  patch?: string
  /** Режим файла в git после правки (`100644`, `100755`, `120000` — ссылка, `160000` — подмодуль). */
  mode?: string
  /** Режим файла в git до правки. */
  previousMode?: string
  /** Полный текст до и после правки. Нужен только для `package.json`, когда приложение разрешило менять зависимости. */
  contentBefore?: string
  contentAfter?: string
}

export interface ChangedLines {
  added: string[]
  removed: string[]
}

/** Добавленные и убранные строки из диффа. Заголовок файла (до первого `@@`) и строки контекста не учитываются. */
export function changedLinesOf(patch: string): ChangedLines {
  const lines = patch.split('\n')
  const firstHunk = lines.findIndex((line) => line.startsWith('@@'))
  const changed: ChangedLines = { added: [], removed: [] }
  if (firstHunk === -1) return changed
  for (const line of lines.slice(firstHunk)) {
    if (line.startsWith('+')) changed.added.push(line.slice(1))
    else if (line.startsWith('-')) changed.removed.push(line.slice(1))
  }
  return changed
}

const DOCUMENTATION_MASKS = ['docs/**', '**/docs/**', '**/README*', '**/CHANGELOG*']

/** Документация, которую не исполняют: `docs/**`, `README*`, `CHANGELOG*`. Остальные `.md` (промпты и т. п.) документацией не считаются. */
export function isDocumentationPath(path: string): boolean {
  return matchesAnyMask(DOCUMENTATION_MASKS, path)
}
