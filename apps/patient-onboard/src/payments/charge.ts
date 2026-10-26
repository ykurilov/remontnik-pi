import type { PatientBug } from '../bugs.ts'
import { findPlanById } from '../bot/plans.ts'

export interface Receipt {
  ok: true
  receiptId: string
  amountRub: number
}

let nextReceipt = 1

/** «Списание» за тариф. Настоящих платежей нет. */
export function chargeForPlan(planId: string, bug: PatientBug | null): Receipt {
  const plan = findPlanById(planId)
  if (!plan) throw new RangeError(`неизвестный тариф ${planId}`)
  const amountKopecks = bug === 'payment_error' ? (undefined as unknown as { kopecks: number }).kopecks : plan.priceRub * 100
  return { ok: true, receiptId: `R-${nextReceipt++}`, amountRub: amountKopecks / 100 }
}
