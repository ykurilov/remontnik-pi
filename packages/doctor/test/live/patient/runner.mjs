// «Пациент» в контейнере живой группы: присмотр за процессом и сам процесс со сторожем.
// Присмотр (без аргументов) держит процесс на версии из $PATIENT_DEPLOY_ROOT/current и перезапускает его, когда
// выкатка переставила ссылку current, — так на настоящем сервере делают systemd или pm2.
// Процесс (`child <папка версии>`) поднимает сервер «Пациента» из этой версии и отдаёт его сбои сторожу.
import { spawn } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { basename, join } from 'node:path'
import { pathToFileURL } from 'node:url'

const PORT = 3000
const [mode, releaseDir] = process.argv.slice(2)

function required(name) {
  const value = process.env[name]
  if (!value) throw new Error(`нужна переменная ${name}`)
  return value
}

function supervise() {
  const current = join(required('PATIENT_DEPLOY_ROOT'), 'current')
  let running = null
  const alive = () => running !== null && running.child.exitCode === null && running.child.signalCode === null
  const tick = () => {
    let dir = null
    try {
      dir = realpathSync(current)
    } catch {}
    if (alive() && running.dir === dir) return
    // Версия сменилась: сначала старый процесс уходит, новый поднимется на следующем тике.
    if (alive()) return void running.child.kill('SIGTERM')
    if (dir === null) return
    console.log(`[присмотр] запускаю ${basename(dir)}`)
    running = { dir, child: spawn(process.execPath, [process.argv[1], 'child', dir], { stdio: 'inherit' }) }
  }
  const timer = setInterval(tick, 500)
  tick()
  process.on('SIGTERM', () => {
    clearInterval(timer)
    if (alive()) running.child.once('exit', () => process.exit(0)).kill('SIGTERM')
    else process.exit(0)
  })
}

async function child(dir) {
  const { createWatch } = await import('/runner/dist/index.js')
  const { createPatientServer } = await import(pathToFileURL(join(dir, 'src/server.ts')).href)
  const watch = createWatch({
    appName: 'patient',
    processName: 'web',
    appRoot: dir,
    dir: '/tmp/watch',
    doctor: { url: required('DOCTOR_URL'), secret: required('REMONTNIK_SHARED_SECRET') },
    telegram: { botToken: required('ALERT_BOT_TOKEN'), chatId: required('ALERT_CHAT_ID'), apiBaseUrl: required('TELEGRAM_API_BASE_URL') },
  })
  watch.installProcessHandlers()
  // Как в apps/patient/test/cycle/watch-glue.ts: так же подключается любое приложение.
  const reportError = (report) => {
    if (report.kind === 'crash') watch.capture(report.error, { kind: 'crash', context: { request: report.where } })
    else if (report.kind === 'model_error') watch.capture(report.error, { kind: 'model_error', where: report.model, context: { model: report.model, provider: report.provider } })
    else watch.capture(report.error, { kind: 'tool_error', where: report.tool, context: { tool: report.tool } })
  }
  const server = createPatientServer({ bug: null, version: basename(dir), reportError })
  server.listen(PORT, '0.0.0.0', () => console.log(`[пациент] ${basename(dir)} слушает ${PORT}`))
  process.on('SIGTERM', () => {
    server.close()
    void watch.flush(5_000).finally(() => process.exit(0))
  })
}

if (mode === 'child') await child(releaseDir)
else supervise()
