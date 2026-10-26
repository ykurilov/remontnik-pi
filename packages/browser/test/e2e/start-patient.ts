import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

// Один «Пациент» на весь прогон: у каждого теста своя служба браузера и свой профиль, то есть своя сессия.
export default async function startPatient(): Promise<() => Promise<void>> {
  const main = fileURLToPath(new URL('../../../../apps/patient/src/main.ts', import.meta.url))
  const child = spawn(process.execPath, [main], { env: { ...process.env, PORT: '0', HOST: '127.0.0.1', PATIENT_BUG: '' }, stdio: ['ignore', 'pipe', 'inherit'] })
  const url = await new Promise<string>((resolve, reject) => {
    let output = ''
    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString()
      const match = /listening on (http:\/\/[\d.]+:\d+)/.exec(output)
      if (match?.[1]) resolve(match[1])
    })
    child.once('exit', (code) => reject(new Error(`«Пациент» не запустился, код ${code}`)))
  })
  process.env.PATIENT_URL = url
  return async () => {
    child.kill('SIGTERM')
  }
}
