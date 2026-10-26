// Общее для команд `remontnik-doctor`: окружение и вывод передаются снаружи, чтобы команды проверялись без процесса.

export interface DoctorCommandIo {
  env: Record<string, string | undefined>
  stdout(text: string): void
  stderr(text: string): void
  fetch?: typeof fetch
}

/** Команду набрали неверно: код выхода 2 и справка. */
export class UsageError extends Error {}
