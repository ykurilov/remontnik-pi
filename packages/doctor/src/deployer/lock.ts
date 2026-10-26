import { randomBytes } from 'node:crypto'
import { link, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

// Общий замок выкатки (contracts/deploy-commands.md): файл в репозитории приложения, общий для врача и человека.
// Врач пишет свою строку во временный файл и ставит его на место замка через `link`: замок появляется сразу целиком
// и только если его нет, поэтому две выкатки не начнутся разом. Строку врача узнаёт по номеру выкатки и её знаку;
// любое другое содержимое, в том числе пустое, — выкатка человека: такой замок врач ждёт и никогда не снимает.

const OWN_LINE = /^remontnik deployment (\d+) (\S+) /

/** Чей замок: номер выкатки врача и её знак из записи выкатки. */
export interface LockHolder {
  deploymentId: number
  token: string
}

export type LockAttempt = { acquired: true } | { acquired: false; holder: 'doctor' | 'human'; content: string }

export interface DeployLock {
  /**
   * Взять замок. Свой замок (врач перезапустился) — уже взят. Замок другой выкатки врача снимается, только если
   * `isStale` говорит, что та брошена: закончилась или её задача умерла.
   */
  acquire(holder: LockHolder, now: Date, isStale: (other: LockHolder) => Promise<boolean>): Promise<LockAttempt>
  /** Снять замок, только если он этой выкатки. */
  release(holder: LockHolder): Promise<void>
}

async function readLock(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

const ownerOf = (content: string): LockHolder | undefined => {
  const match = OWN_LINE.exec(content)
  return match ? { deploymentId: Number(match[1]), token: match[2]! } : undefined
}
const same = (a: LockHolder, b: LockHolder) => a.deploymentId === b.deploymentId && a.token === b.token
const lineOf = (holder: LockHolder, now: Date) => `remontnik deployment ${holder.deploymentId} ${holder.token} ${now.toISOString()}\n`
const aside = (path: string, why: string) => `${path}.${why}-${randomBytes(6).toString('hex')}`

export function createDeployLock(path: string): DeployLock {
  /** Поставить замок целиком, если его нет. */
  async function create(line: string): Promise<boolean> {
    await mkdir(dirname(path), { recursive: true })
    const draft = aside(path, 'new')
    await writeFile(draft, line, { flag: 'wx' })
    try {
      await link(draft, path)
      return true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false
      throw error
    } finally {
      await unlink(draft).catch(() => {})
    }
  }

  /** Убрать замок, только если в нём всё ещё `content`: сначала увести его под своё имя, потом сверить. */
  async function remove(content: string): Promise<void> {
    const moved = aside(path, 'stale')
    try {
      await rename(path, moved)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    if ((await readLock(moved)) !== content) {
      // Замок успели сменить: вернуть на место. Место уже заняли — тот замок новее, а увезённый был ничей.
      await link(moved, path).catch(() => {})
    }
    await unlink(moved).catch(() => {})
  }

  const busy = (content: string): LockAttempt => ({ acquired: false, holder: ownerOf(content) ? 'doctor' : 'human', content })

  return {
    async acquire(holder, now, isStale) {
      const line = lineOf(holder, now)
      for (let attempt = 0; attempt < 3; attempt += 1) {
        if (await create(line)) return { acquired: true }
        const content = await readLock(path)
        if (content === undefined) continue
        const owner = ownerOf(content)
        if (owner && same(owner, holder)) return { acquired: true }
        // Недописанная строка с номером и знаком этой выкатки — своя: знак есть только в её записи.
        if (!owner && content !== '' && `remontnik deployment ${holder.deploymentId} ${holder.token}`.startsWith(content)) {
          await remove(content)
          continue
        }
        if (!owner || !(await isStale(owner))) return busy(content)
        await remove(content)
      }
      const content = await readLock(path)
      return content === undefined ? { acquired: false, holder: 'doctor', content: '' } : busy(content)
    },

    async release(holder) {
      const content = await readLock(path)
      const owner = content === undefined ? undefined : ownerOf(content)
      if (content !== undefined && owner && same(owner, holder)) await remove(content)
    },
  }
}
