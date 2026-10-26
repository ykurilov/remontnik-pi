import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createDeployLock } from './lock.js'

const lockPath = () => join(mkdtempSync(join(tmpdir(), 'remontnik-lock-')), '.remontnik', 'deploy.lock')
const at = new Date('2026-10-26T12:00:00Z')
const stillRunning = async () => false
const finished = async () => true

describe('общий замок выкатки', () => {
  it('одна выкатка на приложение: вторая ждёт, пока первая не отпустит замок', async () => {
    const path = lockPath()
    const lock = createDeployLock(path)
    expect(await lock.acquire(1, at, stillRunning)).toEqual({ acquired: true })
    expect(readFileSync(path, 'utf8')).toContain('remontnik deployment 1 ')

    expect(await lock.acquire(2, at, stillRunning)).toEqual({ acquired: false, holder: 'doctor' })
    await lock.release(1)
    expect(existsSync(path)).toBe(false)
    expect(await lock.acquire(2, at, stillRunning)).toEqual({ acquired: true })
  })

  it('после перезапуска врач узнаёт свой замок и не ждёт сам себя', async () => {
    const path = lockPath()
    await createDeployLock(path).acquire(7, at, stillRunning)
    expect(await createDeployLock(path).acquire(7, at, stillRunning)).toEqual({ acquired: true })
  })

  it('ручная выкатка держит замок: врач ждёт и сам замок человека не снимает', async () => {
    const path = lockPath()
    const lock = createDeployLock(path)
    await lock.acquire(1, at, stillRunning)
    await lock.release(1)
    writeFileSync(path, 'manual deploy by admin\n', { flag: 'wx' })

    expect(await lock.acquire(2, at, finished)).toEqual({ acquired: false, holder: 'human' })
    await lock.release(2)
    expect(readFileSync(path, 'utf8')).toBe('manual deploy by admin\n')
  })

  it('замок закончившейся выкатки (врач упал до снятия) снимается', async () => {
    const path = lockPath()
    await createDeployLock(path).acquire(3, at, stillRunning)
    const asked: number[] = []
    const result = await createDeployLock(path).acquire(4, at, async (id) => {
      asked.push(id)
      return true
    })
    expect(result).toEqual({ acquired: true })
    expect(asked).toEqual([3])
    expect(readFileSync(path, 'utf8')).toContain('remontnik deployment 4 ')
  })

  it('чужой замок врач не отпускает', async () => {
    const path = lockPath()
    const lock = createDeployLock(path)
    await lock.acquire(5, at, stillRunning)
    await lock.release(6)
    expect(readFileSync(path, 'utf8')).toContain('remontnik deployment 5 ')
  })
})
