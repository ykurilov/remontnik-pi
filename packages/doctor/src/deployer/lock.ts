import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

// Общий замок выкатки (contracts/deploy-commands.md): файл в репозитории приложения, общий для врача и человека.
// Создаётся только если его нет (`wx`), поэтому две выкатки не начнутся разом. Врач пишет в него свою строку;
// любое другое содержимое — выкатка человека, такой замок врач ждёт и никогда не снимает.

const OWN_LINE = /^remontnik deployment (\d+) /

export type LockAttempt = { acquired: true } | { acquired: false; holder: 'doctor' | 'human' }

export interface DeployLock {
  /**
   * Взять замок для выкатки `deploymentId`. Свой замок (врач перезапустился) — уже взят.
   * Замок другой выкатки врача снимается, если `isFinished` говорит, что та закончилась: врач упал до снятия.
   */
  acquire(deploymentId: number, now: Date, isFinished: (deploymentId: number) => Promise<boolean>): Promise<LockAttempt>
  /** Снять замок, только если он этой выкатки. */
  release(deploymentId: number): Promise<void>
}

async function readLock(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

const ownerOf = (content: string): number | undefined => {
  const match = OWN_LINE.exec(content)
  return match ? Number(match[1]) : undefined
}

export function createDeployLock(path: string): DeployLock {
  async function create(deploymentId: number, now: Date): Promise<boolean> {
    await mkdir(dirname(path), { recursive: true })
    try {
      await writeFile(path, `remontnik deployment ${deploymentId} ${now.toISOString()}\n`, { flag: 'wx' })
      return true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false
      throw error
    }
  }

  return {
    async acquire(deploymentId, now, isFinished) {
      if (await create(deploymentId, now)) return { acquired: true }
      const content = await readLock(path)
      if (content === undefined) return (await create(deploymentId, now)) ? { acquired: true } : { acquired: false, holder: 'human' }
      const owner = ownerOf(content)
      if (owner === undefined) return { acquired: false, holder: 'human' }
      if (owner === deploymentId) return { acquired: true }
      if (!(await isFinished(owner))) return { acquired: false, holder: 'doctor' }
      // Снимаем, только если за время проверки замок не сменился.
      if ((await readLock(path)) === content) await unlink(path).catch(() => {})
      return (await create(deploymentId, now)) ? { acquired: true } : { acquired: false, holder: 'human' }
    },

    async release(deploymentId) {
      const content = await readLock(path)
      if (content !== undefined && ownerOf(content) === deploymentId) await unlink(path).catch(() => {})
    },
  }
}
