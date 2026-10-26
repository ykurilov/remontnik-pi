// Текст снимка из дерева доступности Playwright (`ariaSnapshotJSON({ mode: 'ai' })`).
// Пишем сами, а не берём готовый текст: значения полей пароля встроенный снимок отдаёт открыто.

export interface SnapshotNode {
  role: string
  name?: string
  ref?: string
  text?: string
  url?: string
  children?: Array<SnapshotNode | string>
  [property: string]: unknown
}

/** `password` — поле пароля сейчас или раньше; `filled` — сюда браузер вписал сохранённый пароль. */
export type FieldMark = 'password' | 'filled'

const MARK_LABELS: Record<FieldMark, string> = { password: '[поле пароля]', filled: '[пароль вписан]' }
const HIDDEN_VALUE = '[скрыто]'
const OWN_KEYS = new Set(['role', 'name', 'ref', 'text', 'url', 'children', 'box', 'cursor'])
const FIELD_ROLES = new Set(['textbox', 'searchbox', 'combobox', 'spinbutton'])

const quote = (text: string) => `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`

function headerOf(node: SnapshotNode, mark: FieldMark | undefined): string {
  const parts = [node.role]
  if (node.name) parts.push(quote(node.name))
  for (const [key, value] of Object.entries(node)) {
    if (OWN_KEYS.has(key) || value === false || value === undefined || value === null) continue
    parts.push(value === true ? `[${key}]` : `[${key}=${String(value)}]`)
  }
  if (node.ref) parts.push(`[ref=${node.ref}]`)
  if (mark) parts.push(MARK_LABELS[mark])
  return parts.join(' ')
}

function renderNode(node: SnapshotNode | string, marks: ReadonlyMap<string, FieldMark>, depth: number, lines: string[]): void {
  const indent = '  '.repeat(depth)
  if (typeof node === 'string') {
    lines.push(`${indent}- text: ${node}`)
    return
  }
  const mark = node.ref ? marks.get(node.ref) : undefined
  const children = mark ? [] : (node.children ?? [])
  const value = mark ? (node.text ? HIDDEN_VALUE : undefined) : node.text
  const header = headerOf(node, mark)
  if (node.url === undefined && children.length === 0) {
    lines.push(value === undefined || value === '' ? `${indent}- ${header}` : `${indent}- ${header}: ${value}`)
    return
  }
  lines.push(`${indent}- ${header}:`)
  if (value) lines.push(`${indent}  - text: ${value}`)
  if (node.url !== undefined) lines.push(`${indent}  - /url: ${node.url}`)
  for (const child of children) renderNode(child, marks, depth + 1, lines)
}

export function renderSnapshot(nodes: ReadonlyArray<SnapshotNode | string>, marks: ReadonlyMap<string, FieldMark>): string {
  const lines: string[] = []
  for (const node of nodes) renderNode(node, marks, 0, lines)
  return lines.join('\n')
}

/** Номера всех полей ввода, включая фреймы: их надо проверить на «поле пароля». */
export function fieldRefs(nodes: ReadonlyArray<SnapshotNode | string>): string[] {
  const refs: string[] = []
  const visit = (node: SnapshotNode | string) => {
    if (typeof node === 'string') return
    if (node.ref && FIELD_ROLES.has(node.role)) refs.push(node.ref)
    node.children?.forEach(visit)
  }
  nodes.forEach(visit)
  return refs
}

/** Видимый текст снимка без значений скрытых полей — для поиска признаков капчи и кодов. */
export function snapshotText(nodes: ReadonlyArray<SnapshotNode | string>, marks: ReadonlyMap<string, FieldMark> = new Map()): string {
  const parts: string[] = []
  const visit = (node: SnapshotNode | string) => {
    if (typeof node === 'string') return void parts.push(node)
    if (node.name) parts.push(node.name)
    if (node.ref && marks.has(node.ref)) return
    if (node.text) parts.push(node.text)
    node.children?.forEach(visit)
  }
  nodes.forEach(visit)
  return parts.join('\n')
}
