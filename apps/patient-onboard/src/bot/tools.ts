import type { PatientBug } from '../bugs.ts'

export class ToolError extends Error {
  readonly tool: string

  constructor(tool: string, message: string) {
    super(message)
    this.name = 'ToolError'
    this.tool = tool
  }
}

const ORDER_STATUSES = ['собирается', 'в пути', 'доставлен'] as const

/** Инструмент бота: статус заказа по номеру. */
export function lookupOrder(orderNumber: number, bug: PatientBug | null): string {
  if (bug === 'tool_error') throw new ToolError('lookupOrder', `orders storage timeout for order ${orderNumber}`)
  return ORDER_STATUSES[orderNumber % ORDER_STATUSES.length] ?? 'неизвестен'
}
