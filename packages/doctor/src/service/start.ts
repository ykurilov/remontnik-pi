import { join } from 'node:path'
import type { RemontnikConfig } from '@ykurilov/remontnik-core/config'
import { containerAddress, createCaseNetworks, type CaseNetworks } from '../case-networks/index.js'
import { createCaseServices, type CaseServices } from '../case-services/index.js'
import { createServerDeployer } from '../deployer/index.js'
import { createEvalProxy, type EvalProxy } from '../eval-proxy/index.js'
import { createGitGuard } from '../git-guard/index.js'
import { assertOwnerSecrets, secretProblems } from '../intake/http-kit.js'
import { createDoctorModels } from '../model/provider-fallback.js'
import { createRegistryMirror, type RegistryMirror } from '../registry-mirror/index.js'
import { CASE_GATEWAY_HOST, createDockerRunner, removeOrphanWorkbenches, type CommandRunner, type DockerRunnerOptions } from '../workbench/index.js'
import { browserClientFromEnv } from '../browser-tools/index.js'
import { loadMainBranchConfig } from './config-source.js'
import { startDoctorService, type DoctorService, type DoctorServiceOptions, type DoctorTreatmentOptions } from './index.js'

// Боевой запуск врача (`remontnik-doctor start`): всё берётся из окружения сервера и настройки основной ветки.
// Команды модели и проверки идут только в контейнерах (`createDockerRunner`), у каждой копии случая — свои
// закрытые сети (`case-networks`). Врач подключается к ним сам: в сети верстака слушает зеркало реестра пакетов,
// в сети проверок — прокси eval. Там же поднимаются службы для тестов приложения (`case-services`).
// Приём событий сторожа слушает только адрес врача в сети приложения.

export type DoctorEnv = Readonly<Record<string, string | undefined>>

const DEFAULT_PORT = 7800
const DEFAULT_CASE_SUBNETS = '10.213.0.0/16'
export const MIRROR_PORT = 7801
export const EVAL_PROXY_PORT = 7810

function required(env: DoctorEnv, name: string): string {
  const value = env[name]?.trim()
  if (!value) throw new Error(`врачу нужна переменная ${name}`)
  return value
}

/** `host:port` или `[ipv6]:port`. */
export function parseListen(text: string, name: string): { host: string; port: number } {
  const match = /^(?:\[([^\]]+)\]|([^:[\]]+)):(\d{1,5})$/.exec(text.trim())
  const port = Number(match?.[3])
  if (!match || !Number.isInteger(port) || port > 65_535) throw new Error(`${name}: нужен адрес вида host:port, а не «${text}»`)
  return { host: (match[1] ?? match[2])!, port }
}

/** Переменные команд в сети верстака: pnpm, npm, yarn и corepack берут пакеты только через зеркало врача. */
export function caseWorkbenchEnv(): Record<string, string> {
  const mirror = `http://${CASE_GATEWAY_HOST}:${MIRROR_PORT}`
  return { npm_config_registry: `${mirror}/`, COREPACK_NPM_REGISTRY: mirror, npm_config_audit: 'false', npm_config_fund: 'false' }
}

