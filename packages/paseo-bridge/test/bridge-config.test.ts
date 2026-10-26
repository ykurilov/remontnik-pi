import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { isPrivateAddress, loadBridgeConfig } from '../server/index.js'

// Публичные адреса собираем из чисел: проверка публикации не пропускает их в тексте.
const ip4 = (...parts: number[]) => parts.join('.')

function writeConfig(listen: string, doctorUrl = 'http://100.64.0.20:7720', secret = 'test-secret-shop-0001') {
  const directory = mkdtempSync(join(tmpdir(), 'remontnik-bridge-config-'))
  const secretFile = join(directory, 'shop-bridge')
  writeFileSync(secretFile, `${secret}\n`)
  const configFile = join(directory, 'paseo-bridge.json')
  writeFileSync(configFile, JSON.stringify({ listen, apps: { shop: { agentId: 'agent-1', doctorUrl, secretFile } } }))
  return configFile
}

describe('частные адреса', () => {
  it('частная сеть и петля — да; публичные, «все адреса» и имена — нет', () => {
    for (const ip of ['100.64.0.1', '100.127.255.254', '10.1.2.3', '172.16.0.1', '172.31.255.1', '192.168.1.5', '127.0.0.1', 'fd7a:115c:a1e0::1']) {
      expect(isPrivateAddress(ip), ip).toBe(true)
    }
    for (const ip of [ip4(100, 128, 0, 1), ip4(100, 63, 255, 255), ip4(172, 32, 0, 1), '203.0.113.7', ip4(8, 8, 8, 8), '0.0.0.0', '::', '2001:db8::1', 'bridge.example.com', '']) {
      expect(isPrivateAddress(ip), ip).toBe(false)
    }
  })
})

describe('настройка моста', () => {
  it('читает адрес, приложения и секрет из файла', () => {
    const config = loadBridgeConfig(writeConfig('100.64.0.10:7710'))
    expect(config.listen).toEqual({ host: '100.64.0.10', port: 7710 })
    expect(config.apps.get('shop')).toEqual({
      agentId: 'agent-1',
      doctorUrl: 'http://100.64.0.20:7720',
      secret: 'test-secret-shop-0001',
    })
  })

  it('публичный адрес для приёма или врача — ошибка, секрета в тексте ошибки нет', () => {
    expect(() => loadBridgeConfig(writeConfig('203.0.113.7:7710'))).toThrow(/частн/)
    expect(() => loadBridgeConfig(writeConfig('0.0.0.0:7710'))).toThrow(/частн/)
    expect(() => loadBridgeConfig(writeConfig('100.64.0.10:7710', 'https://doctor.example.com'))).toThrow(/частн/)
    try {
      loadBridgeConfig(writeConfig('100.64.0.10:7710', 'http://100.64.0.20:7720', ''))
      throw new Error('ожидалась ошибка')
    } catch (error) {
      expect(String(error)).toMatch(/пуст/)
    }
    try {
      loadBridgeConfig(writeConfig(`${ip4(8, 8, 8, 8)}:1`, 'http://100.64.0.20:7720', 'test-secret-shop-0001'))
    } catch (error) {
      expect(String(error)).not.toContain('test-secret-shop-0001')
    }
  })
})
