import type { RecordStore } from '../records/index.js'

// Стоп-кран выкаток (FR-012): документ `remontnik.controls`. Стоп не прерывает идущую выкатку с её откатом,
// но новая выкатка не начнётся, выкатка до `promote` остановится (см. deployer), а правку после окна наблюдения
// врач не вольёт в основную ветку (см. treatment/task.ts).

export const CONTROLS = { collection: 'controls', key: 'main' } as const

export interface DeployControls {
  autoDeploy: 'on' | 'stopped'
  stoppedBy?: string
  stoppedAt?: string
}

export type ControlAction = 'stop' | 'resume'

export interface Controls {
  read(): Promise<DeployControls>
  set(action: ControlAction, by: string): Promise<DeployControls>
}

export async function readControls(store: RecordStore): Promise<DeployControls> {
  return (await store.read<DeployControls>(CONTROLS.collection, CONTROLS.key)) ?? { autoDeploy: 'on' }
}

export function createControls(store: RecordStore, now: () => Date = () => new Date()): Controls {
  return {
    read: () => readControls(store),
    set: (action, by) =>
      store.transaction(async (tx) => {
        const controls = await tx.doc<DeployControls>(CONTROLS.collection, CONTROLS.key, { autoDeploy: 'on' })
        delete controls.stoppedBy
        delete controls.stoppedAt
        if (action === 'stop') Object.assign(controls, { autoDeploy: 'stopped', stoppedBy: by, stoppedAt: now().toISOString() })
        else controls.autoDeploy = 'on'
        return { ...controls }
      }),
  }
}
