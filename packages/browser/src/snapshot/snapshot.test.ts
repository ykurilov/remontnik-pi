import { describe, expect, it } from 'vitest'
import { type SnapshotNode, fieldRefs, renderSnapshot } from './render.js'

// Дерево в том виде, в каком его отдаёт `page.ariaSnapshotJSON({ mode: 'ai' })` закреплённой версии.
const loginPage: SnapshotNode[] = [
  {
    role: 'generic',
    ref: 'e1',
    children: [
      { role: 'heading', name: 'Вход', level: 1, ref: 'e2' },
      { role: 'link', name: 'Чат', ref: 'e3', cursor: 'pointer', url: 'https://app.example.com/chat' },
      { role: 'generic', ref: 'e4', children: ['Почта', { role: 'textbox', name: 'Почта', ref: 'e5', text: 'bot@example.com' }] },
      { role: 'generic', ref: 'e6', children: ['Пароль', { role: 'textbox', name: 'Пароль', active: true, ref: 'e7', text: 'shown-after-eye-42' }] },
      { role: 'button', name: 'Показать пароль', ref: 'e8', text: '👁' },
      { role: 'checkbox', name: 'Запомнить', checked: true, ref: 'e9' },
      { role: 'iframe', ref: 'e10', children: [{ role: 'textbox', name: 'Код', ref: 'f1e2', text: 'frame-secret-9' }] },
    ],
  },
]

describe('снимок страницы', () => {
  it('пишет дерево с номерами элементов', () => {
    const text = renderSnapshot(loginPage, new Map())
    expect(text).toBe(
      [
        '- generic [ref=e1]:',
        '  - heading "Вход" [level=1] [ref=e2]',
        '  - link "Чат" [ref=e3]:',
        '    - /url: https://app.example.com/chat',
        '  - generic [ref=e4]:',
        '    - text: Почта',
        '    - textbox "Почта" [ref=e5]: bot@example.com',
        '  - generic [ref=e6]:',
        '    - text: Пароль',
        '    - textbox "Пароль" [active] [ref=e7]: shown-after-eye-42',
        '  - button "Показать пароль" [ref=e8]: 👁',
        '  - checkbox "Запомнить" [checked] [ref=e9]',
        '  - iframe [ref=e10]:',
        '    - textbox "Код" [ref=f1e2]: frame-secret-9',
      ].join('\n'),
    )
  })

  it('номера одного и того же элемента не меняются от разметки', () => {
    const first = renderSnapshot(loginPage, new Map())
    const second = renderSnapshot(loginPage, new Map([['e7', 'password']]))
    const refsOf = (text: string) => [...text.matchAll(/\[ref=(\w+)\]/g)].map((match) => match[1])
    expect(refsOf(second)).toEqual(refsOf(first))
  })

  it('значения полей пароля скрыты, даже если тип сменили на текст; вписанный пароль помечен', () => {
    const text = renderSnapshot(
      loginPage,
      new Map([
        ['e7', 'filled'],
        ['f1e2', 'password'],
      ]),
    )
    expect(text).not.toContain('shown-after-eye-42')
    expect(text).not.toContain('frame-secret-9')
    expect(text).toContain('textbox "Пароль" [active] [ref=e7] [пароль вписан]: [скрыто]')
    expect(text).toContain('textbox "Код" [ref=f1e2] [поле пароля]: [скрыто]')
    expect(text).toContain('textbox "Почта" [ref=e5]: bot@example.com')
  })

  it('пустое поле пароля помечено, но без значения', () => {
    const text = renderSnapshot([{ role: 'textbox', name: 'Пароль', ref: 'e3' }], new Map([['e3', 'password']]))
    expect(text).toBe('- textbox "Пароль" [ref=e3] [поле пароля]')
  })

  it('список полей ввода для проверки — все textbox с номерами, включая фреймы', () => {
    expect(fieldRefs(loginPage)).toEqual(['e5', 'e7', 'f1e2'])
  })

  it('кавычки в именах экранируются', () => {
    expect(renderSnapshot([{ role: 'button', name: 'Нажми "да"', ref: 'e1' }], new Map())).toBe('- button "Нажми \\"да\\"" [ref=e1]')
  })
})
