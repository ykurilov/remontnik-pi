import type { IncidentContext, IncidentKind } from '@ykurilov/remontnik-core/incident'
import { describe, expect, it, vi } from 'vitest'
import type { CaptureOptions } from '../capture/index.js'
import { agentChatWatchHooks, type AgentChatTurnResult } from './index.js'

interface Captured {
  error: unknown
  kind: IncidentKind | undefined
  where: string | undefined
  context: IncidentContext | undefined
}

function fakeWatch() {
  const captured: Captured[] = []
  return {
    captured,
    watch: {
      capture(error: unknown, options: CaptureOptions = {}) {
        captured.push({ error, kind: options.kind, where: options.where, context: options.context })
        return 'event-id'
      },
    },
  }
}

function turn(overrides: Partial<AgentChatTurnResult> = {}): AgentChatTurnResult {
  return { ownerId: 'u1', chatId: 'c1', messageId: 'm1', status: 'complete', parts: [], recovered: false, ...overrides }
}

describe('agentChatWatchHooks', () => {
  it('logError: строка о сбое провайдера — model_error, остальные — turn_failed; строка уходит в журнал приложения', () => {
    const { watch, captured } = fakeWatch()
    const inner = { logError: vi.fn() }
    const hooks = agentChatWatchHooks(watch, { inner })

    hooks.logError('[ход] провайдер openrouter не ответил: 503 overloaded')
    hooks.logError('[ход] сбой хода в чате c1: Cannot read properties of undefined')

    expect(inner.logError).toHaveBeenCalledTimes(2)
    expect(captured.map((item) => item.kind)).toEqual(['model_error', 'turn_failed'])
    expect(String((captured[0]?.error as Error).message)).toContain('503 overloaded')
  })

  it('logError без хука приложения пишет в console.error, как SDK по умолчанию', () => {
    const { watch } = fakeWatch()
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})

    agentChatWatchHooks(watch).logError('[ход] провайдер не ответил')

    expect(errors).toHaveBeenCalledWith('[ход] провайдер не ответил')
    errors.mockRestore()
  })

  it('logError не делает случаев из строк самого Ремонтника', () => {
    const { watch, captured } = fakeWatch()
    const hooks = agentChatWatchHooks(watch, { inner: { logError: () => {} } })

    hooks.logError('[remontnik] Telegram недоступен')

    expect(captured).toEqual([])
  })

  it('afterTurn: ход с ошибкой — turn_failed с моделью и поставщиком', async () => {
    const { watch, captured } = fakeWatch()
    const hooks = agentChatWatchHooks(watch, { afterTurn: true })

    await hooks.afterTurn!(
      turn({ status: 'error', error: { kind: 'overloaded', details: { providerId: 'openrouter', modelId: 'm1', statusCode: 503, reason: 'busy' } } }),
    )

    expect(captured).toHaveLength(1)
    expect(captured[0]).toMatchObject({ kind: 'turn_failed', context: { chatId: 'c1', model: 'm1', provider: 'openrouter' } })
    expect((captured[0]?.error as Error).message).toContain('overloaded')
  })

  it('afterTurn: инструмент с ошибкой — tool_error с именем инструмента', async () => {
    const { watch, captured } = fakeWatch()
    const hooks = agentChatWatchHooks(watch, { afterTurn: true })

    await hooks.afterTurn!(
      turn({
        parts: [
          { type: 'text', text: 'Извините' },
          { type: 'tool-lookupOrder', state: 'output-error', errorText: 'order service timeout' },
          { type: 'dynamic-tool', toolName: 'search', state: 'output-error', errorText: 'index missing' },
          { type: 'tool-ok', state: 'output-available' },
        ],
      }),
    )

    expect(captured.map((item) => [item.kind, item.where, item.context?.tool])).toEqual([
      ['tool_error', 'lookupOrder', 'lookupOrder'],
      ['tool_error', 'search', 'search'],
    ])
  })

  it('afterTurn: удачный ход без ошибок — ничего', async () => {
    const { watch, captured } = fakeWatch()

    await agentChatWatchHooks(watch, { afterTurn: true }).afterTurn!(turn())

    expect(captured).toEqual([])
  })

  it('результат хуков приложения не меняется, их ошибки идут наружу как были', async () => {
    const { watch, captured } = fakeWatch()
    const events = { events: [{ type: 'lesson_done', data: {} }] }
    const failure = new Error('app hook failed')
    const hooks = agentChatWatchHooks(watch, {
      inner: { afterTurn: async () => events, turnNotStarted: () => { throw failure } },
    })

    await expect(hooks.afterTurn!(turn({ status: 'error', error: { kind: 'other' } }))).resolves.toBe(events)
    expect(() => hooks.turnNotStarted({ reason: 'error', chat: { id: 'c1' } })).toThrow(failure)
    expect(captured.map((item) => item.kind)).toEqual(['turn_failed', 'turn_failed'])
  })

  it('afterTurn по умолчанию не подключается: SDK требует для него хранилище с setAfterTurnState', () => {
    const { watch } = fakeWatch()

    expect(agentChatWatchHooks(watch)).not.toHaveProperty('afterTurn')
    expect(agentChatWatchHooks(watch, { afterTurn: true }).afterTurn).toBeTypeOf('function')
    expect(agentChatWatchHooks(watch, { inner: { afterTurn: () => undefined } }).afterTurn).toBeTypeOf('function')
  })

  it('turnNotStarted: только сбой (`error`) — turn_failed', () => {
    const { watch, captured } = fakeWatch()
    const hooks = agentChatWatchHooks(watch)

    hooks.turnNotStarted({ reason: 'busy', chat: { id: 'c1' } })
    hooks.turnNotStarted({ reason: 'error', chat: { id: 'c1' } })

    expect(captured).toHaveLength(1)
    expect(captured[0]).toMatchObject({ kind: 'turn_failed', context: { chatId: 'c1' } })
  })

  it('сбой самого наблюдения не мешает ходу', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const hooks = agentChatWatchHooks({ capture: () => { throw new Error('watch broken') } }, { afterTurn: true })

    await expect(hooks.afterTurn!(turn({ status: 'error' }))).resolves.toBeUndefined()
    expect(errors.mock.calls.some(([line]) => String(line).startsWith('[remontnik]'))).toBe(true)
    errors.mockRestore()
  })
})
