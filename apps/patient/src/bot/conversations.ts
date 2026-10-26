// Разговоры «Пациента»: реплики копятся по номеру разговора, а когда разговор закрыт (пользователь ушёл
// или молчит слишком долго), законченный разговор уходит получателю — в приложении это сторож Ремонтника.

export interface ConversationMessage {
  role: 'user' | 'assistant'
  content: string
}

export interface FinishedConversation {
  id: string
  messages: ConversationMessage[]
}

export interface ConversationLogOptions {
  onFinished(conversation: FinishedConversation): void
  /** Через сколько молчания разговор считается законченным; по умолчанию 30 минут. */
  idleAfterMs?: number
  /** Сколько последних сообщений хранить в разговоре; по умолчанию 100. */
  maxMessages?: number
  /** Сколько разговоров держать открытыми; дальше самый старый закрывается. */
  maxOpen?: number
  now?: () => number
}

export interface ConversationLog {
  record(conversationId: string, userMessage: string, botReply: string): void
  /** Закрывает разговор. `false` — такого разговора нет. */
  finish(conversationId: string): boolean
  /** Закрывает разговоры, которые молчат дольше срока. */
  finishIdle(): void
}

interface OpenConversation {
  messages: ConversationMessage[]
  lastAt: number
}

export function createConversationLog(options: ConversationLogOptions): ConversationLog {
  const now = options.now ?? Date.now
  const idleAfterMs = options.idleAfterMs ?? 30 * 60_000
  const maxMessages = options.maxMessages ?? 100
  const maxOpen = options.maxOpen ?? 500
  // Map помнит порядок вставки: первым идёт самый давний по обновлению (обновлённый переставляется в конец).
  const open = new Map<string, OpenConversation>()

  function close(id: string): boolean {
    const conversation = open.get(id)
    if (!conversation) return false
    open.delete(id)
    try {
      options.onFinished({ id, messages: conversation.messages })
    } catch {
      // Получатель недоступен — чат это не касается.
    }
    return true
  }

  return {
    record(id, userMessage, botReply) {
      const conversation = open.get(id) ?? { messages: [], lastAt: 0 }
      open.delete(id)
      conversation.messages.push({ role: 'user', content: userMessage }, { role: 'assistant', content: botReply })
      if (conversation.messages.length > maxMessages) conversation.messages.splice(0, conversation.messages.length - maxMessages)
      conversation.lastAt = now()
      open.set(id, conversation)
      while (open.size > maxOpen) close(open.keys().next().value as string)
    },
    finish: close,
    finishIdle() {
      const edge = now() - idleAfterMs
      for (const [id, conversation] of [...open]) if (conversation.lastAt <= edge) close(id)
    },
  }
}
