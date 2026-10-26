// Кто управляет профилем: врач или владелец через живой экран.
// Владелец взял управление — команды врача отклоняются; связь владельца молчит 2 минуты — управление у врача.
import type { LiveTarget, OwnerInput } from './stream.js'

export const OWNER_SILENCE_LIMIT_MS = 120_000

export type ControlHolder = 'owner' | 'doctor'

export interface ControlLock {
  take(profile: string): void
  release(profile: string): void
  /** Открыт поток живого экрана; возвращает «связь закрыта». */
  ownerConnected(profile: string): () => void
  /** Любой знак жизни владельца: сообщение, ответ на пинг, запрос. */
  ownerSeen(profile: string): void
  holder(profile: string): ControlHolder
}

interface ProfileControl {
  taken: boolean
  connections: number
  lastSeen: number
}

export function createControlLock(options: { now?: () => number; silenceLimitMs?: number } = {}): ControlLock {
  const now = options.now ?? Date.now
  const silenceLimitMs = options.silenceLimitMs ?? OWNER_SILENCE_LIMIT_MS
  const profiles = new Map<string, ProfileControl>()

  // Сначала гасим просроченное управление: поздний знак владельца его не продлевает.
  const expire = (state: ProfileControl) => {
    if (state.taken && state.connections === 0 && now() - state.lastSeen >= silenceLimitMs) state.taken = false
  }

  const stateOf = (profile: string) => {
    let state = profiles.get(profile)
    if (!state) profiles.set(profile, (state = { taken: false, connections: 0, lastSeen: now() }))
    expire(state)
    return state
  }

  return {
    take(profile) {
      const state = stateOf(profile)
      state.taken = true
      state.lastSeen = now()
    },
    release(profile) {
      stateOf(profile).taken = false
    },
    ownerConnected(profile) {
      const state = stateOf(profile)
      state.connections += 1
      state.lastSeen = now()
      let open = true
      return () => {
        if (!open) return
        open = false
        state.connections -= 1
        state.lastSeen = now()
      }
    },
    ownerSeen(profile) {
      stateOf(profile).lastSeen = now()
    },
    holder(profile) {
      const state = profiles.get(profile)
      if (!state) return 'doctor'
      expire(state)
      return state.taken ? 'owner' : 'doctor'
    },
  }
}

export function refuseIfHumanControl(lock: ControlLock, profile: string) {
  if (lock.holder(profile) !== 'owner') return null
  return {
    ok: false as const,
    code: 'refused_human_control' as const,
    message: 'управление профилем у владельца (живой экран); команды врача подождут, пока он нажмёт «Вернуть»',
  }
}

const MOUSE_ACTIONS = new Set(['down', 'up', 'move'])
const MOUSE_BUTTONS = new Set(['left', 'right', 'middle'])
const isCoordinate = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 10_000
const isDelta = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 10_000

/** Ввод владельца — только мышь, касание, колесо, клавиша и текст. Переходов и своего кода нет. */
export function parseOwnerInput(raw: unknown): OwnerInput | null {
  if (raw === null || typeof raw !== 'object') return null
  const input = raw as Record<string, unknown>
  switch (input.type) {
    case 'mouse':
      if (!MOUSE_ACTIONS.has(String(input.action)) || !isCoordinate(input.x) || !isCoordinate(input.y)) return null
      if (input.button !== undefined && !MOUSE_BUTTONS.has(String(input.button))) return null
      return {
        type: 'mouse',
        action: input.action as 'down' | 'up' | 'move',
        x: input.x,
        y: input.y,
        ...(input.button === undefined ? {} : { button: input.button as 'left' | 'right' | 'middle' }),
      }
    case 'tap':
      return isCoordinate(input.x) && isCoordinate(input.y) ? { type: 'tap', x: input.x, y: input.y } : null
    case 'wheel':
      return isCoordinate(input.x) && isCoordinate(input.y) && isDelta(input.dx) && isDelta(input.dy)
        ? { type: 'wheel', x: input.x, y: input.y, dx: input.dx, dy: input.dy }
        : null
    case 'key':
      return typeof input.key === 'string' && /^[\w+-]{1,32}$/.test(input.key) ? { type: 'key', key: input.key } : null
    case 'text':
      return typeof input.text === 'string' && input.text.length > 0 && input.text.length <= 1000 ? { type: 'text', text: input.text } : null
    default:
      return null
  }
}

export async function handleOwnerInput(lock: ControlLock, profile: string, raw: unknown, target: LiveTarget) {
  const input = parseOwnerInput(raw)
  if (!input) return { ok: false as const, code: 'bad_request', message: 'ввод: mouse, tap, wheel, key или text' }
  if (lock.holder(profile) !== 'owner') return { ok: false as const, code: 'not_in_control', message: 'сначала «Взять управление»' }
  lock.ownerSeen(profile)
  await target.dispatch(input)
  return { ok: true as const }
}
