import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startDoctorService, type DoctorService } from '@ykurilov/remontnik-doctor'
import { startFakeTelegram, type FakeTelegramServer } from '@ykurilov/remontnik-core/testing'
import { createWatch, type Watch } from '@ykurilov/remontnik-watch'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { PatientBug } from '../../src/bugs.ts'
import { createPatientServer } from '../../src/server.ts'
import { reportToWatch } from './watch-glue.ts'

// История 1 на «Пациенте»: сбой → одно сообщение в Telegram и один случай у врача.

const secret = 'shared-test-secret'
const botToken = '123456:test-bot-token'
const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url))
const loader = join(repoRoot, 'scripts/source-loader/register.mjs')
const childEntry = fileURLToPath(new URL('./patient-with-watch.ts', import.meta.url))

let telegram: FakeTelegramServer
let watchDir: string
let stateDir: string
const cleanups: (() => Promise<void> | void)[] = []

async function startDoctor(port = 0): Promise<DoctorService> {
  const doctor = await startDoctorService({
    stateDir,
    sharedSecret: secret,
    listen: { host: '127.0.0.1', port },
    telegram: { botToken, chatId: 'owner-chat', apiBaseUrl: telegram.baseUrl },
    exit: () => {},
    log: () => {},
  })
  cleanups.push(() => doctor.close())
  return doctor
}

function openWatch(doctorUrl: string): Watch {
  const watch = createWatch({
    appName: 'patient',
    processName: 'web',
    dir: watchDir,
    doctor: { url: doctorUrl, secret },
    telegram: { botToken, chatId: 'owner-chat', apiBaseUrl: telegram.baseUrl },
  })
  cleanups.push(() => watch.close())
  return watch
}

async function startPatient(bug: PatientBug, watch: Watch): Promise<string> {
  const server = createPatientServer({ bug, reportError: reportToWatch(watch) })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())))
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

async function chat(url: string, message: string): Promise<Response> {
  return fetch(`${url}/api/chat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message }) })
}

async function until(condition: () => boolean | Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error('условие не выполнилось')
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

beforeEach(async () => {
  telegram = await startFakeTelegram()
  watchDir = mkdtempSync(join(tmpdir(), 'remontnik-us1-watch-'))
  stateDir = mkdtempSync(join(tmpdir(), 'remontnik-us1-doctor-'))
})

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  await telegram.close()
})

describe('История 1: сбой замечен и описан за минуту', () => {
  it('crash: процесс падает, случай не теряется, после перезапуска — сообщение и случай у врача', async () => {
    const doctor = await startDoctor()
    const child = spawn(process.execPath, ['--import', loader, '--no-warnings', childEntry], {
      env: {
        ...process.env,
        PATIENT_BUG: 'crash',
        REMONTNIK_WATCH_DIR: watchDir,
        DOCTOR_URL: 'http://127.0.0.1:9',
        REMONTNIK_SHARED_SECRET: secret,
        ALERT_BOT_TOKEN: botToken,
        TELEGRAM_API_BASE_URL: 'http://127.0.0.1:9',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const exited = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)))
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => (stdout += chunk))
    child.stderr.on('data', (chunk) => (stderr += chunk))
    await until(() => /listening \d+/.test(stdout), 20_000)
    const port = /listening (\d+)/.exec(stdout)?.[1]

    await chat(`http://127.0.0.1:${port}`, 'привет').catch(() => null)
    expect(await exited).toBe(1)
    expect(stderr).toContain('history store is closed')

    const started = Date.now()
    const restarted = openWatch(doctor.url)
    await until(async () => telegram.messages.length === 1 && (await doctor.caseBook.getCase(1)) !== undefined)

    expect(Date.now() - started).toBeLessThan(60_000)
    expect(telegram.messages[0]?.text).toContain('crash')
    expect(await doctor.caseBook.getCase(1)).toMatchObject({ kind: 'crash', events: 1 })
    expect(await restarted.flush(2000)).toBe(true)
  })

  it('repeat: 50 одинаковых сбоев инструмента — одно сообщение и один случай со счётчиком 50', async () => {
    const doctor = await startDoctor()
    const watch = openWatch(doctor.url)
    const patient = await startPatient('tool_error', watch)

    for (let index = 1; index <= 50; index += 1) {
      const response = await chat(patient, `где мой заказ ${index}?`)
      expect(response.status).toBe(200)
    }
    expect(await watch.flush(10_000)).toBe(true)

    expect(telegram.messages).toHaveLength(1)
    expect(telegram.messages[0]?.text).toContain('lookupOrder')
    expect(await doctor.caseBook.getCase(1)).toMatchObject({ kind: 'tool_error', events: 50 })
    expect(await doctor.caseBook.getCase(2)).toBeUndefined()
  })

  it('ошибка модели — одно сообщение и один случай model_error', async () => {
    const doctor = await startDoctor()
    const watch = openWatch(doctor.url)
    const patient = await startPatient('model_error', watch)

    expect((await chat(patient, 'расскажи что-нибудь')).status).toBe(502)
    expect(await watch.flush(5000)).toBe(true)

    expect(telegram.messages).toHaveLength(1)
    expect(await doctor.caseBook.getCase(1)).toMatchObject({ kind: 'model_error', events: 1 })
  })

  it('врач выключен: сообщение уходит сразу, случай доходит после включения', async () => {
    const firstRun = await startDoctor()
    const doctorUrl = firstRun.url
    const port = Number(new URL(doctorUrl).port)
    await firstRun.close()
    const watch = openWatch(doctorUrl)
    const patient = await startPatient('tool_error', watch)

    await chat(patient, 'где мой заказ 7?')
    await until(() => telegram.messages.length === 1)
    await until(() => watch.stats().queue.failedAttempts >= 1)
    expect(watch.stats().queue.pending).toBe(1)

    const doctor = await startDoctor(port)
    expect(await watch.flush(5000)).toBe(true)

    expect(await doctor.caseBook.getCase(1)).toMatchObject({ kind: 'tool_error', events: 1 })
    expect(telegram.messages).toHaveLength(1)
  })

  it('секрет в тексте ошибки вычищен из сообщения и случая', async () => {
    const doctor = await startDoctor()
    const watch = openWatch(doctor.url)
    const key = `sk-${'a1B2'.repeat(6)}`

    watch.capture(new Error(`provider rejected key ${key} for owner ivan@example.com`), { kind: 'model_error', where: 'chat' })
    expect(await watch.flush(5000)).toBe(true)

    const stored = await doctor.caseBook.getCase(1)
    const everything = JSON.stringify(telegram.messages) + JSON.stringify(stored)
    expect(everything).not.toContain(key)
    expect(everything).not.toContain('ivan@example.com')
    expect(stored?.message).toContain('[ключ]')
  })
})
