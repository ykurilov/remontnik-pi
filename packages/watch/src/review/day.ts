// Календарные сутки в заданном поясе: по ним считаются суточный бюджет и лимиты чтения.

const formatters = new Map<string, Intl.DateTimeFormat>()

/** Календарный день `ГГГГ-ММ-ДД` в заданном поясе. */
export function dayKey(ms: number, timeZone: string): string {
  let formatter = formatters.get(timeZone)
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
    formatters.set(timeZone, formatter)
  }
  return formatter.format(new Date(ms))
}
