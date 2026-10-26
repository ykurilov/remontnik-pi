import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const rulesets = JSON.parse(readFileSync(new URL('../deploy/github-ruleset.json', import.meta.url), 'utf8'))

function ruleTypes(ruleset) {
  return ruleset.rules.map((rule) => rule.type)
}

describe('deploy/github-ruleset.json', () => {
  it('содержит два набора правил: ветка и метки', () => {
    expect(rulesets.map((ruleset) => ruleset.target).sort()).toEqual(['branch', 'tag'])
  })

  it('у каждого набора есть поля, которые требует GitHub', () => {
    for (const ruleset of rulesets) {
      expect(typeof ruleset.name).toBe('string')
      expect(ruleset.enforcement).toBe('active')
      expect(ruleset.bypass_actors).toEqual([])
      expect(ruleset.conditions.ref_name.include.length).toBeGreaterThan(0)
    }
  })

  it('основная ветка: запрет принудительной записи и удаления', () => {
    const branch = rulesets.find((ruleset) => ruleset.target === 'branch')
    expect(branch.conditions.ref_name.include).toEqual(['~DEFAULT_BRANCH'])
    expect(ruleTypes(branch).sort()).toEqual(['deletion', 'non_fast_forward'])
  })

  it('метки remontnik/**: запрет изменения и удаления, создание не запрещено', () => {
    const tag = rulesets.find((ruleset) => ruleset.target === 'tag')
    expect(tag.conditions.ref_name.include).toEqual(['refs/tags/remontnik/**'])
    expect(ruleTypes(tag).sort()).toEqual(['deletion', 'update'])
  })
})
