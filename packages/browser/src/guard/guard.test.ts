import { describe, expect, it } from 'vitest'
import { checkDanger, dangerInText, decideRequest, detectHumanCheck, isAllowedOrigin, isLoginOrigin, isAllowedFrameUrl, matchesMutation, siteOf } from './index.js'

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
    const frame = (url: string) => ({ method: 'GET', url, isNavigation: true, isMainFrame: false })
    expect(decideRequest(frame('https://widget.example.com/frame'), policy)).toMatchObject({ allow: false, code: 'refused_frame' })
    expect(decideRequest(frame('https://app.example.com/frame'), policy)).toEqual({ allow: true })
    expect(decideRequest(frame('about:blank'), policy)).toEqual({ allow: true })
  })

  it('после входа паролем любой запрос вне allowedOrigins и extraOrigins закрыт — и GET картинки или скрипта', () => {
    const request = (method: string, url: string) => ({ method, url, isNavigation: false, isMainFrame: false, sessionLocked: true })
    expect(decideRequest(request('GET', 'https://cdn.example.com/pixel.gif?p=secret'), policy)).toMatchObject({ allow: false, code: 'refused_leak' })
    expect(decideRequest(request('HEAD', 'https://cdn.example.com/x'), policy)).toMatchObject({ allow: false, code: 'refused_leak' })
    expect(decideRequest(request('GET', 'data:image/gif;base64,R0lGOD'), policy)).toEqual({ allow: true })
    expect(decideRequest(request('GET', 'https://app.example.com/app.js'), policy)).toEqual({ allow: true })
    expect(decideRequest(request('POST', 'https://app.example.com/login'), policy)).toEqual({ allow: true })
    // Владельцу — сайт, что вписать в extraOrigins; в причине для модели адреса нет.
    const pixel = decideRequest(request('GET', 'https://cdn.example.com/x'), policy)
    expect(pixel).toMatchObject({ domain: 'example.com', reason: expect.stringContaining('extraOrigins') })
    expect(JSON.stringify(pixel)).not.toContain('cdn.example.com')
    expect(pixel).not.toHaveProperty('suspect')
    // Запись и переход на другой сайт после входа — тоже без адреса; запись — подозрение на утечку.
    expect(decideRequest(request('POST', 'https://tracker.example.com/collect'), policy)).toMatchObject({ code: 'refused_leak', domain: 'example.com', suspect: 'POST на другой сайт' })
    const away = decideRequest({ ...request('GET', 'https://evil.example.com/p'), isNavigation: true, isMainFrame: true }, policy)
    expect(away).toMatchObject({ code: 'refused_origin', domain: 'example.com' })
    expect(JSON.stringify(away)).not.toContain('evil')
    // До входа сеанс открыт — подресурсы с других сайтов грузятся.
    expect(decideRequest({ ...request('GET', 'https://cdn.example.com/app.js'), sessionLocked: false }, policy)).toEqual({ allow: true })
    // extraOrigins — только подресурсы: изменения и переходы на них по-прежнему закрыты.
    const withCdn = { ...policy, extraOrigins: ['https://cdn.example.com'] }
    expect(decideRequest(request('GET', 'https://cdn.example.com/app.js'), withCdn)).toEqual({ allow: true })
    expect(decideRequest(request('POST', 'https://cdn.example.com/upload'), withCdn)).toMatchObject({ allow: false, code: 'refused_mutation' })
    expect(decideRequest({ ...request('GET', 'https://cdn.example.com/'), isNavigation: true, isMainFrame: true }, withCdn)).toMatchObject({ allow: false, code: 'refused_origin' })
    expect(decideRequest({ ...request('GET', 'https://cdn.example.com/frame'), isNavigation: true }, withCdn)).toMatchObject({ allow: false, code: 'refused_frame' })
  })

  it('пароль в имени хоста не доходит до причины и сайта: поддомены и числовые адреса не показываются', () => {
    const request = (url: string) => ({ method: 'GET', url, isNavigation: false, isMainFrame: false, sessionLocked: true })
    const password = 'Hunter2-Secret'
    const encoded = [password.toLowerCase(), Buffer.from(password).toString('hex'), Buffer.from(password).toString('base64url').toLowerCase()]
    for (const label of encoded) {
      const decision = decideRequest(request(`https://${label}.evil.test/p/${label}?q=${label}`), policy)
      expect(decision).toMatchObject({ code: 'refused_leak', domain: 'evil.test' })
      expect(JSON.stringify(decision)).not.toContain(label)
    }
    expect(siteOf('https://a.b.shop.example.com./x')).toBe('example.com')
    expect(siteOf('https://hunter2.example.com:8443/')).toBe('example.com')
    expect(siteOf('wss://ws.example.org/socket')).toBe('example.org')
    expect(siteOf('http://10.1.2.3/')).toBe('числовой адрес')
    expect(siteOf('http://[fd00::1]/')).toBe('числовой адрес')
    expect(siteOf('не адрес')).toBe('адрес без сайта')
  })

  it('фрейм виден врачу, только если он и все его родители — с разрешённых сайтов', () => {
    const origins = policy.allowedOrigins
    expect(isAllowedFrameUrl(['https://app.example.com/frame', 'https://app.example.com/'], origins)).toBe(true)
    expect(isAllowedFrameUrl(['https://evil.example.com/', 'https://app.example.com/'], origins)).toBe(false)
    expect(isAllowedFrameUrl(['about:blank', 'https://app.example.com/'], origins)).toBe(true)
    expect(isAllowedFrameUrl(['about:srcdoc', 'https://app.example.com/'], origins)).toBe(true)
    expect(isAllowedFrameUrl(['about:blank', 'https://evil.example.com/', 'https://app.example.com/'], origins)).toBe(false)
    expect(isAllowedFrameUrl(['data:text/html,hi', 'https://app.example.com/'], origins)).toBe(false)
    expect(isAllowedFrameUrl(['chrome-error://chromewebdata/', 'https://app.example.com/'], origins)).toBe(false)
  })
})

