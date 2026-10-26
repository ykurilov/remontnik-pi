import type { IncidentContext } from '@ykurilov/remontnik-core/incident'
import type { Watch } from '../capture/index.js'

// Хуки для Agent Chat SDK: сбои ходов, моделей и инструментов становятся случаями сторожа.
// Пакет SDK сторож не тянет: типы ниже — та часть его хуков, которую сторож читает.

export interface AgentChatMessagePart {
  type: string
  state?: string
  toolName?: string
  errorText?: string
  [key: string]: unknown
}

export interface AgentChatTurnResult {
  ownerId: string
  chatId: string
  messageId: string
  status: 'complete' | 'stopped' | 'error' | 'interrupted' | 'awaiting_approval'
  stopReason?: string
  text?: string
  parts: readonly AgentChatMessagePart[]
  error?: {
    kind: string
    details?: { providerId?: string; modelId?: string; statusCode?: number; reason?: string }
  }
  recovered: boolean
}

export interface AgentChatTurnNotStarted {
  reason: string
  chat?: { id: string } | null
  [key: string]: unknown
}

/** Хуки приложения, если они уже есть: сторож вызывает их и отдаёт их результат без изменений. */
export interface AgentChatInnerHooks<AfterTurnResult = unknown, NotStartedResult = unknown> {
  logError?(message: string): void
  afterTurn?(result: AgentChatTurnResult): AfterTurnResult | Promise<AfterTurnResult>
  turnNotStarted?(input: AgentChatTurnNotStarted): NotStartedResult
}

export interface AgentChatWatchHooks<AfterTurnResult = unknown, NotStartedResult = unknown> {
  logError(message: string): void
  afterTurn(result: AgentChatTurnResult): Promise<AfterTurnResult | undefined>
  turnNotStarted(input: AgentChatTurnNotStarted): NotStartedResult | undefined
}

const OWN_LINE = '[remontnik]'
const PROVIDER_LINE = /провайдер|поставщик|provider|модел|model/i

export function agentChatWatchHooks<AfterTurnResult = unknown, NotStartedResult = unknown>(
  watch: Pick<Watch, 'capture'>,
  options: { inner?: AgentChatInnerHooks<AfterTurnResult, NotStartedResult> } = {},
): AgentChatWatchHooks<AfterTurnResult, NotStartedResult> {
  const { inner } = options

  // Наблюдение не должно мешать ходу: сбой сторожа — строка в журнал, и всё.
  const safely = (record: () => void) => {
    try {
      record()
    } catch (error) {
      try {
        console.error(`${OWN_LINE} сбой не записан: ${error instanceof Error ? error.message : String(error)}`)
      } catch {
        // Журнал недоступен.
      }
    }
  }

  const turnContext = (result: AgentChatTurnResult): IncidentContext => {
    const context: IncidentContext = { chatId: result.chatId }
    const details = result.error?.details
    if (details?.modelId) context.model = details.modelId
    if (details?.providerId) context.provider = details.providerId
    return context
  }

  const toolName = (part: AgentChatMessagePart): string | null => {
    if (part.type === 'dynamic-tool') return part.toolName ?? 'dynamic-tool'
    if (part.type.startsWith('tool-')) return part.type.slice('tool-'.length)
    return null
  }

  return {
    logError(message) {
      if (!message.startsWith(OWN_LINE)) {
        safely(() =>
          watch.capture(new Error(message), {
            kind: PROVIDER_LINE.test(message) ? 'model_error' : 'turn_failed',
            where: 'agent-chat',
          }),
        )
      }
      if (inner?.logError) inner.logError(message)
      else console.error(message)
    },

    async afterTurn(result) {
      safely(() => {
        if (result.status === 'error') {
          const details = result.error?.details
          const reason = [details?.statusCode, details?.reason].filter((item) => item !== undefined).join(' ')
          const message = `ход сорвался: ${result.error?.kind ?? 'неизвестная ошибка'}${reason ? ` (${reason})` : ''}`
          watch.capture(new Error(message), { kind: 'turn_failed', where: 'agent-chat:turn', context: turnContext(result) })
        }
        for (const part of result.parts) {
          const tool = part.state === 'output-error' ? toolName(part) : null
          if (!tool) continue
          watch.capture(new Error(part.errorText ?? 'ошибка инструмента'), {
            kind: 'tool_error',
            where: tool,
            context: { chatId: result.chatId, tool },
          })
        }
      })
      return inner?.afterTurn ? await inner.afterTurn(result) : undefined
    },

    turnNotStarted(input) {
      if (input.reason === 'error') {
        safely(() =>
          watch.capture(new Error('ход не начался из-за сбоя'), {
            kind: 'turn_failed',
            where: 'agent-chat:turn-not-started',
            context: input.chat?.id ? { chatId: input.chat.id } : {},
          }),
        )
      }
      return inner?.turnNotStarted ? inner.turnNotStarted(input) : undefined
    },
  }
}
