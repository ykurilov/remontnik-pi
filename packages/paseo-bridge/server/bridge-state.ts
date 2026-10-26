import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

// Память моста между перезапусками Paseo: переданные задачи и курсоры отчётов.
// Пишется целиком через временный файл и переименование — обрыв записи не портит прежнее состояние.
// Запись не удалась — изменение в памяти откатывается и ошибка пробрасывается: память не уходит вперёд файла.
// Испорченный файл откладывается в `.corrupt-<время>`; курсоры отчётов после этого ставятся на конец ленты врача.

export type TaskStatus = 'queued' | 'delivered' | 'cancelled'

export interface TaskRecord {
  taskId: string
  appName: string
  caseId: number
  agentId: string
  status: TaskStatus
  receivedAt: string
  /** Причина отмены — для письма «остановись», если отмена пришла во время отправки задачи. */
  cancelReason?: string
  /** Итог агента уже ушёл врачу. */
  resultSent?: boolean
}

interface StateShape {
  tasks: TaskRecord[]
  reportCursors: Record<string, number>
  /** Файл состояния был испорчен: курсоры приложений без записи ставятся на конец ленты врача. */
  cursorsLost?: boolean
}

const MAX_TASKS = 500

export type StateLog = (entry: Record<string, string | number | boolean | undefined>) => void

export class BridgeStateStore {
  private state: StateShape

  constructor(
    private readonly file: string,
    log: StateLog = () => {},
  ) {
    this.state = readState(file, log)
  }

  task(taskId: string): TaskRecord | undefined {
    return this.state.tasks.find((task) => task.taskId === taskId)
  }

  /** Последняя задача по случаю этого приложения. */
  taskForCase(app: string, caseId: number): TaskRecord | undefined {
    return this.state.tasks.findLast((task) => task.appName === app && task.caseId === caseId)
  }

  addTask(task: TaskRecord): void {
    this.commit((state) => {
      state.tasks.push(task)
      if (state.tasks.length > MAX_TASKS) state.tasks.splice(0, state.tasks.length - MAX_TASKS)
    })
  }

  /** Сменить статус, только если задача сейчас в статусе `from`. Возвращает, сменился ли он. */
  moveTask(taskId: string, from: TaskStatus, to: TaskStatus, extra: Partial<TaskRecord> = {}): boolean {
    const task = this.task(taskId)
    if (!task || task.status !== from) return false
    this.commit((state) => Object.assign(state.tasks.find((t) => t.taskId === taskId)!, { status: to, ...extra }))
    return true
  }

  markResultSent(taskId: string): void {
    this.commit((state) => {
      const task = state.tasks.find((t) => t.taskId === taskId)
      if (task) task.resultSent = true
    })
  }

  reportCursor(app: string): number {
    return this.state.reportCursors[app] ?? 0
  }

  /** Курсора приложения нет, а файл состояния был испорчен: старые отчёты не пересылать. */
  cursorLost(app: string): boolean {
    return this.state.cursorsLost === true && this.state.reportCursors[app] === undefined
  }

  setReportCursor(app: string, cursor: number): void {
    this.commit((state) => {
      state.reportCursors[app] = cursor
    })
  }

  private commit(mutation: (state: StateShape) => void): void {
    const next = structuredClone(this.state)
    mutation(next)
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 })
    const temporary = `${this.file}.${process.pid}.tmp`
    writeFileSync(temporary, JSON.stringify(next), { mode: 0o600 })
    renameSync(temporary, this.file)
    this.state = next
  }
}

function isTaskRecord(value: unknown): value is TaskRecord {
  const task = value as TaskRecord | null
  return (
    task !== null &&
    typeof task === 'object' &&
    typeof task.taskId === 'string' &&
    typeof task.appName === 'string' &&
    Number.isSafeInteger(task.caseId) &&
    typeof task.agentId === 'string' &&
    ['queued', 'delivered', 'cancelled'].includes(task.status)
  )
}

function parseState(text: string): StateShape | null {
  try {
    const parsed = JSON.parse(text) as Partial<StateShape> | null
    if (parsed === null || typeof parsed !== 'object') return null
    const { tasks, reportCursors, cursorsLost } = parsed
    if (!Array.isArray(tasks) || !tasks.every(isTaskRecord)) return null
    if (reportCursors === null || typeof reportCursors !== 'object' || Array.isArray(reportCursors)) return null
    if (!Object.values(reportCursors).every((cursor) => Number.isSafeInteger(cursor) && cursor >= 0)) return null
    return { tasks, reportCursors, ...(cursorsLost === true ? { cursorsLost } : {}) }
  } catch {
    return null
  }
}

function readState(file: string, log: StateLog): StateShape {
  if (!existsSync(file)) return { tasks: [], reportCursors: {} }
  const parsed = parseState(readFileSync(file, 'utf8'))
  if (parsed) return parsed
  const aside = `${file}.corrupt-${Date.now()}`
  renameSync(file, aside)
  log({ event: 'state_corrupt', movedTo: aside })
  return { tasks: [], reportCursors: {}, cursorsLost: true }
}
