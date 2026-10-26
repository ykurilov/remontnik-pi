// Почта агенту: письмо уходит, только когда агент свободен. Отправка занятому агенту прервала бы его ход.

/** `not_ready` — Paseo ещё не дал плагину доступ (не было ни одного хука). */
export type AgentState = 'idle' | 'running' | 'missing' | 'not_ready'

/** То, что мосту нужно от Paseo. Настоящая реализация — `paseoAgentsFromHooks`, в тестах — подставная. */
export interface PaseoAgentsPort {
  state(agentId: string): Promise<AgentState>
  send(agentId: string, text: string): Promise<void>
}

export type DeliveryOutcome = 'sent' | 'withdrawn' | 'agent_missing' | 'timeout'

interface Waiting {
  wake(): void
}

export class AgentPost {
  private readonly waiting = new Map<string, Set<Waiting>>()
  private disposed = false

  constructor(
    private readonly paseo: PaseoAgentsPort,
    private readonly options: { idlePollMs: number; deliveryTimeoutMs: number },
  ) {}

  state(agentId: string): Promise<AgentState> {
    return this.paseo.state(agentId)
  }

  /**
   * Ждёт, пока агент освободится, и отправляет. `stillWanted` проверяется прямо перед отправкой:
   * задачу могли отменить, пока агент был занят. Ошибка отправки пробрасывается.
   */
  async deliver(agentId: string, text: string, stillWanted: () => boolean = () => true): Promise<DeliveryOutcome> {
    const deadline = Date.now() + this.options.deliveryTimeoutMs
    for (;;) {
      if (this.disposed || !stillWanted()) return 'withdrawn'
      const state = await this.paseo.state(agentId)
      if (state === 'missing' || state === 'not_ready') return 'agent_missing'
      if (state === 'idle') {
        if (!stillWanted()) return 'withdrawn'
        await this.paseo.send(agentId, text)
        return 'sent'
      }
      if (Date.now() >= deadline) return 'timeout'
      await this.waitForIdle(agentId, Math.min(this.options.idlePollMs, deadline - Date.now()))
    }
  }

  /** Paseo сообщил, что агент закончил ход: разбудить ждущие письма. */
  agentMayBeIdle(agentId: string): void {
    for (const waiting of this.waiting.get(agentId) ?? []) waiting.wake()
  }

  dispose(): void {
    this.disposed = true
    for (const set of this.waiting.values()) for (const waiting of set) waiting.wake()
  }

  private waitForIdle(agentId: string, ms: number): Promise<void> {
    return new Promise((resolve) => {
      const set = this.waiting.get(agentId) ?? new Set<Waiting>()
      this.waiting.set(agentId, set)
      const entry: Waiting = {
        wake: () => {
          clearTimeout(timer)
          set.delete(entry)
          resolve()
        },
      }
      const timer = setTimeout(entry.wake, Math.max(ms, 0))
      set.add(entry)
    })
  }
}
