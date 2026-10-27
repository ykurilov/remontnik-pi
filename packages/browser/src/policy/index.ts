// Настройка службы браузера: какие сайты разрешены, какие изменяющие запросы, какие профили.
// Файл лежит вне репозитория приложения, путь — в REMONTNIK_BROWSER_POLICY.
import { readFileSync } from 'node:fs'
import { isIP } from 'node:net'
import { z } from 'zod'
import { isInternalAddress } from '../egress/index.js'

const origin = z.string().refine((value) => {
  try {
    const url = new URL(value)
    return (url.protocol === 'https:' || url.protocol === 'http:') && url.origin === value && !value.includes('*')
  } catch {
    return false
  }
}, 'ожидается origin вида https://app.example.com без пути, масок и косой черты в конце')

/**
 * Имя без точки (`db`, `patient`) — сервис внутренней сети; `localhost`, `.local`, `.internal` — машина и локальная сеть.
 * Точка в конце (`localhost.`) — то же имя, записанное полностью: её отрезаем.
 */
function isInternalHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase().replace(/\.+$/, '')
  if (isIP(host)) return isInternalAddress(host)
  return !host.includes('.') || host === 'localhost' || /\.(localhost|local|internal)$/.test(host)
}

/** Сторонний адрес из extraOrigins: точный origin в интернете, без масок и внутренних адресов. */
const externalOrigin = origin.refine((value) => {
  try {
    return !isInternalHost(new URL(value).hostname)
  } catch {
    return true // неверный адрес уже отмечен проверкой origin
  }
}, 'внутренний адрес (петля, частная сеть, имя без точки, .local, .internal) в extraOrigins не пускается')

// Объекты строгие: опечатка в имени поля (`extraOrgins`) — ошибка настройки, а не молча пропущенное поле.
const profileSchema = z.strictObject({
  name: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/i, 'имя профиля: буквы, цифры, «-» и «_», до 64 знаков'),
  proxy: z
    .strictObject({
      server: z.string().min(1),
      usernameEnv: z.string().optional(),
      passwordEnv: z.string().optional(),
    })
    .optional(),
  viewport: z.strictObject({ width: z.number().int().min(320).max(3840), height: z.number().int().min(320).max(2160) }).optional(),
})

export const browserPolicySchema = z.strictObject({
  allowedOrigins: z.array(origin).min(1),
  /**
   * Сторонние адреса, нужные страницам приложения (CDN, шрифты): после первого ввода пароля сеанс профиля заперт,
   * и подресурсы с других сайтов не грузятся. Это только подресурсы: переходы и фреймы — по-прежнему allowedOrigins.
   */
  extraOrigins: z.array(externalOrigin).optional(),
  /** `origin` — точный сайт из allowedOrigins: правило действует только на нём. Без поля — на всех allowedOrigins. */
  allowedMutations: z.array(z.strictObject({ method: z.string().min(1), pathPattern: z.string().startsWith('/'), origin: origin.optional() })),
  profiles: z.array(profileSchema).min(1),
}).superRefine((policy, context) => {
  policy.allowedMutations.forEach((rule, index) => {
    // Неверный по форме origin уже отмечен проверкой поля: второе сообщение о том же не нужно.
    if (rule.origin !== undefined && origin.safeParse(rule.origin).success && !policy.allowedOrigins.includes(rule.origin)) {
      context.addIssue({ code: 'custom', path: ['allowedMutations', index, 'origin'], message: 'origin правила — только сайт из allowedOrigins' })
    }
  })
})

export type BrowserPolicy = z.infer<typeof browserPolicySchema>
export type BrowserProfileConfig = z.infer<typeof profileSchema>
export type SitePolicy = Pick<BrowserPolicy, 'allowedOrigins' | 'allowedMutations' | 'extraOrigins'>

/** Неверные поля настройки: пусто — настройка верна. */
export function browserPolicyProblems(value: unknown): string[] {
  const parsed = browserPolicySchema.safeParse(value)
  if (parsed.success) return []
  return parsed.error.issues.map((issue) => {
    const message = issue.code === 'unrecognized_keys' ? `неизвестное поле ${issue.keys.map((key) => `«${key}»`).join(', ')} — опечатка?` : issue.message
    return `${issue.path.join('.') || '(корень)'}: ${message}`
  })
}

export function parseBrowserPolicy(value: unknown): BrowserPolicy {
  const problems = browserPolicyProblems(value)
  if (problems.length > 0) throw new Error(`настройка браузера неверна:\n${problems.join('\n')}`)
  return browserPolicySchema.parse(value)
}

export function loadBrowserPolicy(path: string): BrowserPolicy {
  return parseBrowserPolicy(JSON.parse(readFileSync(path, 'utf8')))
}

/** Адреса, куда страницы ходят после входа паролем: сайты приложения и его сторонние адреса. */
export function sessionOrigins(policy: SitePolicy): string[] {
  return [...policy.allowedOrigins, ...(policy.extraOrigins ?? [])]
}
