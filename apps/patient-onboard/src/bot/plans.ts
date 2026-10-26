export interface Plan {
  id: string
  name: string
  priceRub: number
}

export const PLANS: readonly Plan[] = [
  { id: 'start', name: 'Старт', priceRub: 990 },
  { id: 'pro', name: 'Про', priceRub: 2990 },
]

export const DEFAULT_PLAN_ID = 'start'

export function findPlanById(id: string): Plan | undefined {
  return PLANS.find((plan) => plan.id === id)
}
