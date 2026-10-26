// Трансляция экрана профиля владельцу: кадры JPEG через протокол отладки Chromium (Page.startScreencast)
// и обратный ввод (Input.dispatchMouseEvent, insertText, клавиши). Без X-сервера и VNC.
// Кадры идут только подписчикам живого экрана: в журналы и ответы врачу они не попадают.
import type { CDPSession } from 'playwright-core'
import type { ProfileSession, Profiles } from '../profiles/index.js'

export interface LiveFrame {
  /** JPEG в base64. */
  data: string
  /** Размер страницы в CSS-пикселях — для пересчёта координат касаний. */
  width: number
  height: number
}

export type OwnerInput =
  | { type: 'mouse'; action: 'down' | 'up' | 'move'; x: number; y: number; button?: 'left' | 'right' | 'middle' }
  | { type: 'tap'; x: number; y: number }
  | { type: 'wheel'; x: number; y: number; dx: number; dy: number }
  | { type: 'key'; key: string }
  | { type: 'text'; text: string }

export interface LiveTarget {
  subscribe(listener: (frame: LiveFrame) => void): () => void
  dispatch(input: OwnerInput): Promise<void>
}

export interface LiveTargets {
  open(profile: string): Promise<LiveTarget>
}

const MOUSE_EVENT = { down: 'mousePressed', up: 'mouseReleased', move: 'mouseMoved' } as const

function createScreencast(session: ProfileSession): LiveTarget {
  const listeners = new Set<(frame: LiveFrame) => void>()
  let cdp: Promise<CDPSession> | null = null
  let lastFrame: LiveFrame | null = null

  async function start(): Promise<CDPSession> {
    const client = await session.context.newCDPSession(session.page)
    client.on('Page.screencastFrame', (event) => {
      void client.send('Page.screencastFrameAck', { sessionId: event.sessionId }).catch(() => {})
      lastFrame = { data: event.data, width: event.metadata.deviceWidth, height: event.metadata.deviceHeight }
      for (const listener of listeners) listener(lastFrame)
    })
    const viewport = session.page.viewportSize() ?? { width: 1280, height: 800 }
    await client.send('Page.startScreencast', { format: 'jpeg', quality: 60, maxWidth: viewport.width, maxHeight: viewport.height, everyNthFrame: 1 })
    return client
  }

  async function stop(): Promise<void> {
    const client = cdp
    cdp = null
    lastFrame = null
    if (!client) return
    const opened = await client.catch(() => null)
    await opened?.send('Page.stopScreencast').catch(() => {})
    await opened?.detach().catch(() => {})
  }

  const client = () => (cdp ??= start())

  async function mouse(type: 'mousePressed' | 'mouseReleased' | 'mouseMoved', x: number, y: number, button: string) {
    await (await client()).send('Input.dispatchMouseEvent', {
      type,
      x,
      y,
      button: type === 'mouseMoved' ? 'none' : (button as 'left'),
      clickCount: type === 'mouseMoved' ? 0 : 1,
    })
  }

  return {
    subscribe(listener) {
      listeners.add(listener)
      if (lastFrame) listener(lastFrame)
      void client().catch(() => {})
      return () => {
        listeners.delete(listener)
        if (listeners.size === 0) void stop()
      }
    },
    async dispatch(input) {
      switch (input.type) {
        case 'mouse':
          return mouse(MOUSE_EVENT[input.action], input.x, input.y, input.button ?? 'left')
        case 'tap':
          // Касание с телефона — нажатие мыши в той же точке: страница профиля без сенсорного режима.
          await mouse('mousePressed', input.x, input.y, 'left')
          return mouse('mouseReleased', input.x, input.y, 'left')
        case 'wheel':
          await (await client()).send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: input.x, y: input.y, deltaX: input.dx, deltaY: input.dy })
          return
        case 'key':
          return session.page.keyboard.press(input.key).catch(() => {})
        case 'text':
          await (await client()).send('Input.insertText', { text: input.text })
      }
    },
  }
}

export function createLiveTargets(profiles: Profiles): LiveTargets {
  const targets = new Map<string, LiveTarget>()
  return {
    async open(profile) {
      const existing = targets.get(profile)
      if (existing) return existing
      const target = createScreencast(await profiles.get(profile))
      targets.set(profile, target)
      return target
    },
  }
}
