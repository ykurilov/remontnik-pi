import { describe, expect, it } from 'vitest'
import { agentDeadlineOf, agentDeployWindow, cancelPending, unadoptedDeploy, type Handoff } from './index.js'

// Сроки и окна передачи: с какой минуты считать ошибки выкатки агента и до какого времени агент мог работать.

const MINUTE = 60_000
const at = (minutes: number) => new Date(Date.parse('2026-10-26T10:00:00Z') + minutes * MINUTE).toISOString()
const base: Handoff = { caseId: 1, taskId: '01JB0000000000000000000000', owner: 'doctor', sentAt: at(0), reclaimedAt: at(20), reclaimReason: 'bridge_unreachable' }
const timeouts = { acceptTimeoutMs: 5 * MINUTE, workTimeoutMs: 60 * MINUTE }

describe('окно ошибок выкатки агента', () => {
  it('ошибки — с запасом до отчёта агента (выкатка началась раньше), сбой случая — с самого отчёта', () => {
    expect(agentDeployWindow(base, 'v2', at(40))).toEqual({ version: 'v2', since: Date.parse(at(35)), caseSince: Date.parse(at(40)) })
  })

  it('запас не уходит раньше передачи задачи: до неё агент выкатить не мог', () => {
    expect(agentDeployWindow(base, 'v2', at(2)).since).toBe(Date.parse(at(0)))
    const offered: Handoff = { ...base, sentAt: undefined, taskOffered: true, reclaimedAt: at(0) }
    expect(agentDeployWindow(offered, 'v2', at(3)).since).toBe(Date.parse(at(0)))
  })

  it('поздняя выкатка — то же окно от времени позднего итога', () => {
    const late: Handoff = { ...base, lateResult: { kind: 'done', deployed: true, version: 'v2', receivedAt: at(50) } }
    expect(unadoptedDeploy(late)).toEqual({ version: 'v2', since: Date.parse(at(45)), caseSince: Date.parse(at(50)) })
    expect(unadoptedDeploy({ ...late, adoptedAt: at(51) })).toBeUndefined()
  })
})

describe('срок работы агента и отмена задачи', () => {
  it('взял — до срока работы; не взял — срок взять и срок работы от передачи', () => {
    expect(agentDeadlineOf({ ...base, acceptedAt: at(1), workDeadline: at(61) }, timeouts)).toBe(Date.parse(at(61)))
    expect(agentDeadlineOf(base, timeouts)).toBe(Date.parse(at(65)))
    expect(agentDeadlineOf({ ...base, sentAt: undefined, taskOffered: true, reclaimedAt: at(0) }, timeouts)).toBe(Date.parse(at(65)))
  })

  it('отмена нужна, пока случай забран, задача могла дойти до моста и мост её не подтвердил', () => {
    expect(cancelPending(base)).toBe(true)
    expect(cancelPending({ ...base, cancelSent: true })).toBe(false)
    expect(cancelPending({ ...base, owner: 'paseo' })).toBe(false)
    expect(cancelPending({ ...base, sentAt: undefined })).toBe(false)
    expect(cancelPending({ ...base, sentAt: undefined, taskOffered: true })).toBe(true)
  })
})
