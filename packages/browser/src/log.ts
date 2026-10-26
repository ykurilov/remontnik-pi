// Журнал службы: одна строка JSON на событие, всегда через фильтр сохранённых паролей.
import type { OutputFilter } from './vault/index.js'

export type LogSink = (line: string) => void
export type ServiceLog = (event: Record<string, unknown>) => void

export function createServiceLog(sink: LogSink, filter: OutputFilter): ServiceLog {
  return (event) => sink(filter.text(JSON.stringify({ time: new Date().toISOString(), ...event })))
}
