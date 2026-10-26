import { describe, expect, it } from 'vitest'
import { checkDanger, decideRequest, detectHumanCheck, isAllowedOrigin, matchesMutation } from './index.js'

const policy = {
  allowedOrigins: ['https://app.example.com', 'http://127.0.0.1:4100'],
  allowedMutations: [
    { method: 'POST', pathPattern: '/login' },
    { method: 'post', pathPattern: '/api/chat' },
    { method: 'PUT', pathPattern: '/api/drafts/*' },
    { method: '*', pathPattern: '/api/forms/**' },
  ],
}

describe('опасные действия', () => {
  it.each(['send', 'pay', 'delete', 'publish'])('%s отклоняется всегда', (danger) => {
    expect(checkDanger(danger)).toMatchObject({ ok: false, code: 'refused_danger' })
  })

  it.each(['none', 'submit'])('%s разрешено', (danger) => {
    expect(checkDanger(danger)).toEqual({ ok: true })
  })

  it('вид действия обязателен и только из списка', () => {
    expect(checkDanger(undefined)).toMatchObject({ ok: false, code: 'bad_request' })
    expect(checkDanger('transfer')).toMatchObject({ ok: false, code: 'bad_request' })
  })
})

describe('сайты', () => {
  it('разрешены только точные origin из allowedOrigins', () => {
    expect(isAllowedOrigin('https://app.example.com/cabinet?x=1', policy.allowedOrigins)).toBe(true)
    expect(isAllowedOrigin('http://127.0.0.1:4100/', policy.allowedOrigins)).toBe(true)
    expect(isAllowedOrigin('https://evil.example.com/', policy.allowedOrigins)).toBe(false)
    expect(isAllowedOrigin('https://app.example.com.evil.test/', policy.allowedOrigins)).toBe(false)
    expect(isAllowedOrigin('http://app.example.com/', policy.allowedOrigins)).toBe(false)
    expect(isAllowedOrigin('http://127.0.0.1:4101/', policy.allowedOrigins)).toBe(false)
    expect(isAllowedOrigin('javascript:alert(1)', policy.allowedOrigins)).toBe(false)
    expect(isAllowedOrigin('не адрес', policy.allowedOrigins)).toBe(false)
  })
})

describe('сетевой замок', () => {
  it('сопоставляет метод и путь из allowedMutations', () => {
    expect(matchesMutation('POST', 'https://app.example.com/login', policy)).toBe(true)
    expect(matchesMutation('POST', 'https://app.example.com/api/chat?draft=1', policy)).toBe(true)
    expect(matchesMutation('PUT', 'https://app.example.com/api/drafts/42', policy)).toBe(true)
    expect(matchesMutation('PUT', 'https://app.example.com/api/drafts/42/publish', policy)).toBe(false)
    expect(matchesMutation('DELETE', 'https://app.example.com/api/forms/a/b', policy)).toBe(true)
    expect(matchesMutation('POST', 'https://app.example.com/api/pay', policy)).toBe(false)
    expect(matchesMutation('GET', 'https://app.example.com/login', policy)).toBe(false)
    expect(matchesMutation('POST', 'https://evil.example.com/login', policy)).toBe(false)
  })

  it('пропускает чтение, режет изменения вне списка и переходы на чужие сайты', () => {
    const request = (method: string, url: string, navigation = false) => ({ method, url, isNavigation: navigation, isMainFrame: navigation })
    expect(decideRequest(request('GET', 'https://app.example.com/cabinet', true), policy)).toEqual({ allow: true })
    expect(decideRequest(request('GET', 'https://cdn.example.com/app.js'), policy)).toEqual({ allow: true })
    expect(decideRequest(request('POST', 'https://app.example.com/login', true), policy)).toEqual({ allow: true })
    expect(decideRequest(request('POST', 'https://app.example.com/api/pay'), policy)).toMatchObject({ allow: false, code: 'refused_mutation' })
    expect(decideRequest(request('POST', 'https://tracker.example.com/collect'), policy)).toMatchObject({ allow: false, code: 'refused_mutation' })
    expect(decideRequest(request('GET', 'https://evil.example.com/', true), policy)).toMatchObject({ allow: false, code: 'refused_origin' })
    expect(decideRequest(request('GET', 'about:blank', true), policy)).toEqual({ allow: true })
    expect(decideRequest(request('GET', 'data:text/html,hi', true), policy)).toMatchObject({ allow: false, code: 'refused_origin' })
    expect(decideRequest({ method: 'GET', url: 'https://widget.example.com/frame', isNavigation: true, isMainFrame: false }, policy)).toEqual({
      allow: true,
    })
  })
})

describe('капча и коды', () => {
  it('признаки капчи и одноразового кода → нужен человек', () => {
    expect(detectHumanCheck({ captchaElements: 1, oneTimeCodeFields: 0, text: '' })).toMatchObject({ needsHuman: true })
    expect(detectHumanCheck({ captchaElements: 0, oneTimeCodeFields: 1, text: '' })).toMatchObject({ needsHuman: true })
    expect(detectHumanCheck({ captchaElements: 0, oneTimeCodeFields: 0, text: 'Введите код из SMS' })).toMatchObject({ needsHuman: true })
    expect(detectHumanCheck({ captchaElements: 0, oneTimeCodeFields: 0, text: 'Мы отправили код подтверждения на почту' })).toMatchObject({
      needsHuman: true,
    })
    expect(detectHumanCheck({ captchaElements: 0, oneTimeCodeFields: 0, text: 'Enter the verification code' })).toMatchObject({ needsHuman: true })
  })

  it('обычная страница — без человека', () => {
    expect(detectHumanCheck({ captchaElements: 0, oneTimeCodeFields: 0, text: 'Кабинет. Ваш тариф: Старт. Код тарифа: PRO' })).toEqual({
      needsHuman: false,
    })
  })
})
