import assert from 'node:assert/strict'
import { test } from 'node:test'
import { greet } from '../src/greeting.js'

test('greet здоровается', () => {
  assert.equal(greet('Анна', { bug: null }), 'Здравствуйте, Анна!')
})
