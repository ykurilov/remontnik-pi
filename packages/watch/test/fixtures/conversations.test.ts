import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { loadConversations } from './conversations.js'

// Набор для проверки чтения разговоров: размечен верно и не содержит ничего настоящего (репозиторий открытый).

const directory = fileURLToPath(new URL('./conversations/', import.meta.url))
const KINDS = ['fabrication', 'rudeness', 'out_of_role', 'unanswered_question', 'cutoff', 'instruction_conflict']

describe('выдуманный набор разговоров', () => {
  const conversations = loadConversations()

  it('есть хорошие и плохие, по три плохих на каждый вид нарушения', () => {
    expect(conversations.filter((item) => item.label === 'good').length).toBeGreaterThanOrEqual(20)
    for (const kind of KINDS) {
      expect(conversations.filter((item) => item.category === kind)).toHaveLength(3)
    }
  })

  it('идентификаторы уникальны и совпадают с именами файлов', () => {
    const files = readdirSync(directory).filter((name) => name.endsWith('.json'))
    expect(conversations.map((item) => `${item.id}.json`).sort()).toEqual(files.sort())
  })

  it('плохой ответ указан на сообщение бота, у хороших разметки нарушения нет', () => {
    for (const item of conversations) {
      expect(item.messages.some((message) => message.role === 'assistant')).toBe(true)
      if (item.label === 'good') {
        expect(item.category).toBeUndefined()
        expect(item.badMessageIndex).toBeUndefined()
        continue
      }
      expect(KINDS).toContain(item.category)
      expect(item.messages[item.badMessageIndex ?? -1]?.role).toBe('assistant')
    }
  })

  it('адреса и домены только выдуманные: example.com, .test, .invalid', () => {
    const text = readdirSync(directory)
      .map((name) => readFileSync(`${directory}${name}`, 'utf8'))
      .join('\n')
    const domains = [...text.matchAll(/[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.(?:com|ru|org|net|io|cloud|test|invalid)\b/g)].map((match) => match[0])
    for (const domain of domains) expect(domain).toMatch(/(^|\.)example\.com$|\.test$|\.invalid$/)
    expect(text).not.toMatch(/https?:\/\//)
  })
})
