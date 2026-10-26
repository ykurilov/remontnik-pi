import type { Diagnosis, TreatmentCaseInfo } from '../treatment/doc.js'
import { describeCase } from '../treatment/tools.js'

// Сообщения модели-врачу. Всё, что меняется от случая к случаю, — здесь, в конце разговора,
// а не в системном промпте (R3: кэш модели).

export function diagnoseMessage(info: TreatmentCaseInfo): string {
  const task =
    info.kind === 'bad_answer'
      ? 'Бот приложения дал пользователю плохой ответ. Найди место промпта или кода бота, из-за которого так вышло, и заверши этап вызовом finish_diagnosis.'
      : 'В рабочем приложении сбой. Найди причину по коду копии и заверши этап вызовом finish_diagnosis.'
  return [task, '', describeCase(info)].join('\n')
}

export function fixMessage(diagnosis: Diagnosis, info: TreatmentCaseInfo): string {
  const task =
    info.kind === 'bad_answer'
      ? [
          'Причина найдена. Исправь промпт или код бота небольшой правкой.',
          'Правку проверят сценарии eval по карте промптов; существующие сценарии и тесты не меняй. Тест добавь, если ответ можно проверить без модели.',
          'Заверши этап вызовом finish_fix.',
        ]
      : ['Причина найдена. Исправь её небольшой правкой и добавь тест, который ловит этот сбой.', 'Прогони тесты, затем заверши этап вызовом finish_fix.']
  return [...task, '', `Причина: ${diagnosis.cause}`, ...(diagnosis.fixPlan ? [`План: ${diagnosis.fixPlan}`] : [])].join('\n')
}

/** Работа над этапом прервалась на потолке расходов, наступили новые сутки. */
export function resumeMessage(): string {
  return 'Работа прерывалась: кончился дневной бюджет. Продолжи этап с того места, где остановился, и заверши его тем же вызовом.'
}
