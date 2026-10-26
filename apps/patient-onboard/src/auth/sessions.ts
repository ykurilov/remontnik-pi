import { randomBytes } from 'node:crypto'

// Вход в кабинет. Учётка выдуманная и общая для всех копий «Пациента».
export const DEMO_LOGIN = 'demo@example.com'
export const DEMO_PASSWORD = 'patient-demo-password'
export const SESSION_COOKIE = 'patient_session'

export interface SessionStore {
  logIn(login: string, password: string): string | null
  isLoggedIn(cookieHeader: string | undefined): boolean
}

export function createSessionStore(): SessionStore {
  const sessions = new Set<string>()
  return {
    logIn(login, password) {
      if (login !== DEMO_LOGIN || password !== DEMO_PASSWORD) return null
      const sessionId = randomBytes(16).toString('hex')
      sessions.add(sessionId)
      return sessionId
    },
    isLoggedIn(cookieHeader) {
      const sessionId = (cookieHeader ?? '')
        .split(';')
        .map((part) => part.trim().split('='))
        .find(([name]) => name === SESSION_COOKIE)?.[1]
      return sessionId !== undefined && sessions.has(sessionId)
    },
  }
}
