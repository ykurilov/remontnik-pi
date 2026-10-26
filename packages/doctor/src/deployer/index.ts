import { resolve } from 'node:path'
import type { RemontnikConfig } from '@ykurilov/remontnik-core/config'
import { GitGuardError, type GitGuard } from '../git-guard/index.js'
import { createAppCommands } from './app-commands.js'
import { createDeployer, type Deployer } from './deploy-sequence.js'
import { createDeployLock } from './lock.js'
import { createMainCopy } from './main-copy.js'

// Выкатка на сервере: команды приложения из его настройки, общий с ручной выкаткой файл замка, метка прежней
// версии и снимок рабочей копии через git-замок. Задача лечения (T070) зовёт `runDeploymentInTask` из service/harness.ts с этим выкатчиком.

export { createAppCommands, type AppCommands, type CurrentAnswer, type DeployCommands, type HealthAnswer } from './app-commands.js'
export {
  createDeployer,
  preDeployTagName,
  readDeployment,
  type Deployer,
  type DeployerDeps,
  type DeployIo,
  type Deployment,
  type DeployOutcome,
  type DeployRefusal,
  type DeployRequest,
  type DeployStage,
  type DeployStep,
} from './deploy-sequence.js'
export { createDeployLock, type DeployLock, type LockHolder } from './lock.js'
export { createMainCopy, mainCopyChange, type MainCopy, type MainCopySnapshot } from './main-copy.js'
export { OBSERVE_TICK_MS, type RollbackReason } from './observer.js'

/** Версия из `current` приложения идёт в git: только имя коммита или ветки, не ключ команды и не путь наверх. */
const VERSION = /^[0-9A-Za-z][0-9A-Za-z._/-]{0,200}$/

export interface ServerDeployerOptions {
  guard: GitGuard
  /** Настройка приложения из основной ветки. */
  loadConfig(): Promise<RemontnikConfig>
  /** Окружение команд выкатки; секреты врача из него убираются. */
  env?: NodeJS.ProcessEnv
}

export function createServerDeployer(options: ServerDeployerOptions): Deployer {
  const { guard } = options
  return createDeployer({
    loadConfig: options.loadConfig,
    commandsFor: (config) =>
      createAppCommands({ repoDir: guard.repoDir, commands: config.deploy.commands, buildEnv: config.deploy.buildEnv, ...(options.env ? { env: options.env } : {}) }),
    mainCopyFor: (config) => createMainCopy({ guard, deploy: config.deploy }),
    lockFor: (config) => createDeployLock(resolve(guard.repoDir, config.deploy.lockFile)),
    async tagPreDeploy(name, version) {
      if (!VERSION.test(version) || version.includes('..')) return { ok: false, reason: `версия «${version.slice(0, 80)}» — не имя коммита` }
      try {
        await guard.tagPreDeploy(name, await guard.resolve(version))
        return { ok: true }
      } catch (error) {
        if (error instanceof GitGuardError) return { ok: false, reason: error.message }
        throw error
      }
    },
  })
}
