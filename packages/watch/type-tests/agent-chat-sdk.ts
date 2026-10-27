import type { createChatService } from '@ykurilov/agent-chat-core'
import { agentChatWatchHooks } from '../src/agent-chat/index.js'
import type { Watch } from '../src/capture/index.js'

// Хуки сторожа подставляются в настоящий Agent Chat SDK без приведения типов: ошибка здесь — ошибка `pnpm typecheck`.

declare const watch: Pick<Watch, 'capture'>

type SdkHooks = Pick<Parameters<typeof createChatService>[0], 'logError' | 'turnNotStarted' | 'afterTurn'>

export const plain: SdkHooks = agentChatWatchHooks(watch)
export const withAfterTurn: SdkHooks = agentChatWatchHooks(watch, { afterTurn: true })
export const withInner: SdkHooks = agentChatWatchHooks(watch, {
  inner: {
    logError: (message: string) => void message,
    afterTurn: async () => ({ events: [{ type: 'app.turn' }] }),
    turnNotStarted: () => undefined,
  },
})
