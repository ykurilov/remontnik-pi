import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { PATIENT_BUGS, parsePatientBug } from '../src/bugs.ts'
import { DEMO_LOGIN, DEMO_PASSWORD } from '../src/auth/sessions.ts'
import { createPatientServer, type PatientErrorReport, type PatientServerOptions } from '../src/server.ts'

const patientRoot = fileURLToPath(new URL('..', import.meta.url))

interface RunningPatient {
  url: string
  reports: PatientErrorReport[]
  crashes: Error[]
  close(): Promise<void>
}

let running: RunningPatient | undefined

async function startPatient(options: Omit<PatientServerOptions, 'reportError' | 'crashProcess'> = {}) {
  const reports: PatientErrorReport[] = []
  const crashes: Error[] = []
  const server = createPatientServer({
    ...options,
    reportError: (report) => reports.push(report),
    crashProcess: (error) => crashes.push(error),
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  running = {
    url: `http://127.0.0.1:${port}`,
    reports,
    crashes,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  }
  return running
}

afterEach(async () => {
  await running?.close()
  running = undefined
})

async function chat(patient: RunningPatient, message: string) {
  const response = await fetch(`${patient.url}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message }),
  })
  return { status: response.status, body: (await response.json()) as { reply?: string; error?: string } }
}

async function login(patient: RunningPatient, password = DEMO_PASSWORD) {
  return fetch(`${patient.url}/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ login: DEMO_LOGIN, password }).toString(),
    redirect: 'manual',
  })
}

describe('заложенные ошибки', () => {
  it('знает ровно семь ошибок и отклоняет неизвестную', () => {
    expect(PATIENT_BUGS).toEqual(['crash', 'model_error', 'tool_error', 'page_error', 'payment_error', 'worsening_fix', 'bad_answer'])
    expect(parsePatientBug(undefined)).toBeNull()
    expect(parsePatientBug('')).toBeNull()
    expect(parsePatientBug('tool_error')).toBe('tool_error')
    expect(() => parsePatientBug('nope')).toThrow(/PATIENT_BUG/)
  })
})

describe('«Пациент» без ошибок', () => {
  it('отдаёт главную, здоровье и версию', async () => {
    const patient = await startPatient({ version: 'abc123' })

    expect((await fetch(patient.url)).status).toBe(200)
    const health = await fetch(`${patient.url}/health`)
    expect(health.status).toBe(200)
    expect(await health.text()).toBe('ok')
    expect(await (await fetch(`${patient.url}/version`)).json()).toEqual({ version: 'abc123' })
    expect((await fetch(`${patient.url}/nope`)).status).toBe(404)
  })

  it('кабинет закрыт без входа', async () => {
    const patient = await startPatient()

    const response = await fetch(`${patient.url}/cabinet`, { redirect: 'manual' })

    expect(response.status).toBe(303)
    expect(response.headers.get('location')).toBe('/login')
  })

  it('страница входа с полем пароля и кнопкой «глаз»', async () => {
    const patient = await startPatient()

    const html = await (await fetch(`${patient.url}/login`)).text()

    expect(html).toContain('type="password"')
    expect(html).toContain('id="toggle-password"')
  })

  it('вход открывает кабинет, неверный пароль — нет', async () => {
    const patient = await startPatient()

    expect((await login(patient, 'wrong')).status).toBe(401)

    const response = await login(patient)
    expect(response.status).toBe(303)
    const cookie = response.headers.get('set-cookie') ?? ''
    expect(cookie).toMatch(/patient_session=[^;]+; .*HttpOnly/)

    const cabinet = await fetch(`${patient.url}/cabinet`, { headers: { cookie: cookie.split(';')[0] ?? '' } })
    expect(cabinet.status).toBe(200)
    expect(await cabinet.text()).toContain('Кабинет')
  })

  it('оплата: без входа — 401, со входом — квитанция', async () => {
    const patient = await startPatient()
    const pay = (cookie?: string) =>
      fetch(`${patient.url}/api/pay`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
        body: JSON.stringify({ plan: 'pro' }),
      })

    expect((await pay()).status).toBe(401)
    const cookie = ((await login(patient)).headers.get('set-cookie') ?? '').split(';')[0]
    const response = await pay(cookie)
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ ok: true, amountRub: 2990 })
  })

  it('чат: страница и ответы бота', async () => {
    const patient = await startPatient()

    expect(await (await fetch(`${patient.url}/chat`)).text()).toContain('id="chat-form"')
    expect((await chat(patient, 'Привет')).body.reply).toContain('Здравствуйте')
    expect((await chat(patient, 'Сколько стоит тариф Про?')).body.reply).toContain('2990')
    expect((await chat(patient, 'Сколько стоит?')).body.reply).toContain('990')
    expect((await chat(patient, 'Где мой заказ 42?')).body.reply).toContain('Заказ 42')
    expect((await chat(patient, 'Как дела?')).body.reply).toBeTruthy()
    expect(patient.reports).toEqual([])
  })

  it('пустое сообщение — 400', async () => {
    const patient = await startPatient()

    expect((await chat(patient, '  ')).status).toBe(400)
  })
})