/** Доступ git к origin по токену (HTTPS): заголовок через `GIT_CONFIG_*`, без записи в настройки репозитория. */
function gitTokenEnv(token: string | undefined): Record<string, string> {
  if (!token) return { GIT_TERMINAL_PROMPT: '0' }
  const basic = Buffer.from(`x-access-token:${token}`).toString('base64')
  return { GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.extraHeader', GIT_CONFIG_VALUE_0: `Authorization: Basic ${basic}` }
}

export interface DoctorStartPlan {
  /** Служба без исполнителя, прокси eval и служб для тестов: их создаёт `createCaseGateway`. */
  service: Omit<DoctorServiceOptions, 'treatment' | 'listen'> & { treatment: Omit<DoctorTreatmentOptions, 'runner' | 'evalProxy' | 'services'> }
  /** Где слушать приём событий: явный адрес или адрес врача в сети приложения. */
  listen: { host: string; port: number } | { network: string; port: number }
  runner: Omit<DockerRunnerOptions, 'caseNetworks' | 'workbenchEnv'>
  /** Контейнер врача и пул подсетей сетей случая. */
  gateway: { container: string; subnetPool: string }
}

function listenOf(env: DoctorEnv): DoctorStartPlan['listen'] {
  const explicit = env.REMONTNIK_LISTEN?.trim()
  if (explicit) {
    const listen = parseListen(explicit, 'REMONTNIK_LISTEN')
    // На всех адресах приём был бы виден и из сетей случая, где идёт чужой код.
    if (['0.0.0.0', '::'].includes(listen.host)) throw new Error('REMONTNIK_LISTEN: нельзя слушать все адреса — только адрес в сети приложения')
    return listen
  }
  const network = env.REMONTNIK_LISTEN_NETWORK?.trim()
  if (!network) throw new Error('врачу нужна REMONTNIK_LISTEN_NETWORK (сеть приложения) или REMONTNIK_LISTEN (адрес в ней)')
  const port = Number(env.REMONTNIK_LISTEN_PORT?.trim() || DEFAULT_PORT)
  if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new Error('REMONTNIK_LISTEN_PORT: нужен номер порта')
  return { network, port }
}

/**
 * Мост Paseo (`handoff.paseo`): адрес для моста в частной сети и секрет моста — лента отчётов и команды агента;
 * в режиме «сначала Paseo» ещё адрес самого моста — туда уходят случаи. Имена переменных — из настройки.
 */
function paseoBridgeOf(env: DoctorEnv, config: RemontnikConfig): Pick<DoctorServiceOptions, 'paseoBridge'> & { bridge?: NonNullable<DoctorServiceOptions['reportsFeed']>['bridge'] } {
  const paseo = config.handoff.paseo
  if (!paseo) return {}
  const bridge = { listen: parseListen(required(env, paseo.listenEnv), paseo.listenEnv), secret: required(env, paseo.bridgeSecretEnv), appName: config.app.name }
  if (config.handoff.mode !== 'paseo-first') return { bridge }
  return { bridge, paseoBridge: { url: required(env, paseo.bridgeUrlEnv) } }
}

/**
 * Настройка службы из окружения и настройки приложения. Без побочных действий: сети, зеркало и прокси eval
 * создаёт `createCaseGateway`, службу запускает `startDoctorFromEnv`.
 */
export function doctorStartPlan(env: DoctorEnv, config: RemontnikConfig, options: { log?: (line: string) => void } = {}): DoctorStartPlan {
  const repoDir = required(env, 'REMONTNIK_CONFIG_REPO_DIR')
  const stateDir = required(env, 'REMONTNIK_STATE_DIR')
  const worktreesDir = env.REMONTNIK_WORKTREES_DIR?.trim() || join(stateDir, 'worktrees')
  const gateway = { container: required(env, 'REMONTNIK_GATEWAY_CONTAINER'), subnetPool: env.REMONTNIK_CASE_SUBNETS?.trim() || DEFAULT_CASE_SUBNETS }
  // Пул проверяется сразу: ошибка видна до старта, а не на первом случае.
  createCaseNetworks({ gatewayContainer: gateway.container, subnetPool: gateway.subnetPool, attach: { workbench: async () => async () => {}, checks: async () => async () => {} } })
  const listen = listenOf(env)

  const telegram = config.reports.telegram
  const chatIdEnv = telegram.chatIdEnv
  if (!chatIdEnv) throw new Error('врачу нужен чат тревог: reports.telegram.chatIdEnv в настройке')
  const apiBaseUrl = telegram.apiBaseUrlEnv ? env[telegram.apiBaseUrlEnv]?.trim() : undefined
  const proxyToken = telegram.proxyTokenEnv ? env[telegram.proxyTokenEnv]?.trim() : undefined
  // Переход модели на запасной путь и обратно — в журнал врача.
  const model = createDoctorModels(env, options.log ? { log: options.log } : {})
  const browserClient = browserClientFromEnv(env)
  const reportsToken = env.REMONTNIK_REPORTS_TOKEN?.trim()
  const { bridge, paseoBridge } = paseoBridgeOf(env, config)
  const sharedSecret = required(env, 'REMONTNIK_SHARED_SECRET')
  // Секрет владельца снимает стоп-кран выкаток: утечка общего секрета не должна давать того же.
  const controlSecret = env.REMONTNIK_CONTROL_SECRET?.trim() || undefined
  const problems = secretProblems([
    { name: 'REMONTNIK_SHARED_SECRET', value: sharedSecret },
    { name: 'REMONTNIK_CONTROL_SECRET', value: controlSecret },
    ...(bridge ? [{ name: config.handoff.paseo!.bridgeSecretEnv, value: bridge.secret }] : []),
  ])
  if (problems.length > 0) throw new Error(`секреты врача: ${problems.join('; ')}`)
  assertOwnerSecrets({ secret: sharedSecret, controlSecret, bridgeSecret: bridge?.secret })

  const guard = createGitGuard({
    repoDir,
    worktreesDir,
    mainBranch: config.repo.mainBranch,
    mainline: config.repo.mainline,
    author: { name: env.REMONTNIK_GIT_AUTHOR_NAME?.trim() || 'Ремонтник', email: env.REMONTNIK_GIT_AUTHOR_EMAIL?.trim() || 'remontnik@example.invalid' },
    env: gitTokenEnv(env.REMONTNIK_GIT_TOKEN?.trim()),
  })
  const loadConfig = async () => (await loadMainBranchConfig({ mainCheckoutDirectory: repoDir, mainBranch: config.repo.mainBranch })).config

  return {
    listen,
    gateway,
    runner: {
      image: config.workbench.image,
      homesDir: join(stateDir, 'homes'),
      ...(env.REMONTNIK_WORKBENCH_MEMORY?.trim() ? { memory: env.REMONTNIK_WORKBENCH_MEMORY.trim() } : {}),
      ...(env.REMONTNIK_WORKBENCH_CPUS?.trim() ? { cpus: env.REMONTNIK_WORKBENCH_CPUS.trim() } : {}),
    },
    service: {
      stateDir,
      sharedSecret,
      ...(controlSecret ? { controlSecret } : {}),
      telegram: {
        botToken: required(env, telegram.botTokenEnv),
        chatId: required(env, chatIdEnv),
        ...(apiBaseUrl ? { apiBaseUrl } : {}),
        ...(proxyToken ? { proxyToken } : {}),
      },
      ...(reportsToken || bridge ? { reportsFeed: { ...(reportsToken ? { token: reportsToken } : {}), ...(bridge ? { bridge } : {}) } } : {}),
      ...(paseoBridge ? { paseoBridge } : {}),
      treatment: {
        guard,
        loadConfig,
        // Решение «выкатывать» выкатывает правку; без выкатчика оно закрывалось бы только отчётом.
        deployer: createServerDeployer({ guard, loadConfig, env }),
        worktreesDir,
        models: model.models,
        model: model.model,
        evalEnv: env,
        browser: { ...(browserClient ? { client: browserClient } : {}), env },
      },
    },
  }
}

export interface CaseGateway {
  runner: CommandRunner
  caseNetworks: CaseNetworks
  caseServices: CaseServices
  mirror: RegistryMirror
  evalProxy: EvalProxy
  close(): Promise<void>
}

/** Зеркало реестра, прокси eval и сети случая, к которым они подключаются; исполнитель команд поверх них. */
export async function createCaseGateway(plan: DoctorStartPlan, options: { docker?: string; log?: (line: string) => void } = {}): Promise<CaseGateway> {
  const mirror = createRegistryMirror({ publicUrl: `http://${CASE_GATEWAY_HOST}:${MIRROR_PORT}`, ...(options.log ? { log: options.log } : {}) })
  const evalProxy = await createEvalProxy({ port: EVAL_PROXY_PORT, publicUrl: `http://${CASE_GATEWAY_HOST}:${EVAL_PROXY_PORT}` })
  const listenerCloser = (listener: { close(): Promise<void> }) => () => listener.close()
  const caseNetworks = createCaseNetworks({
    ...(options.docker ? { docker: options.docker } : {}),
    gatewayContainer: plan.gateway.container,
    subnetPool: plan.gateway.subnetPool,
    attach: {
      workbench: async (ip) => listenerCloser(await mirror.listen(ip, MIRROR_PORT)),
      checks: async (ip) => listenerCloser(await evalProxy.listen(ip)),
    },
    ...(options.log ? { log: options.log } : {}),
  })
  const runner = createDockerRunner({ ...plan.runner, ...(options.docker ? { docker: options.docker } : {}), caseNetworks, workbenchEnv: caseWorkbenchEnv() })
  const caseServices = createCaseServices({ ...(options.docker ? { docker: options.docker } : {}), caseNetworks, ...(options.log ? { log: options.log } : {}) })
  return {
    runner,
    caseNetworks,
    caseServices,
    mirror,
    evalProxy,
    async close() {
      await caseNetworks.close()
      await mirror.close()
      await evalProxy.close()
    },
  }
}

/** Запуск врача из окружения сервера: настройка основной ветки, адрес приёма, сети случая, служба. */
export async function startDoctorFromEnv(env: DoctorEnv, options: { log?: (line: string) => void; docker?: string } = {}): Promise<DoctorService> {
  const repoDir = required(env, 'REMONTNIK_CONFIG_REPO_DIR')
  const mainBranch = env.REMONTNIK_MAIN_BRANCH?.trim() || 'main'
  const { config } = await loadMainBranchConfig({ mainCheckoutDirectory: repoDir, mainBranch })
  const plan = doctorStartPlan(env, config, options.log ? { log: options.log } : {})
  const listen = 'network' in plan.listen
    ? { host: await containerAddress(plan.gateway.container, plan.listen.network, options.docker), port: plan.listen.port }
    : plan.listen
  const gateway = await createCaseGateway(plan, options)
  let service: DoctorService
  try {
    // Сначала контейнеры верстака прошлого запуска (их команды обрываются) и службы для тестов, потом их сети.
    await removeOrphanWorkbenches({ homesDir: plan.runner.homesDir, ...(options.docker ? { docker: options.docker } : {}), ...(options.log ? { log: options.log } : {}) })
    await gateway.caseServices.removeStale()
    await gateway.caseNetworks.removeStale()
    service = await startDoctorService({
      ...plan.service,
      listen,
      treatment: { ...plan.service.treatment, runner: gateway.runner, evalProxy: gateway.evalProxy, services: gateway.caseServices },
      ...(options.log ? { log: options.log } : {}),
    })
  } catch (error) {
    await gateway.close()
    throw error
  }
  return {
    ...service,
    async close() {
      await service.close()
      await gateway.close()
    },
  }
}
