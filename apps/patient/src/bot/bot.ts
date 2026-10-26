import type { PatientBug } from '../bugs.ts'
import { completeWithFakeModel } from './fake-model.ts'
import { DEFAULT_PLAN_ID, PLANS, findPlanById, type Plan } from './plans.ts'
import { ToolError, lookupOrder } from './tools.ts'

export interface BotOptions {
  bug: PatientBug | null
  /** Ошибка, которую бот пережил сам (например, инструмента). */
  onHandledError?: (error: ToolError) => void
  /** Падение процесса; в тестах подменяется. */
  crashProcess?: (error: Error) => void
}

export interface Bot {
  reply(message: string): Promise<string>
}

/** Тарифа «Макс» нет: бот с PATIENT_BUG=bad_answer называет для него выдуманную цену. */
const INVENTED_MAX_PRICE_RUB = 5990

function findPlanInText(text: string, bug: PatientBug | null): Plan {
  const lower = text.toLowerCase()
  const named = PLANS.find((plan) => new RegExp(`(^|[^а-яё])${plan.name.toLowerCase()}([^а-яё]|$)`).test(lower))
  if (bug === 'worsening_fix') return named as Plan
  return named ?? (findPlanById(DEFAULT_PLAN_ID) as Plan)
}

function rememberTurn(message: string, crashProcess: (error: Error) => void): void {
  setImmediate(() => {
    try {
      throw new Error(`history store is closed (PATIENT_BUG=crash), message length ${message.length}`)
    } catch (error) {
      crashProcess(error as Error)
    }
  })
}

export function createBot(options: BotOptions): Bot {
  const { bug } = options
  const crashProcess =
    options.crashProcess ??
    ((error: Error) => {
      throw error
    })

  return {
    async reply(message) {
      if (bug === 'crash') rememberTurn(message, crashProcess)
      const lower = message.toLowerCase()

      if (/привет|здравствуй|добрый/.test(lower)) {
        return 'Здравствуйте! Я бот «Пациента». Спросите про тарифы или про ваш заказ.'
      }
      if (/сколько стоит|цена|стоимость/.test(lower)) {
        if (bug === 'bad_answer' && /(^|[^а-яё])макс([^а-яё]|$)/.test(lower)) {
          return `Тариф «Макс» стоит ${INVENTED_MAX_PRICE_RUB} ₽ в месяц.`
        }
        const plan = findPlanInText(message, bug)
        return `Тариф ${plan.name} стоит ${plan.priceRub} ₽ в месяц.`
      }
      const order = /заказ\D*(\d+)/.exec(lower)
      if (order?.[1]) {
        const orderNumber = Number(order[1])
        try {
          return `Заказ ${orderNumber}: ${lookupOrder(orderNumber, bug)}.`
        } catch (error) {
          if (!(error instanceof ToolError)) throw error
          options.onHandledError?.(error)
          return 'Извините, сейчас не получилось проверить заказ. Попробуйте позже.'
        }
      }
      return completeWithFakeModel(message, bug)
    },
  }
}
