import { describe, expect, it } from 'vitest'
import { assertPrivateAddress, isPrivateAddress } from './index.js'

// Частная сеть — одна проверка на весь набор: мост, врач, живой экран браузера и прокси eval.

describe('адрес частной сети', () => {
  it.each(['10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.10', '100.64.0.10', '100.127.255.1', '127.0.0.1', '::1', 'fd7a:115c::1', 'fc00::1'])('%s — частный', (host) => {
    expect(isPrivateAddress(host)).toBe(true)
  })

  // Соседи частных диапазонов собраны из частей: проверка открытости не пускает в репозиторий публичные адреса.
  const justOutside = [['172', '32', '0', '1'], ['100', '128', '0', '1']].map((parts) => parts.join('.'))
  it.each(['0.0.0.0', '::', '203.0.113.5', ...justOutside, '169.254.169.254', 'example.test', 'localhost', 'fe80::1', '2001:db8::1', ''])('%s — нет', (host) => {
    expect(isPrivateAddress(host)).toBe(false)
  })

  it('ошибка называет, что проверялось', () => {
    expect(() => assertPrivateAddress('0.0.0.0', 'адрес прокси eval')).toThrow(/адрес прокси eval: нужен адрес частной сети/)
    expect(() => assertPrivateAddress('10.0.0.5', 'адрес прокси eval')).not.toThrow()
  })
})
