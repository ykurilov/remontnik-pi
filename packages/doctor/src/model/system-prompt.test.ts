import { describe, expect, it } from 'vitest'
import { buildRepoMap, buildSystemPrompt, SYSTEM_PROMPT_SECTIONS, type SystemPromptInput } from './system-prompt.js'

const files = ['src/server.ts', 'src/bot/bot.ts', 'README.md', 'secrets/key.txt', 'eval/run-eval.ts', 'src/payments/pay.ts']

function input(overrides: Partial<SystemPromptInput> = {}): SystemPromptInput {
  return {
    appName: 'patient',
    repoMap: buildRepoMap(files, { closedPaths: ['secrets/**'] }),
    closedPaths: ['secrets/**'],
    bashTimeoutSeconds: 600,
    base: 'running',
    ...overrides,
  }
}

describe('системный промпт врача', () => {
  it('секции идут в постоянном порядке', () => {
    const prompt = buildSystemPrompt(input())
    const positions = SYSTEM_PROMPT_SECTIONS.map((title) => prompt.indexOf(title))
    expect(positions.every((position) => position >= 0)).toBe(true)
    expect([...positions].sort((a, b) => a - b)).toEqual(positions)
  })

  it('для одной основы байты одинаковы при любом порядке файлов', () => {
    const first = buildSystemPrompt(input())
    const second = buildSystemPrompt(input({ repoMap: buildRepoMap([...files].reverse(), { closedPaths: ['secrets/**'] }) }))
    expect(second).toBe(first)
  })

  it('нет времени, даты и номера случая', () => {
    const prompt = buildSystemPrompt(input())
    expect(prompt).not.toMatch(/\d{4}-\d{2}-\d{2}/)
    expect(prompt).not.toMatch(/\d{1,2}:\d{2}/)
    expect(prompt).not.toMatch(/случай\s*№?\s*\d/i)
    expect(prompt).not.toContain(String(new Date().getFullYear()))
  })

  it('карта репозитория без закрытых путей, отсортирована', () => {
    const map = buildRepoMap(files, { closedPaths: ['secrets/**'] })
    expect(map).not.toContain('secrets')
    const lines = map.split('\n')
    expect(lines).toEqual([...lines].sort())
  })

  it('длинная карта обрезается с пометкой', () => {
    const many = Array.from({ length: 50 }, (_, index) => `src/file-${String(index).padStart(2, '0')}.ts`)
    const map = buildRepoMap(many, { closedPaths: [], maxEntries: 10 })
    expect(map.split('\n')).toHaveLength(11)
    expect(map).toContain('ещё 40')
  })

  it('про основу не врёт: рабочая версия — только когда она и есть основа', () => {
    expect(buildSystemPrompt(input({ base: 'running' }))).toContain('на коммите рабочей версии')
    const fallback = buildSystemPrompt(input({ base: 'main' }))
    expect(fallback).not.toContain('рабочей версии,')
    expect(fallback).toContain('основной ветки')
  })
})
