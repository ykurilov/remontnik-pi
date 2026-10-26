import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { checkPublicInEveryCommit, findPrivateInHistory } from './check-history.mjs'

let repository

function git(...args) {
  execFileSync('git', ['-C', repository, '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { stdio: 'ignore' })
}

function commitFile(path, text) {
  mkdirSync(join(repository, path, '..'), { recursive: true })
  writeFileSync(join(repository, path), text)
  git('add', '-f', path)
  git('commit', '-q', '-m', `add ${path}`)
}

beforeEach(() => {
  repository = mkdtempSync(join(tmpdir(), 'check-history-'))
  git('init', '-q', '-b', 'main')
})

afterEach(() => {
  rmSync(repository, { recursive: true, force: true })
})

describe('findPrivateInHistory', () => {
  it('чистая история — пусто', () => {
    commitFile('README.md', 'привет')
    expect(findPrivateInHistory(repository)).toEqual([])
  })

  it('находит .private/, даже если файл потом удалён', () => {
    commitFile('.private/notes.md', 'заметки')
    git('rm', '-q', '-r', '.private')
    git('commit', '-q', '-m', 'remove')
    expect(findPrivateInHistory(repository)).toEqual(['.private/notes.md'])
  })
})

describe('checkPublicInEveryCommit', () => {
  it('находит адрес, который был в старом коммите, хотя из последнего его убрали', () => {
    // Адрес собран из частей, чтобы сам тест не срабатывал на check-public.
    commitFile('a.md', `сервер ${['8', '8', '4', '4'].join('.')}`)
    commitFile('a.md', 'сервер скрыт')
    const problems = checkPublicInEveryCommit(repository)
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain('публичный IPv4-адрес')
  })
})
