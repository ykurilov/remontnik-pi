import { randomBytes } from 'node:crypto'

// Разговоры «Пациента»: реплики копятся у владельца (посетителя чата), а когда разговор закрыт (посетитель ушёл
// или молчит слишком долго), законченный разговор уходит получателю — в приложении это сторож Ремонтника.
// Номер разговора выдаёт сервер, а не посетитель; закрыть можно только свой разговор.
// Память ограничена: длина реплики, длина разговора, число открытых разговоров и их общий объём.

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
  /** Сколько символов хранить в одной реплике; остальное отрезается. По умолчанию 4000. */
  maxMessageChars?: number
  /** Сколько символов хранить в одном разговоре; старые реплики уходят первыми. По умолчанию 40 000. */
  maxConversationChars?: number
  /** Сколько разговоров держать открытыми; дальше самый старый закрывается. */
  maxOpen?: number
  /** Сколько символов держать во всех открытых разговорах; дальше самый старый закрывается. По умолчанию 8 000 000. */
  maxOpenChars?: number
  now?: () => number
}

export interface ConversationLog {
  /** Добавляет реплики в открытый разговор владельца (или открывает новый) и возвращает номер разговора. */
  record(owner: string, userMessage: string, botReply: string): string
  /** Закрывает открытый разговор владельца. `false` — у него нет открытого разговора. */
  finish(owner: string): boolean
  /** Закрывает разговоры, которые молчат дольше срока. */
  finishIdle(): void
}

interface OpenConversation {
  id: string
  messages: ConversationMessage[]
  chars: number
  lastAt: number
}

export function createConversationLog(options: ConversationLogOptions): ConversationLog {
  const now = options.now ?? Date.now
  const idleAfterMs = options.idleAfterMs ?? 30 * 60_000
  const maxMessages = options.maxMessages ?? 100
  const maxMessageChars = options.maxMessageChars ?? 4_000
  const maxConversationChars = options.maxConversationChars ?? 40_000
  const maxOpen = options.maxOpen ?? 500
  const maxOpenChars = options.maxOpenChars ?? 8_000_000
  // Map помнит порядок вставки: первым идёт самый давний по обновлению (обновлённый переставляется в конец).
  const open = new Map<string, OpenConversation>()
  let openChars = 0

  function close(owner: string): boolean {
    const conversation = open.get(owner)
    if (!conversation) return false
    open.delete(owner)
    openChars -= conversation.chars
    try {
      options.onFinished({ id: conversation.id, messages: conversation.messages })
    } catch {
      // Получатель недоступен — чат это не касается.
    }
    return true
  }

  function drop(conversation: OpenConversation, count: number): void {
    for (const removed of conversation.messages.splice(0, count)) {
      conversation.chars -= removed.content.length
      openChars -= removed.content.length
    }
  }

  return {
    record(owner, userMessage, botReply) {
      const conversation = open.get(owner) ?? { id: randomBytes(12).toString('hex'), messages: [], chars: 0, lastAt: 0 }
      open.delete(owner)
      for (const message of [
        { role: 'user' as const, content: userMessage.slice(0, maxMessageChars) },
        { role: 'assistant' as const, content: botReply.slice(0, maxMessageChars) },
      ]) {
        conversation.messages.push(message)
        conversation.chars += message.content.length
        openChars += message.content.length
      }
      if (conversation.messages.length > maxMessages) drop(conversation, conversation.messages.length - maxMessages)
      while (conversation.chars > maxConversationChars && conversation.messages.length > 2) drop(conversation, 2)
      conversation.lastAt = now()
      open.set(owner, conversation)
      // Самый давний закрывается; только что обновлённый разговор (последний в Map) не вытесняет сам себя.
      while (open.size > 1 && (open.size > maxOpen || openChars > maxOpenChars)) close(open.keys().next().value as string)
      return conversation.id
    },
    finish: close,
    finishIdle() {
      const edge = now() - idleAfterMs
      for (const [owner, conversation] of [...open]) if (conversation.lastAt <= edge) close(owner)
    },
  }
}
