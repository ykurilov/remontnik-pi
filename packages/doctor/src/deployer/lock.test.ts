import * as fsPromises from 'node:fs/promises'
import { mkdtempSync, readFileSync, readdirSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createDeployLock, type LockHolder } from './lock.js'

const lockPath = () => join(mkdtempSync(join(tmpdir(), 'remontnik-lock-')), '.remontnik', 'deploy.lock')
const at = new Date('2026-10-26T12:00:00Z')
const stillRunning = async () => false
const holder = (deploymentId: number): LockHolder => ({ deploymentId, token: `token-${deploymentId}` })

function humanLock(path: string, content: string) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content, { flag: 'wx' })
}

describe('общий замок выкатки', () => {
  it('одна выкатка на приложение: вторая ждёт, пока первая не отпустит замок', async () => {
    const path = lockPath()
    const lock = createDeployLock(path)
    expect(await lock.acquire(holder(1), at, stillRunning)).toEqual({ acquired: true })
    expect(readFileSync(path, 'utf8')).toBe(`remontnik deployment 1 token-1 ${at.toISOString()}\n`)

    expect(await lock.acquire(holder(2), at, stillRunning)).toEqual({ acquired: false, holder: 'doctor', content: expect.stringContaining('deployment 1') })
    await lock.release(holder(1))
    expect(existsSync(path)).toBe(false)
    expect(await lock.acquire(holder(2), at, stillRunning)).toEqual({ acquired: true })
  })

  it('замок появляется целиком: рядом не остаётся временных файлов', async () => {
    const path = lockPath()
    await createDeployLock(path).acquire(holder(1), at, stillRunning)
    expect(readdirSync(dirname(path))).toEqual(['deploy.lock'])
  })

  it('после перезапуска врач узнаёт свой замок и не ждёт сам себя; та же выкатка с другим знаком — не своя', async () => {
    const path = lockPath()
    await createDeployLock(path).acquire(holder(7), at, stillRunning)
    expect(await createDeployLock(path).acquire(holder(7), at, stillRunning)).toEqual({ acquired: true })
    expect(await createDeployLock(path).acquire({ deploymentId: 7, token: 'other' }, at, stillRunning)).toMatchObject({ acquired: false, holder: 'doctor' })
  })

  it('ручная выкатка держит замок: врач ждёт и сам замок человека не снимает, даже пустой', async () => {
    for (const content of ['manual deploy by admin\n', '']) {
      const path = lockPath()
      humanLock(path, content)
      expect(await createDeployLock(path).acquire(holder(2), at, async () => true)).toEqual({ acquired: false, holder: 'human', content })
      await createDeployLock(path).release(holder(2))
      expect(readFileSync(path, 'utf8')).toBe(content)
    }
  })

  it('замок человека, похожий на начало строки врача, — всё равно замок человека', async () => {
    const path = lockPath()
    humanLock(path, 'remontnik deployment 4 tok')
    expect(await createDeployLock(path).acquire(holder(4), at, async () => true)).toMatchObject({ acquired: false, holder: 'human' })
    expect(readFileSync(path, 'utf8')).toBe('remontnik deployment 4 tok')
  })

  it('замок закончившейся выкатки (врач упал до снятия) снимается', async () => {
    const path = lockPath()
    await createDeployLock(path).acquire(holder(3), at, stillRunning)
    const asked: LockHolder[] = []
    const result = await createDeployLock(path).acquire(holder(4), at, async (other) => {
      asked.push(other)
      return true
    })
    expect(result).toEqual({ acquired: true })
    expect(asked).toEqual([holder(3)])
    expect(readFileSync(path, 'utf8')).toContain('remontnik deployment 4 ')
    expect(readdirSync(dirname(path))).toEqual(['deploy.lock'])
  })

  it('пока врач решал, что замок брошен, его занял человек — замок человека остаётся', async () => {
    const path = lockPath()
    await createDeployLock(path).acquire(holder(3), at, stillRunning)
    const result = await createDeployLock(path).acquire(holder(4), at, async () => {
      writeFileSync(path, 'manual deploy\n')
      return true
    })
    expect(result).toMatchObject({ acquired: false, holder: 'human' })
    expect(readFileSync(path, 'utf8')).toBe('manual deploy\n')
    expect(readdirSync(dirname(path))).toEqual(['deploy.lock'])
  })

  it('гонка при снятии брошенного замка: чужой замок не удаляется, а откладывается в .lost-* и о нём сказано', async () => {
    const path = lockPath()
    await createDeployLock(path).acquire(holder(3), at, stillRunning)
    const fresh = `remontnik deployment 5 token-5 ${at.toISOString()}\n`
    // Пока врач решал, что замок 3 брошен, его отпустили и взяла выкатка 5; а в миг, когда врач увёл замок
    // в сторону для сверки, свой замок поставил человек — вернуть замок 5 на место уже нельзя.
    const racing = {
      ...fsPromises,
      rename: async (from: string, to: string) => {
        await fsPromises.rename(from, to)
        if (from === path) writeFileSync(path, 'manual deploy\n', { flag: 'wx' })
      },
    }
    const result = await createDeployLock(path, racing).acquire(holder(4), at, async () => {
      writeFileSync(path, fresh)
      return true
    })
    expect(result).toMatchObject({ acquired: false, holder: 'human', lost: expect.stringContaining('deploy.lock.lost-') })
    expect(readFileSync(path, 'utf8')).toBe('manual deploy\n')
    const lost = readdirSync(dirname(path)).filter((name) => name.startsWith('deploy.lock.lost-'))
    expect(lost).toHaveLength(1)
    expect(readFileSync(join(dirname(path), lost[0]!), 'utf8')).toBe(fresh)
  })

  it('держит ли выкатка замок — только чтение: пустое место не своё', async () => {
    const path = lockPath()
    const lock = createDeployLock(path)
    expect(await lock.holds(holder(1))).toBe(false)
    await lock.acquire(holder(1), at, stillRunning)
    expect(await lock.holds(holder(1))).toBe(true)
    expect(await lock.holds({ deploymentId: 1, token: 'other' })).toBe(false)
    await lock.release(holder(1))
    expect(await lock.holds(holder(1))).toBe(false)
    expect(existsSync(path)).toBe(false)
  })

  it('чужой замок врач не отпускает', async () => {
    const path = lockPath()
    const lock = createDeployLock(path)
    await lock.acquire(holder(5), at, stillRunning)
    await lock.release(holder(6))
    await lock.release({ deploymentId: 5, token: 'other' })
    expect(readFileSync(path, 'utf8')).toContain('remontnik deployment 5 ')
  })
})
