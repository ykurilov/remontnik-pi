// Команды выкатки для врача: build | promote | confirm | rollback | current | health.
// Всё состояние лежит в папке выкаток APP_DEPLOY_DIR (вне репозитория): releases/<sha>, ссылка current, state.json, app.env, settings.json.
// Только node, git и sh: этого набора хватает врачу.
import { spawn } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, readlinkSync, renameSync, rmSync, symlinkSync, writeFileSync, openSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const deployDir = process.env.APP_DEPLOY_DIR ?? '/srv/patient-onboard-deploy'
const releasesDir = join(deployDir, 'releases')
const currentLink = join(deployDir, 'current')
const statePath = join(deployDir, 'state.json')
const settings = existsSync(join(deployDir, 'settings.json')) ? JSON.parse(readFileSync(join(deployDir, 'settings.json'), 'utf8')) : {}
const healthUrl = settings.healthUrl ?? 'http://127.0.0.1:3900'
const SHA = /^[0-9a-f]{40}$/

const readState = () => (existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : { version: null, previous: null, unconfirmed: false, pid: null })
const writeState = (state) => {
  const tmp = `${statePath}.tmp`
  writeFileSync(tmp, JSON.stringify(state))
  renameSync(tmp, statePath)
}
const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

async function runningVersion() {
  try {
    const response = await fetch(`${healthUrl}/version`, { signal: AbortSignal.timeout(3000) })
    return response.ok ? (await response.json()).version : null
  } catch {
    return null
  }
}

function switchLink(version) {
  const tmp = `${currentLink}.new`
  rmSync(tmp, { force: true })
  symlinkSync(join(releasesDir, version), tmp)
  renameSync(tmp, currentLink) // rename над ссылкой атомарен и на Linux, и на macOS
}

function stopApp(pid) {
  if (!pid) return
  try {
    process.kill(pid, 'SIGTERM')
  } catch {}
}

async function waitStopped(pid) {
  for (let i = 0; i < 50 && pid; i += 1) {
    try {
      process.kill(pid, 0)
    } catch {
      return
    }
    await sleep(200)
  }
}

function startApp(version) {
  const env = { ...process.env }
  const envFile = join(deployDir, 'app.env')
  if (existsSync(envFile)) {
    for (const line of readFileSync(envFile, 'utf8').split('\n')) {
      const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim())
      if (match) env[match[1]] = match[2]
    }
  }
  const url = new URL(healthUrl)
  const log = openSync(join(deployDir, 'app.log'), 'a')
  const child = spawn(process.execPath, ['src/main.ts'], {
    cwd: join(releasesDir, version),
    env: { ...env, REMONTNIK_VERSION: version, PORT: url.port, HOST: url.hostname },
    detached: true,
    stdio: ['ignore', log, log],
  })
  child.unref()
  return child.pid
}

async function runVersion(version) {
  const state = readState()
  stopApp(state.pid)
  await waitStopped(state.pid)
  switchLink(version)
  const pid = startApp(version)
  writeState({ ...state, pid })
  for (let i = 0; i < 100; i += 1) {
    if ((await runningVersion()) === version) return true
    await sleep(300)
  }
  return false
}

const commands = {
  async build() {
    const version = process.env.REMONTNIK_VERSION ?? ''
    if (!SHA.test(version)) throw new Error('REMONTNIK_VERSION должен быть полным sha')
    const target = join(releasesDir, version)
    const staging = `${target}.build`
    rmSync(staging, { recursive: true, force: true })
    mkdirSync(releasesDir, { recursive: true })
    cpSync(appRoot, staging, { recursive: true, filter: (path) => !/(^|\/)(node_modules|\.git|\.deploy-state)(\/|$)/.test(path.slice(appRoot.length)) })
    // Зависимости берутся из общей папки на сервере.
    if (existsSync(join(deployDir, 'node_modules'))) symlinkSync(join(deployDir, 'node_modules'), join(staging, 'node_modules'))
    rmSync(target, { recursive: true, force: true })
    renameSync(staging, target)
    // promote версию не получает (REMONTNIK_ в его окружении нет): кандидата запоминает build.
    writeState({ ...readState(), candidate: version })
  },
  async promote() {
    const state = readState()
    const version = state.candidate ?? ''
    if (!SHA.test(version) || !existsSync(join(releasesDir, version))) throw new Error('нет собранного кандидата')
    writeState({ ...state, previous: state.version, version, unconfirmed: true })
    if (!(await runVersion(version))) throw new Error('кандидат не отвечает')
  },
  async confirm() {
    writeState({ ...readState(), unconfirmed: false })
  },
  async rollback() {
    const state = readState()
    if (!state.previous) throw new Error('прежней сборки нет')
    writeState({ ...state, version: state.previous, previous: null, unconfirmed: false })
    if (!(await runVersion(state.previous))) throw new Error('прежняя сборка не отвечает')
  },
  async current() {
    const state = readState()
    const version = (await runningVersion()) ?? (existsSync(currentLink) ? readlinkSync(currentLink).split('/').pop() : null)
    console.log(JSON.stringify({ version: SHA.test(version ?? '') ? version : null, previous: state.previous }))
  },
  // Не часть договора с врачом: роль перезапускателя (restart: unless-stopped, systemd). Сторож доставляет сбой, когда процесс поднимается снова.
  async start() {
    const state = readState()
    if (!state.version) throw new Error('нечего запускать')
    if (state.pid) {
      try {
        process.kill(state.pid, 0)
        return
      } catch {}
    }
    writeState({ ...state, pid: startApp(state.version) })
  },
  async health() {
    const response = await fetch(`${healthUrl}/health`, { signal: AbortSignal.timeout(10_000) })
    if (!response.ok) throw new Error(`health ${response.status}`)
  },
}

const name = process.argv[2]
if (!commands[name]) {
  console.error('команда: build | promote | confirm | rollback | current | health | start')
  process.exit(2)
}
commands[name]().catch((error) => {
  console.error(error.message)
  process.exit(1)
})
