// Образец команд выкатки для врача: build | promote | confirm | rollback | current | health.
// Вне договора с врачом: start (поднять упавшее приложение) и deploy <sha> (ручная выкатка под общим замком).
// ВАЖНО: образец запускает приложение процессом `node` рядом со скриптом. Так годится только для стенда и теста.
// В бою приложение запускают и перезапускают через `docker compose` (или systemd на хосте): замените startApp,
// stopApp и проверку pid в runVersion на вызовы compose, а `start` не нужен, его работу делает сам Docker.
// Положите файл в репозиторий приложения (например, deploy/remontnik-deploy.mjs) и укажите в remontnik.config:
//   deploy.commands = { build: 'node deploy/remontnik-deploy.mjs build', promote: '… promote', … }
// Всё состояние лежит в папке выкаток APP_DEPLOY_DIR (вне репозитория):
//   releases/<sha>, ссылка current, state.json, app.env (переменные приложения, строки ИМЯ=значение),
//   settings.json: { "healthUrl": "http://127.0.0.1:3000", "entry": "src/main.js", "lockFile": "<путь>", "startupTimeoutMs": 30000 }.
// APP_DEPLOY_DIR обязателен: без него скрипт отказывает. Папка должна быть доступна на запись тому, кто запускает команды
// (врач работает от uid 10001) и смонтирована в контейнер врача по тому же пути, что на хосте.
// Приложение должно отвечать на GET /health (код 200) и GET /version (JSON { "version": "<sha>" }).
// Только node: этого хватает врачу. Если сборка приложению нужна, добавьте её в build (шаг «подготовка» ниже).
import { spawn } from 'node:child_process'
import { closeSync, cpSync, existsSync, mkdirSync, readFileSync, readlinkSync, renameSync, rmSync, symlinkSync, writeFileSync, openSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const deployDir = process.env.APP_DEPLOY_DIR
if (!deployDir) {
  console.error('не задана переменная APP_DEPLOY_DIR: путь к папке выкаток (она должна быть смонтирована в контейнер врача и доступна ему на запись)')
  process.exit(2)
}
const releasesDir = join(deployDir, 'releases')
const currentLink = join(deployDir, 'current')
const statePath = join(deployDir, 'state.json')
const settings = existsSync(join(deployDir, 'settings.json')) ? JSON.parse(readFileSync(join(deployDir, 'settings.json'), 'utf8')) : {}
const healthUrl = settings.healthUrl ?? 'http://127.0.0.1:3000'
const entry = settings.entry ?? 'src/main.js'
const startupTimeoutMs = settings.startupTimeoutMs ?? 30_000
// Замок выкатки, общий с врачом (deploy.lockFile в настройке). Врач сам держит его на время своей выкатки и команды под ним не берут;
// замок берёт только ручная выкатка `deploy`. Путь по умолчанию — как в настройке образца, от рабочей папки.
const lockFile = settings.lockFile ?? join(process.cwd(), '.remontnik/deploy.lock')
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
  const child = spawn(process.execPath, [entry], {
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
  for (let i = 0; i < Math.ceil(startupTimeoutMs / 300); i += 1) {
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
    // Подготовка: зависимости берутся из общей папки на сервере; сборку (если она есть) выполните здесь.
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
    // Повтор promote (врач перезапустился): прежняя сборка остаётся той же, её нельзя заменить кандидатом.
    writeState({ ...state, previous: state.version === version ? state.previous : state.version, version, unconfirmed: true })
    if (!(await runVersion(version))) throw new Error('кандидат не отвечает')
  },
  async confirm() {
    writeState({ ...readState(), unconfirmed: false })
  },
  async rollback() {
    const state = readState()
    if (!state.previous) throw new Error('прежней сборки нет')
    // previous обнуляется только после успешного запуска: неудавшийся rollback можно повторить.
    writeState({ ...state, version: state.previous, unconfirmed: false })
    if (!(await runVersion(state.previous))) throw new Error('прежняя сборка не отвечает')
    writeState({ ...readState(), previous: null })
  },
  async current() {
    const state = readState()
    const version = (await runningVersion()) ?? (existsSync(currentLink) ? readlinkSync(currentLink).split('/').pop() : null)
    console.log(JSON.stringify({ version: SHA.test(version ?? '') ? version : null, previous: state.previous }))
  },
  // Не часть договора с врачом, только для стенда и теста: заменяет перезапускатель, которого у процесса `node` нет.
  // Сторож доставляет сбой, когда процесс поднимается снова. В бою эту роль играет Docker (`restart: unless-stopped`) или systemd.
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
  // Ручная выкатка: node deploy/remontnik-deploy.mjs deploy <полный sha>. Берёт тот же замок, что и врач, и снимает его в конце.
  async deploy() {
    const version = process.argv[3] ?? ''
    if (!SHA.test(version)) throw new Error('использование: deploy <полный sha>')
    mkdirSync(dirname(lockFile), { recursive: true })
    let descriptor
    try {
      descriptor = openSync(lockFile, 'wx') // создаётся только если замка нет
    } catch (error) {
      if (error.code === 'EEXIST') throw new Error('замок выкатки занят: идёт другая выкатка (врача или ручная)')
      throw error
    }
    closeSync(descriptor)
    try {
      process.env.REMONTNIK_VERSION = version
      await commands.build()
      await commands.promote()
      await commands.confirm()
    } finally {
      rmSync(lockFile, { force: true })
    }
  },
  async health() {
    const response = await fetch(`${healthUrl}/health`, { signal: AbortSignal.timeout(10_000) })
    if (!response.ok) throw new Error(`health ${response.status}`)
  },
}

const name = process.argv[2]
if (!commands[name]) {
  console.error('команда: build | promote | confirm | rollback | current | health | start | deploy <sha>')
  process.exit(2)
}
commands[name]().catch((error) => {
  console.error(error.message)
  process.exit(1)
})
