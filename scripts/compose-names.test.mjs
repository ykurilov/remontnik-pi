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
    ['name: ${REMONTNIK_OUTSIDE_NETWORK', '${REMONTNIK_OUTSIDE_NETWORK:-remontnik-outside}'],
  ])('%s', (prefix, expected) => {
    expect(lines.some((line) => line.trim().startsWith(prefix) && line.includes(expected))).toBe(true)
  })

  it('жёстких имён контейнеров и сети нет', () => {
    expect(lines.filter((line) => /container_name: remontnik|name: remontnik-outside|GATEWAY_CONTAINER: remontnik/.test(line))).toEqual([])
  })
})
