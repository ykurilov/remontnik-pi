// Журнал службы: одна строка JSON на событие, всегда через фильтр сохранённых паролей.
// Фильтр сломался (например, хранилище повреждено) — пишем только факт сбоя, без текста события.
import type { OutputFilter } from './vault/index.js'

export type LogSink = (line: string) => void
export type ServiceLog = (event: Record<string, unknown>) => void

export function createServiceLog(sink: LogSink, filter: OutputFilter): ServiceLog {
  return (event) => {
    const time = new Date().toISOString()
    let line: string
    try {
      line = filter.text(JSON.stringify({ time, ...event }))
    } catch {
      line = JSON.stringify({ time, event: 'log_filter_failed' })
    }
    try {
      sink(line)
    } catch {
      // Журнал недоступен — служба работает дальше.
    }
  }
}
