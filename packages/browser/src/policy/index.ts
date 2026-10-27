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

/** Имя без точки (`db`, `patient`) — сервис внутренней сети; `localhost`, `.local`, `.internal` — машина и локальная сеть. */
function isInternalHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase()
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

const profileSchema = z.object({
  name: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/i, 'имя профиля: буквы, цифры, «-» и «_», до 64 знаков'),
  proxy: z
    .object({
      server: z.string().min(1),
      usernameEnv: z.string().optional(),
      passwordEnv: z.string().optional(),
    })
    .optional(),
  viewport: z.object({ width: z.number().int().min(320).max(3840), height: z.number().int().min(320).max(2160) }).optional(),
})

export const browserPolicySchema = z.object({
  allowedOrigins: z.array(origin).min(1),
  /**
   * Сторонние адреса, нужные страницам приложения (CDN, шрифты): после первого ввода пароля сеанс профиля заперт,
   * и подресурсы с других сайтов не грузятся. Это только подресурсы: переходы и фреймы — по-прежнему allowedOrigins.
   */
  extraOrigins: z.array(externalOrigin).optional(),
  allowedMutations: z.array(z.object({ method: z.string().min(1), pathPattern: z.string().startsWith('/') })),
  profiles: z.array(profileSchema).min(1),
})

export type BrowserPolicy = z.infer<typeof browserPolicySchema>
export type BrowserProfileConfig = z.infer<typeof profileSchema>
export type SitePolicy = Pick<BrowserPolicy, 'allowedOrigins' | 'allowedMutations' | 'extraOrigins'>

/** Неверные поля настройки: пусто — настройка верна. */
export function browserPolicyProblems(value: unknown): string[] {
  const parsed = browserPolicySchema.safeParse(value)
  return parsed.success ? [] : parsed.error.issues.map((issue) => `${issue.path.join('.') || '(корень)'}: ${issue.message}`)
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
