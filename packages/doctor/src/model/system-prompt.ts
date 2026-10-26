import { matchesAnyMask } from '../path-mask/index.js'

// Системный промпт врача (R3: кэш модели). Для одной основы (коммит, настройка) он побайтно один и тот же:
// в нём нет ни времени, ни номера случая, ни сведений о сбое. Всё, что меняется от случая к случаю,
// идёт в конец — в сообщение пользователя (см. case-messages.ts).

export const SYSTEM_PROMPT_SECTIONS = ['## Роль', '## Правила работы', '## Приложение', '## Карта репозитория'] as const

export interface SystemPromptInput {
  appName: string
  /** Короткое описание приложения от его автора, если есть. */
  appDescription?: string
  /** Готовая карта: `buildRepoMap()`. */
  repoMap: string
  closedPaths: readonly string[]
  bashTimeoutSeconds: number
  /** Основа копии: работающая версия (`current`) или основная ветка, когда работающая неизвестна. */
  base: 'running' | 'main'
}

const DEFAULT_MAP_ENTRIES = 400

/** Список файлов основы без закрытых путей, по алфавиту. Длинный список обрезается с пометкой. */
export function buildRepoMap(files: readonly string[], options: { closedPaths: readonly string[]; maxEntries?: number }): string {
  const maxEntries = options.maxEntries ?? DEFAULT_MAP_ENTRIES
  const visible = [...new Set(files)].filter((file) => !matchesAnyMask(options.closedPaths, file)).sort()
  if (visible.length <= maxEntries) return visible.join('\n')
  return [...visible.slice(0, maxEntries), `… ещё ${visible.length - maxEntries} файлов`].join('\n')
}

export function buildSystemPrompt(input: SystemPromptInput): string {
  const closed =
    input.closedPaths.length === 0
      ? 'Закрытых путей нет.'
      : `Часть путей закрыта и в копии отсутствует: ${[...input.closedPaths].sort().join(', ')}. Не ищи их и не восстанавливай.`
  return [
    SYSTEM_PROMPT_SECTIONS[0],
    'Ты — врач приложения. В рабочем приложении случился сбой. Твоя задача — найти причину по коду и, если причина найдена, исправить её небольшой правкой с тестом, который ловит этот сбой.',
    '',
    SYSTEM_PROMPT_SECTIONS[1],
    `- Ты работаешь в отдельной копии репозитория, ${input.base === 'running' ? 'на коммите рабочей версии' : 'на последнем коммите основной ветки: какая версия работает, неизвестно, она может быть старше'}. Инструменты: read, write, edit, bash. У каждой команды bash есть предел времени, по умолчанию ${input.bashTimeoutSeconds} с; не запускай серверы и процессы, которые не завершаются сами.`,
    '- Ответ «Tool bash was interrupted» значит, что врач перезапускался посреди команды и она могла выполниться частично. Проверь, что она успела изменить, и продолжай с этого места.',
    '- git тебе не нужен: коммит, ветку и отправку делает врач после твоего finish_fix.',
    `- ${closed}`,
    '- Сначала диагноз: найди причину и заверши этап вызовом finish_diagnosis. Если причина не найдена — так и скажи, с низкой уверенностью; не выдумывай.',
    '- Потом правка, если о ней попросят: исправь причину, а не признак. Не убирай работающее поведение ради того, чтобы ошибка исчезла: поведение приложения проверят отдельно.',
    '- Добавь новым файлом тест, который падает без правки и проходит с ней. Существующие тесты и сценарии eval не меняй: ими врач проверяет правку, и такую правку не примут. Прогони тесты и проверку типов, затем заверши этап вызовом finish_fix.',
    '- Не меняй зависимости, сборку и выкатку, оплату, доступы, схему базы и настройку Ремонтника: такую правку не примут.',
    '',
    SYSTEM_PROMPT_SECTIONS[2],
    `Имя: ${input.appName}`,
    ...(input.appDescription ? [input.appDescription.trim()] : []),
    '',
    SYSTEM_PROMPT_SECTIONS[3],
    input.repoMap,
  ].join('\n')
}
