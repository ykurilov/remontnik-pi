// Снимок страницы с номерами элементов. Номера — встроенные в закреплённый playwright-core
// (`ariaSnapshotJSON({ mode: 'ai' })`, `getByRef`); значения полей пароля скрываем сами.
import type { ElementHandle, Page } from 'playwright-core'
import { isFrameAllowed } from '../guard/index.js'
import { type FieldMark, type SnapshotNode, fieldNodes, renderSnapshot, snapshotText } from './render.js'

export { type FieldMark, type SnapshotNode, fieldNodes, fieldRefs, renderSnapshot, snapshotText } from './render.js'

/**
 * Поля, значение которых не показывается никогда: были полем пароля хоть в одном снимке
 * или сюда вписан сохранённый пароль. Страница может сменить им тип на текст — метка остаётся.
 */
export interface SensitiveFields {
  mark(handle: ElementHandle, kind: FieldMark): Promise<boolean>
  kindOf(handle: ElementHandle): Promise<FieldMark | undefined>
}

export function createSensitiveFields(): SensitiveFields {
  let entries: Array<{ handle: ElementHandle; kind: FieldMark }> = []

  async function find(handle: ElementHandle) {
    const frame = await handle.ownerFrame()
    const alive: typeof entries = []
    let found: (typeof entries)[number] | undefined
    for (const entry of entries) {
      try {
        if (!found && (await entry.handle.ownerFrame()) === frame && (await handle.evaluate((a, b) => a === b, entry.handle))) found = entry
        alive.push(entry)
      } catch {
        // Документ, где было поле, закрыт: метка больше не нужна.
      }
    }
    entries = alive
    return found
  }

  return {
    async mark(handle, kind) {
      const existing = await find(handle)
      if (existing) {
        if (kind === 'filled') existing.kind = 'filled'
        return false
      }
      entries.push({ handle, kind })
      return true
    },
    async kindOf(handle) {
      return (await find(handle))?.kind
    },
  }
}

export interface PageSnapshot {
  url: string
  title: string
  snapshot: string
  /** Номера полей пароля и полей со вписанным паролем — для маски снимка экрана. */
  sensitiveRefs: string[]
  /** Видимый текст без значений скрытых полей — для поиска признаков капчи и кодов. */
  text: string
}

const PASSWORD_AUTOCOMPLETE = /\b(?:current|new)-password\b/i

export interface SnapshotOptions {
  allowedOrigins: readonly string[]
  /** Сохранённые пароли: поле с таким значением скрыто, даже если сайт пересоздал его без метки. */
  secrets: () => readonly string[]
}

export const HIDDEN_FRAME = 'скрыт: сайт вне allowedOrigins'

/** Фреймы чужих сайтов (и всё внутри них) не попадают к врачу: остаётся только пометка. */
async function hideForeignFrames(page: Page, nodes: ReadonlyArray<SnapshotNode | string>, allowedOrigins: readonly string[]): Promise<void> {
  for (const node of nodes) {
    if (typeof node === 'string') continue
    if (node.role === 'iframe' && node.ref) {
      const handle = await page.getByRef(node.ref).elementHandle({ timeout: 2000 }).catch(() => null)
      const frame = await handle?.contentFrame().catch(() => null)
      await handle?.dispose()
      if (!frame || !isFrameAllowed(frame, allowedOrigins)) {
        node.children = []
        node['фрейм'] = HIDDEN_FRAME
        continue
      }
    }
    if (node.children) await hideForeignFrames(page, node.children, allowedOrigins)
  }
}

export async function takeSnapshot(page: Page, fields: SensitiveFields, options: SnapshotOptions): Promise<PageSnapshot> {
  const nodes = (await page.ariaSnapshotJSON({ mode: 'ai', timeout: 10_000 })) as unknown as Array<SnapshotNode | string>
  await hideForeignFrames(page, nodes, options.allowedOrigins)
  const secrets = options.secrets()
  const marks = new Map<string, FieldMark>()
  for (const node of fieldNodes(nodes)) {
    const ref = node.ref!
    const handle = await page
      .getByRef(ref)
      .elementHandle({ timeout: 2000 })
      .catch(() => null)
    if (!handle) {
      // Не смогли проверить поле — скрываем на всякий случай.
      marks.set(ref, 'password')
      continue
    }
    let kept = false
    if (typeof node.text === 'string' && secrets.some((secret) => node.text!.includes(secret))) {
      kept = await fields.mark(handle, 'filled')
    } else {
      const facts = await handle.evaluate((element) => ({ type: element.getAttribute('type'), autocomplete: element.getAttribute('autocomplete') }))
      if (facts.type?.toLowerCase() === 'password' || PASSWORD_AUTOCOMPLETE.test(facts.autocomplete ?? '')) {
        kept = await fields.mark(handle, 'password')
      }
    }
    const kind = await fields.kindOf(handle)
    if (kind) marks.set(ref, kind)
    if (!kept) await handle.dispose()
  }
  return {
    url: page.url(),
    title: await page.title(),
    snapshot: renderSnapshot(nodes, marks),
    sensitiveRefs: [...marks.keys()],
    text: snapshotText(nodes, marks),
  }
}
