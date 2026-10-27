import { describe, expect, it } from 'vitest'
import { browserPolicyProblems, parseBrowserPolicy } from './index.js'

const base = { allowedOrigins: ['https://app.example.com'], allowedMutations: [], profiles: [{ name: 'remontnik' }] }

describe('настройка браузера: extraOrigins', () => {
  it('принимает точные origin в интернете', () => {
    const policy = parseBrowserPolicy({ ...base, extraOrigins: ['https://cdn.example.net', 'http://fonts.example.org:8080'] })
    expect(policy.extraOrigins).toEqual(['https://cdn.example.net', 'http://fonts.example.org:8080'])
    expect(parseBrowserPolicy(base).extraOrigins).toBeUndefined()
  })

  it('отклоняет пути, маски, другие схемы и внутренние адреса', () => {
    for (const bad of [
      'https://cdn.example.net/',
      'https://cdn.example.net/lib',
      'https://*.example.net',
      'ftp://cdn.example.net',
      'wss://cdn.example.net',
      'cdn.example.net',
      'http://localhost:8080',
      'http://app.localhost',
      'http://printer.local',
      'http://metadata.google.internal',
      'http://db',
      'http://127.0.0.1',
      'http://10.0.0.5',
      'http://192.168.1.10',
      'http://169.254.169.254',
      'http://[::1]',
      'http://[fd00::1]',
    ]) {
      expect(browserPolicyProblems({ ...base, extraOrigins: [bad] }), bad).toEqual([expect.stringMatching(/^extraOrigins\.0: /)])
    }
  })

  it('allowedOrigins может быть внутренним адресом: приложение бывает в частной сети', () => {
    expect(browserPolicyProblems({ ...base, allowedOrigins: ['http://10.0.0.5:3000'] })).toEqual([])
  })
})