describe('«Пациент» с заложенными ошибками', () => {
  it('model_error: 502 и сообщение об ошибке модели', async () => {
    const patient = await startPatient({ bug: 'model_error' })

    const { status } = await chat(patient, 'Как дела?')

    expect(status).toBe(502)
    expect(patient.reports).toEqual([
      expect.objectContaining({ kind: 'model_error', model: 'patient-fake-model', provider: 'patient-fake-provider' }),
    ])
  })

  it('tool_error: бот извиняется, ошибка инструмента записана', async () => {
    const patient = await startPatient({ bug: 'tool_error' })

    const { status, body } = await chat(patient, 'Где мой заказ 42?')

    expect(status).toBe(200)
    expect(body.reply).toContain('не получилось')
    expect(patient.reports).toEqual([expect.objectContaining({ kind: 'tool_error', tool: 'lookupOrder' })])
  })

  it('page_error: ошибка только в коде страницы, сервер здоров', async () => {
    const healthy = await startPatient()
    const healthyHtml = await (await fetch(`${healthy.url}/chat`)).text()
    await healthy.close()
    const broken = await startPatient({ bug: 'page_error' })

    const brokenHtml = await (await fetch(`${broken.url}/chat`)).text()

    expect(healthyHtml).not.toContain('#chat-form-missing')
    expect(brokenHtml).toContain('#chat-form-missing')
    expect((await chat(broken, 'Привет')).status).toBe(200)
    expect(broken.reports).toEqual([])
  })

  it('payment_error: 500 из кода оплаты', async () => {
    const patient = await startPatient({ bug: 'payment_error' })
    const cookie = ((await login(patient)).headers.get('set-cookie') ?? '').split(';')[0] ?? ''

    const response = await fetch(`${patient.url}/api/pay`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ plan: 'pro' }),
    })

    expect(response.status).toBe(500)
    expect(patient.reports).toEqual([expect.objectContaining({ kind: 'crash' })])
    expect(patient.reports[0]?.error.stack).toContain('src/payments/')
  })

  it('worsening_fix: вопрос о цене без тарифа валит ответ, с тарифом — работает', async () => {
    const patient = await startPatient({ bug: 'worsening_fix' })

    expect((await chat(patient, 'Сколько стоит тариф Про?')).body.reply).toContain('2990')
    expect((await chat(patient, 'Сколько стоит?')).status).toBe(500)
    expect(patient.reports).toEqual([expect.objectContaining({ kind: 'crash' })])
    expect(patient.reports[0]?.error.stack).toContain('src/bot/')
  })
})

describe('запуск процессом', () => {
  it('node src/main.ts слушает порт и отвечает на чат', async () => {
    const child = spawn(process.execPath, ['src/main.ts'], {
      cwd: patientRoot,
      env: {
        ...process.env,
        PORT: '0',
        HOST: '127.0.0.1',
        REMONTNIK_WATCH_DIR: mkdtempSync(join(tmpdir(), 'onboard-watch-')),
        REMONTNIK_DOCTOR_URL: 'http://127.0.0.1:9',
        REMONTNIK_SHARED_SECRET: 'test-secret-test-secret-test-secret-00',
        APP_ALERT_BOT_TOKEN: 'test-token',
        APP_ALERT_CHAT_ID: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const exited = new Promise<number | null>((resolve) => child.on('exit', resolve))
    let stderr = ''
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()))

    const url = await new Promise<string>((resolve, reject) => {
      let stdout = ''
      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString()
        const match = /listening on (http:\/\/\S+)/.exec(stdout)
        if (match?.[1]) resolve(match[1])
      })
      child.on('exit', () => reject(new Error(`процесс вышел до старта: ${stderr}`)))
    })

    expect((await fetch(`${url}/health`)).status).toBe(200)
    const chat = await fetch(`${url}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'Привет' }),
    })
    expect(chat.status).toBe(200)

    child.kill('SIGTERM')
    expect(await exited).toBe(0)
  })
})
