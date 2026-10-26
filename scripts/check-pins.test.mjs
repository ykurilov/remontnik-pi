import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { checkPins } from './check-pins.mjs'

let root

function writeJson(relativePath, data) {
  const full = join(root, relativePath)
  mkdirSync(join(full, '..'), { recursive: true })
  writeFileSync(full, JSON.stringify(data))
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'check-pins-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('checkPins', () => {
  it('не находит проблем, когда версии закреплены точно', () => {
    writeJson('packages/doctor/package.json', {
      dependencies: {
        '@earendil-works/pi-durable': '1.4.0',
        '@earendil-works/pi-ai': '1.4.0',
        '@earendil-works/chord': '1.4.0',
      },
    })
    expect(checkPins(root)).toEqual([])
  })

  it.each(['^1.4.0', '~1.4.0', '>=1.4.0', '1.x', '*', 'latest'])(
    'ругается на диапазон %s у pi-durable',
    (range) => {
      writeJson('packages/doctor/package.json', {
        dependencies: { '@earendil-works/pi-durable': range },
      })
      const problems = checkPins(root)
      expect(problems).toHaveLength(1)
      expect(problems[0]).toContain('@earendil-works/pi-durable')
      expect(problems[0]).toContain('packages/doctor/package.json')
    },
  )

  it('проверяет pi-ai и chord в devDependencies и peerDependencies', () => {
    writeJson('packages/doctor/package.json', {
      devDependencies: { '@earendil-works/pi-ai': '^1.4.0' },
      peerDependencies: { '@earendil-works/chord': '~1.4.0' },
    })
    expect(checkPins(root)).toHaveLength(2)
  })

  it('не трогает диапазоны у остальных пакетов', () => {
    writeJson('package.json', { devDependencies: { vitest: '^5.0.0' } })
    expect(checkPins(root)).toEqual([])
  })

  it('не заглядывает в node_modules', () => {
    writeJson('node_modules/x/package.json', {
      dependencies: { '@earendil-works/pi-durable': '^1.4.0' },
    })
    expect(checkPins(root)).toEqual([])
  })

  it.each([
    '.github/dependabot.yml',
    '.github/dependabot.yaml',
    'renovate.json',
    'renovate.json5',
    '.renovaterc',
    '.renovaterc.json',
    '.github/renovate.json',
  ])('ругается на настройки автообновления %s', (file) => {
    const full = join(root, file)
    mkdirSync(join(full, '..'), { recursive: true })
    writeFileSync(full, '{}')
    const problems = checkPins(root)
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain(file)
  })

  it('ругается на ключ renovate в package.json', () => {
    writeJson('package.json', { renovate: { extends: ['config:base'] } })
    expect(checkPins(root)).toHaveLength(1)
  })
})
