import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

// Память моста между перезапусками Paseo: переданные задачи и курсоры отчётов.
// Пишется целиком через временный файл и переименование — обрыв записи не портит прежнее состояние.

export type TaskStatus = 'queued' | 'delivered' | 'cancelled'

export interface TaskRecord {
  taskId: string
  appName: string
  caseId: number
  agentId: string
  status: TaskStatus
  receivedAt: string
}

interface StateShape {
  tasks: TaskRecord[]
  reportCursors: Record<string, number>
}

const MAX_TASKS = 500

export class BridgeStateStore {
  private state: StateShape

  constructor(private readonly file: string) {
    this.state = readState(file)
  }

  task(taskId: string): TaskRecord | undefined {
    return this.state.tasks.find((task) => task.taskId === taskId)
  }

  /** Последняя задача по случаю этого приложения. */
  taskForCase(app: string, caseId: number): TaskRecord | undefined {
    return this.state.tasks.findLast((task) => task.appName === app && task.caseId === caseId)
  }

  addTask(task: TaskRecord): void {
    this.state.tasks.push(task)
    if (this.state.tasks.length > MAX_TASKS) this.state.tasks.splice(0, this.state.tasks.length - MAX_TASKS)
    this.save()
  }

  setTaskStatus(taskId: string, status: TaskStatus): void {
    const task = this.task(taskId)
    if (!task) return
    task.status = status
    this.save()
  }

  reportCursor(app: string): number {
    return this.state.reportCursors[app] ?? 0
  }

  setReportCursor(app: string, cursor: number): void {
    this.state.reportCursors[app] = cursor
    this.save()
  }

  private save(): void {
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 })
    const temporary = `${this.file}.${process.pid}.tmp`
    writeFileSync(temporary, JSON.stringify(this.state), { mode: 0o600 })
    renameSync(temporary, this.file)
  }
}

function readState(file: string): StateShape {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<StateShape>
    return {
      tasks: Array.isArray(parsed.tasks) ? parsed.tasks : [],
      reportCursors: parsed.reportCursors && typeof parsed.reportCursors === 'object' ? parsed.reportCursors : {},
    }
  } catch {
    return { tasks: [], reportCursors: {} }
  }
}
