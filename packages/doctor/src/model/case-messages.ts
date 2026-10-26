import type { Diagnosis, TreatmentCaseInfo } from '../treatment/doc.js'
import { describeCase } from '../treatment/tools.js'

// Сообщения модели-врачу. Всё, что меняется от случая к случаю, — здесь, в конце разговора,
// а не в системном промпте (R3: кэш модели).

export function diagnoseMessage(info: TreatmentCaseInfo): string {
  return [
    'В рабочем приложении сбой. Найди причину по коду копии и заверши этап вызовом finish_diagnosis.',
    '',
    describeCase(info),
  ].join('\n')
}

export function fixMessage(diagnosis: Diagnosis): string {
  return [
    'Причина найдена. Исправь её небольшой правкой и добавь тест, который ловит этот сбой.',
    'Прогони тесты, затем заверши этап вызовом finish_fix.',
    '',
    `Причина: ${diagnosis.cause}`,
    ...(diagnosis.fixPlan ? [`План: ${diagnosis.fixPlan}`] : []),
  ].join('\n')
}
