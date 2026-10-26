import { join } from 'node:path'
import type { RemontnikConfig } from '@ykurilov/remontnik-core/config'
import { createGitGuard } from '../git-guard/index.js'
import { createDoctorModels } from '../model/provider-fallback.js'
import { assertInternalDockerNetwork, createDockerRunner } from '../workbench/index.js'
import { loadMainBranchConfig } from './config-source.js'
import { startDoctorService, type DoctorService, type DoctorServiceOptions } from './index.js'

// Боевой запуск врача (`remontnik-doctor start`): всё берётся из окружения сервера и настройки основной ветки.
// Команды модели и проверки идут только в контейнерах (`createDockerRunner`). Сеть верстака и сеть проверок
// должны быть закрытыми сетями Docker (`internal: true`): врач проверяет это до старта и иначе не запускается.
// Наружу из сети верстака ведёт только прокси выхода к реестру пакетов (`REMONTNIK_EGRESS_PROXY_URL`).

export type DoctorEnv = Readonly<Record<string, string | undefined>>

const DEFAULT_LISTEN = '0.0.0.0:7800'

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

/** Переменные прокси выхода для команд в сети верстака: их читают pnpm, npm, corepack, curl и `fetch` Node. */
export function egressProxyEnv(proxyUrl: string): Record<string, string> {
  const url = new URL(proxyUrl)
  if (url.protocol !== 'http:' || url.username || url.password || (url.pathname !== '/' && url.pathname !== '')) {
    throw new Error('REMONTNIK_EGRESS_PROXY_URL: нужен адрес вида http://host:port')
  }
  const value = url.origin
  return { HTTPS_PROXY: value, https_proxy: value, HTTP_PROXY: value, http_proxy: value, NO_PROXY: '', no_proxy: '', NODE_USE_ENV_PROXY: '1' }
}

