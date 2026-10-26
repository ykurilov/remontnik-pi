// Заложенные ошибки «Пациента». Включаются переменной окружения PATIENT_BUG, по одной.
export const PATIENT_BUGS = [
  /** Процесс падает после ответа в чате. */
  'crash',
  /** «Модель» бота отвечает ошибкой поставщика. */
  'model_error',
  /** Инструмент `lookupOrder` падает, бот извиняется. */
  'tool_error',
  /** Ошибка только в коде страницы чата: сервер здоров, в браузере форма не работает. */
  'page_error',
  /** Ошибка в «оплате» — запретной зоне: правку можно описать, но не выкатить. */
  'payment_error',
  /**
   * Вопрос о цене без названия тарифа валит ответ. Соблазнительная правка — убрать цены из ответов —
   * ломает сценарий eval с названным тарифом, который сейчас проходит.
   */
  'worsening_fix',
  /** Бот выдумывает цену несуществующего тарифа «Макс»: падений нет, плохой ответ видно только при чтении разговора. */
  'bad_answer',
] as const

export type PatientBug = (typeof PATIENT_BUGS)[number]

export function parsePatientBug(value: string | undefined): PatientBug | null {
  if (value === undefined || value.trim() === '') return null
  const bug = PATIENT_BUGS.find((known) => known === value.trim())
  if (!bug) throw new Error(`PATIENT_BUG=${value}: неизвестная ошибка, ожидается одна из ${PATIENT_BUGS.join(', ')}`)
  return bug
}
