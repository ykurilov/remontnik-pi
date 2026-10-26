import { execFile } from 'node:child_process'
import type { RemontnikConfig } from '@ykurilov/remontnik-core/config'

// Рабочая версия приложения: команда `deploy.commands.current` из настройки основной ветки печатает
// `{"version":"<sha>","previous":"<sha>"|null}`. Команда — приложения, не модели: идёт на сервере
// в основной копии репозитория, с тайм-аутом. Не вышло — `undefined`, и врач лечит от основной ветки.

const CURRENT_TIMEOUT_MS = 30_000

export function createCurrentVersionReader(repoDir: string, timeoutMs = CURRENT_TIMEOUT_MS) {
  return (config: RemontnikConfig): Promise<string | undefined> =>
    new Promise((resolve) => {
      execFile('/bin/sh', ['-c', config.deploy.commands.current], { cwd: repoDir, timeout: timeoutMs, maxBuffer: 64 * 1024 }, (error, stdout) => {
        if (error) return resolve(undefined)
        try {
          const parsed = JSON.parse(stdout.trim()) as { version?: unknown }
          resolve(typeof parsed.version === 'string' && parsed.version !== '' ? parsed.version : undefined)
        } catch {
          resolve(undefined)
        }
      })
    })
}