describe('опасное по самому элементу, а не по слову модели', () => {
  it.each([
    ['Оплатить тариф Про', 'pay'],
    ['Купить сейчас', 'pay'],
    ['Pay now', 'pay'],
    ['Proceed to checkout', 'pay'],
    ['Удалить аккаунт', 'delete'],
    ['Delete account', 'delete'],
    ['/api/account/delete', 'delete'],
    ['Опубликовать пост', 'publish'],
    ['Publish', 'publish'],
    ['Отправить сообщение', 'send'],
    ['Send message', 'send'],
  ])('«%s» → %s', (text, kind) => {
    expect(dangerInText(text)).toBe(kind)
  })

  it.each(['Войти', 'Отправить', 'Показать пароль', 'Сохранить настройки', 'Кабинет', ''])('«%s» — не опасно', (text) => {
    expect(dangerInText(text)).toBeNull()
  })
})

describe('сайт входа для fill-password', () => {
  it('только точный origin входа и только https, кроме локального адреса', () => {
    expect(isLoginOrigin('https://app.example.com/login', 'https://app.example.com')).toBe(true)
    expect(isLoginOrigin('https://evil.app.example.com/login', 'https://app.example.com')).toBe(false)
    expect(isLoginOrigin('https://app.example.com:8443/login', 'https://app.example.com')).toBe(false)
    expect(isLoginOrigin('http://app.example.com/login', 'http://app.example.com')).toBe(false)
    expect(isLoginOrigin('http://127.0.0.1:4100/login', 'http://127.0.0.1:4100')).toBe(true)
    expect(isLoginOrigin('http://localhost:4100/login', 'http://localhost:4100')).toBe(true)
    expect(isLoginOrigin('not a url', 'https://app.example.com')).toBe(false)
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