/** Доступ git к origin по токену (HTTPS): заголовок через `GIT_CONFIG_*`, без записи в настройки репозитория. */
function gitTokenEnv(token: string | undefined): Record<string, string> {
  if (!token) return { GIT_TERMINAL_PROMPT: '0' }
  const basic = Buffer.from(`x-access-token:${token}`).toString('base64')
  return { GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.extraHeader', GIT_CONFIG_VALUE_0: `Authorization: Basic ${basic}` }
}

export interface DoctorStartPlan {
  service: DoctorServiceOptions
  /** Сети, которые должны быть закрытыми (`internal: true`). */
  networks: { workbench: string; checks: string }
}

/**
 * Настройка службы из окружения и настройки приложения. Без побочных действий: сети проверяет и службу
 * запускает `startDoctorFromEnv`.
 */
export function doctorStartPlan(env: DoctorEnv, config: RemontnikConfig): DoctorStartPlan {
  const repoDir = required(env, 'REMONTNIK_CONFIG_REPO_DIR')
  const stateDir = required(env, 'REMONTNIK_STATE_DIR')
  const worktreesDir = env.REMONTNIK_WORKTREES_DIR?.trim() || join(stateDir, 'worktrees')
  const workbenchNetwork = required(env, 'REMONTNIK_WORKBENCH_NETWORK')
  const checksNetwork = required(env, 'REMONTNIK_CHECKS_NETWORK')
  for (const network of [workbenchNetwork, checksNetwork]) {
    if (['bridge', 'host', 'default'].includes(network)) throw new Error(`сеть «${network}» не годится для верстака: нужна закрытая сеть Docker (internal: true)`)
  }
  if (workbenchNetwork === checksNetwork) throw new Error('сеть верстака и сеть проверок должны быть разными: в сети проверок нет прокси выхода')

  const telegram = config.reports.telegram
  const chatIdEnv = telegram.chatIdEnv
  if (!chatIdEnv) throw new Error('врачу нужен чат тревог: reports.telegram.chatIdEnv в настройке')
  const apiBaseUrl = telegram.apiBaseUrlEnv ? env[telegram.apiBaseUrlEnv]?.trim() : undefined
  const proxyToken = telegram.proxyTokenEnv ? env[telegram.proxyTokenEnv]?.trim() : undefined

  const egressProxyUrl = env.REMONTNIK_EGRESS_PROXY_URL?.trim()
  const runner = createDockerRunner({
    image: config.workbench.image,
    homesDir: join(stateDir, 'homes'),
    network: workbenchNetwork,
    internalNetwork: checksNetwork,
    ...(egressProxyUrl ? { outsideEnv: egressProxyEnv(egressProxyUrl) } : {}),
    ...(env.REMONTNIK_WORKBENCH_MEMORY?.trim() ? { memory: env.REMONTNIK_WORKBENCH_MEMORY.trim() } : {}),
    ...(env.REMONTNIK_WORKBENCH_CPUS?.trim() ? { cpus: env.REMONTNIK_WORKBENCH_CPUS.trim() } : {}),
  })
  const model = createDoctorModels(env)
  const evalProxyListen = env.REMONTNIK_EVAL_PROXY_LISTEN?.trim()
  const evalProxyUrl = env.REMONTNIK_EVAL_PROXY_URL?.trim()
  const reportsToken = env.REMONTNIK_REPORTS_TOKEN?.trim()

  return {
    networks: { workbench: workbenchNetwork, checks: checksNetwork },
    service: {
      stateDir,
      sharedSecret: required(env, 'REMONTNIK_SHARED_SECRET'),
      listen: parseListen(env.REMONTNIK_LISTEN?.trim() || DEFAULT_LISTEN, 'REMONTNIK_LISTEN'),
      telegram: {
        botToken: required(env, telegram.botTokenEnv),
        chatId: required(env, chatIdEnv),
        ...(apiBaseUrl ? { apiBaseUrl } : {}),
        ...(proxyToken ? { proxyToken } : {}),
      },
      ...(reportsToken ? { reportsFeed: { token: reportsToken } } : {}),
      treatment: {
        guard: createGitGuard({
          repoDir,
          worktreesDir,
          mainBranch: config.repo.mainBranch,
          mainline: config.repo.mainline,
          author: { name: env.REMONTNIK_GIT_AUTHOR_NAME?.trim() || 'Ремонтник', email: env.REMONTNIK_GIT_AUTHOR_EMAIL?.trim() || 'remontnik@example.invalid' },
          env: gitTokenEnv(env.REMONTNIK_GIT_TOKEN?.trim()),
        }),
        loadConfig: async () => (await loadMainBranchConfig({ mainCheckoutDirectory: repoDir, mainBranch: config.repo.mainBranch })).config,
        worktreesDir,
        models: model.models,
        model: model.model,
        runner,
        evalEnv: env,
        ...(evalProxyListen ? { evalProxy: { listen: parseListen(evalProxyListen, 'REMONTNIK_EVAL_PROXY_LISTEN'), ...(evalProxyUrl ? { publicUrl: evalProxyUrl } : {}) } } : {}),
      },
    },
  }
}

/** Запуск врача из окружения сервера: настройка основной ветки, проверка сетей Docker, служба. */
export async function startDoctorFromEnv(env: DoctorEnv, options: { log?: (line: string) => void; docker?: string } = {}): Promise<DoctorService> {
  const repoDir = required(env, 'REMONTNIK_CONFIG_REPO_DIR')
  const mainBranch = env.REMONTNIK_MAIN_BRANCH?.trim() || 'main'
  const { config } = await loadMainBranchConfig({ mainCheckoutDirectory: repoDir, mainBranch })
  const plan = doctorStartPlan(env, config)
  await assertInternalDockerNetwork(plan.networks.workbench, options.docker)
  await assertInternalDockerNetwork(plan.networks.checks, options.docker)
  return startDoctorService({ ...plan.service, ...(options.log ? { log: options.log } : {}) })
}
