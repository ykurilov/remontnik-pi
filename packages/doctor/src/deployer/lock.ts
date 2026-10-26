import { randomBytes } from 'node:crypto'
import * as nodeFs from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

// Общий замок выкатки (contracts/deploy-commands.md): файл в репозитории приложения, общий для врача и человека.
// Врач пишет свою строку во временный файл и ставит его на место замка через `link`: замок появляется сразу целиком
// и только если его нет, поэтому две выкатки не начнутся разом. Строку врача узнаёт по номеру выкатки и её знаку;
// любое другое содержимое, в том числе пустое, — выкатка человека: такой замок врач ждёт и никогда не снимает.
//
// Снять файл «только если в нём всё ещё X» файловая система одним действием не умеет. Врач уводит замок под своё
// имя, сверяет и при расхождении возвращает. Если в этот миг место уже занял кто-то третий, увезённый замок не
// удаляется, а остаётся рядом как `<замок>.lost-*`, и врач зовёт человека: чужой замок не пропадает никогда.
// Если врач упал, пока замок был уведён в `<замок>.stale-*`, замок человека мог остаться только там: при таком
// файле рядом врач замок не берёт и не снимает, а ждёт, пока человек разберётся.

const OWN_LINE = /^remontnik deployment (\d+) (\S+) /

/** Чей замок: номер выкатки врача и её знак из записи выкатки. */
export interface LockHolder {
  deploymentId: number
  token: string
}

export type LockAttempt =
  | { acquired: true }
  /** `lost` — чужой замок, отложенный при гонке; `leftover` — `.stale-*` после падения врача, `content` — его. */
  | { acquired: false; holder: 'doctor' | 'human'; content: string; lost?: string; leftover?: string }

/** Что замку нужно от файловой системы; в проверках — подмена с гонкой. */
export type LockFs = Pick<typeof nodeFs, 'link' | 'mkdir' | 'readdir' | 'readFile' | 'rename' | 'unlink' | 'writeFile'>

export interface DeployLock {
  /**
   * Взять замок. Свой замок (врач перезапустился) — уже взят. Замок другой выкатки врача снимается, только если
   * `isStale` говорит, что та брошена: закончилась или её задача умерла.
   */
  acquire(holder: LockHolder, now: Date, isStale: (other: LockHolder) => Promise<boolean>): Promise<LockAttempt>
  /** Снять замок, только если он этой выкатки. `lost` — чужой замок, отложенный при гонке (см. выше). */
  release(holder: LockHolder): Promise<{ lost?: string }>
  /** Замок сейчас этой выкатки; только чтение. */
  holds(holder: LockHolder): Promise<boolean>
}

const ownerOf = (content: string): LockHolder | undefined => {
  const match = OWN_LINE.exec(content)
  return match ? { deploymentId: Number(match[1]), token: match[2]! } : undefined
}
const same = (a: LockHolder, b: LockHolder) => a.deploymentId === b.deploymentId && a.token === b.token
const lineOf = (holder: LockHolder, now: Date) => `remontnik deployment ${holder.deploymentId} ${holder.token} ${now.toISOString()}\n`
const aside = (path: string, why: string) => `${path}.${why}-${randomBytes(6).toString('hex')}`

export function createDeployLock(path: string, fs: LockFs = nodeFs): DeployLock {
  async function readLock(file: string): Promise<string | undefined> {
    try {
      return await fs.readFile(file, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
  }

  /** Уведённый для сверки замок, оставшийся после падения врача: `<замок>.stale-*`. */
  async function findLeftover(): Promise<string | undefined> {
    const prefix = `${basename(path)}.stale-`
    let names: string[]
    try {
      names = await fs.readdir(dirname(path))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
    const name = names.filter((other) => other.startsWith(prefix)).sort()[0]
    return name === undefined ? undefined : join(dirname(path), name)
  }

  /** Поставить замок целиком, если его нет. */
  async function create(line: string): Promise<boolean> {
    await fs.mkdir(dirname(path), { recursive: true })
    const draft = aside(path, 'new')
    await fs.writeFile(draft, line, { flag: 'wx' })
    try {
      await fs.link(draft, path)
      return true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false
      throw error
    } finally {
      await fs.unlink(draft).catch(() => {})
    }
  }

  /**
   * Убрать замок, только если в нём всё ещё `content`: увести под своё имя, сверить, при расхождении вернуть.
   * Вернуть не вышло (место заняли) — увезённый замок остаётся как `.lost-*`: его путь в ответе.
   */
  async function remove(content: string): Promise<{ lost?: string }> {
    const moved = aside(path, 'stale')
    try {
      await fs.rename(path, moved)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
      throw error
    }
    if ((await readLock(moved)) === content) {
      await fs.unlink(moved)
      return {}
    }
    try {
      await fs.link(moved, path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      const lost = aside(path, 'lost')
      await fs.rename(moved, lost)
      return { lost }
    }
    await fs.unlink(moved)
    return {}
  }

  const busy = (content: string, lost?: string): LockAttempt => ({
    acquired: false,
    holder: ownerOf(content) ? 'doctor' : 'human',
    content,
    ...(lost ? { lost } : {}),
  })

  return {
    async acquire(holder, now, isStale) {
      const leftover = await findLeftover()
      if (leftover) return { acquired: false, holder: 'human', content: (await readLock(leftover)) ?? '', leftover }
      const line = lineOf(holder, now)
      for (let attempt = 0; attempt < 3; attempt += 1) {
        if (await create(line)) return { acquired: true }
        const content = await readLock(path)
        if (content === undefined) continue
        const owner = ownerOf(content)
        if (owner && same(owner, holder)) return { acquired: true }
        if (!owner || !(await isStale(owner))) return busy(content)
        const { lost } = await remove(content)
        // Гонка: замок уже не тот, что решили снять, — дальше не пытаться, а сказать о ней.
        if (lost) return busy((await readLock(path)) ?? '', lost)
      }
      const content = await readLock(path)
      return content === undefined ? { acquired: false, holder: 'doctor', content: '' } : busy(content)
    },

    async release(holder) {
      const content = await readLock(path)
      const owner = content === undefined ? undefined : ownerOf(content)
      return content !== undefined && owner && same(owner, holder) ? remove(content) : {}
    },

    async holds(holder) {
      const content = await readLock(path)
      const owner = content === undefined ? undefined : ownerOf(content)
      return owner !== undefined && same(owner, holder)
    },
  }
}
