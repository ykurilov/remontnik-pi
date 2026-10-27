import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const compose = readFileSync(new URL('../deploy/compose.remontnik.yml', import.meta.url), 'utf8')
const lines = compose.split('\n').filter((line) => !line.trim().startsWith('#'))

// Два врача на одном хосте не должны сталкиваться: имена проекта, контейнеров и внешней сети — переменные с прежними значениями по умолчанию.
describe('deploy/compose.remontnik.yml: имена задаются переменными', () => {
  it.each([
    ['name:', '${REMONTNIK_PROJECT:-remontnik}'],
    ['container_name: ${REMONTNIK_CONTAINER_NAME', '${REMONTNIK_CONTAINER_NAME:-remontnik-doctor}'],
    ['REMONTNIK_GATEWAY_CONTAINER:', '${REMONTNIK_CONTAINER_NAME:-remontnik-doctor}'],
    ['container_name: ${REMONTNIK_BROWSER_CONTAINER', '${REMONTNIK_BROWSER_CONTAINER:-remontnik-browser}'],
    ['REMONTNIK_BROWSER_URL:', 'http://${REMONTNIK_BROWSER_CONTAINER:-remontnik-browser}:7700'],
    ['REMONTNIK_DOCTOR_URL:', 'http://${REMONTNIK_DOCTOR_ALIAS:-remontnik-doctor-app}:7800'],
    ['aliases:', '["${REMONTNIK_DOCTOR_ALIAS:-remontnik-doctor-app}"]'],
    ['name: ${REMONTNIK_OUTSIDE_NETWORK', '${REMONTNIK_OUTSIDE_NETWORK:-remontnik-outside}'],
  ])('%s', (prefix, expected) => {
    expect(lines.some((line) => line.trim().startsWith(prefix) && line.includes(expected))).toBe(true)
  })

  it('подстановки в списках в скобках — в кавычках: иначе Docker Compose v5 не разбирает файл', () => {
    expect(lines.filter((line) => /\[\$\{/.test(line))).toEqual([])
  })

  it('жёстких имён контейнеров и сети нет', () => {
    expect(lines.filter((line) => /container_name: remontnik|name: remontnik-outside|GATEWAY_CONTAINER: remontnik|aliases: \[remontnik|DOCTOR_URL: http:\/\/remontnik/.test(line))).toEqual([])
  })
})

const hostApp = readFileSync(new URL('../deploy/compose.remontnik.host-app.yml', import.meta.url), 'utf8')
  .split('\n')
  .filter((line) => !line.trim().startsWith('#'))

// Приложение в сети сервера ходит к врачу через 127.0.0.1: порт только на петле и ведёт в сеть приёма.
describe('deploy/compose.remontnik.host-app.yml: приём на 127.0.0.1 сервера', () => {
  it('порт опубликован только на 127.0.0.1', () => {
    const ports = hostApp.filter((line) => /^\s*- .*:7800\s*$/.test(line))
    expect(ports).toEqual(['      - 127.0.0.1:${REMONTNIK_HOST_PORT:-7800}:7800'])
  })

  it('у сети приёма gw_priority, и её создаёт сам Ремонтник', () => {
    expect(hostApp.some((line) => line.trim() === 'gw_priority: 1')).toBe(true)
    expect(hostApp.some((line) => line.trim() === 'external: false')).toBe(true)
  })
})
