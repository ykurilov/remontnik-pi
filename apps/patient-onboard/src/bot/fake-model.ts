import type { PatientBug } from '../bugs.ts'

// «Модель» бота: заглушка без сети. Отвечает на всё, что не разобрали правила бота.
export const FAKE_MODEL = 'patient-fake-model'
export const FAKE_PROVIDER = 'patient-fake-provider'

export class ModelProviderError extends Error {
  readonly model = FAKE_MODEL
  readonly provider = FAKE_PROVIDER

  constructor(message: string) {
    super(message)
    this.name = 'ModelProviderError'
  }
}

export async function completeWithFakeModel(_message: string, bug: PatientBug | null): Promise<string> {
  if (bug === 'model_error') throw new ModelProviderError(`${FAKE_PROVIDER} returned 503 for ${FAKE_MODEL}`)
  return 'Я пока умею отвечать про тарифы и заказы. Спросите, сколько стоит тариф, или где ваш заказ.'
}
