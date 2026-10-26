// Последний замок: из любого ответа и журнала службы вырезаются значения всех сохранённых паролей,
// в том числе в видах, в которых они попадают в адреса, формы и JSON.

export interface OutputFilter {
  text(text: string): string
  value<T>(value: T): T
}

const PLACEHOLDER = '[пароль скрыт]'

function variantsOf(password: string): string[] {
  const variants = new Set([
    password,
    encodeURIComponent(password),
    new URLSearchParams({ p: password }).toString().slice(2),
    JSON.stringify(password).slice(1, -1),
    JSON.stringify(JSON.stringify(password).slice(1, -1)).slice(1, -1),
    Buffer.from(password).toString('base64'),
  ])
  // Длинные варианты первыми: короткий не должен разрезать длинный.
  return [...variants].filter((variant) => variant.length >= 4).sort((a, b) => b.length - a.length)
}

export function createOutputFilter(knownPasswords: () => readonly string[]): OutputFilter {
  function text(input: string): string {
    let result = input
    for (const password of knownPasswords()) {
      for (const variant of variantsOf(password)) result = result.split(variant).join(PLACEHOLDER)
    }
    return result
  }

  function value<T>(input: T): T {
    if (typeof input === 'string') return text(input) as T
    if (Array.isArray(input)) return input.map((item) => value(item)) as T
    if (input !== null && typeof input === 'object') {
      return Object.fromEntries(Object.entries(input).map(([key, item]) => [key, value(item)])) as T
    }
    return input
  }

  return { text, value }
}
