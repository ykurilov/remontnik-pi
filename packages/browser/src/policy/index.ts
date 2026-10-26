// Настройка службы браузера: какие сайты разрешены, какие изменяющие запросы, какие профили.
// Файл лежит вне репозитория приложения, путь — в REMONTNIK_BROWSER_POLICY.
import { readFileSync } from 'node:fs'
import { z } from 'zod'

const origin = z.string().refine((value) => {
  try {
    const url = new URL(value)
    return (url.protocol === 'https:' || url.protocol === 'http:') && url.origin === value
  } catch {
    return false
  }
}, 'ожидается origin вида https://app.example.com без пути и косой черты в конце')

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
  allowedMutations: z.array(z.object({ method: z.string().min(1), pathPattern: z.string().startsWith('/') })),
  profiles: z.array(profileSchema).min(1),
})

export type BrowserPolicy = z.infer<typeof browserPolicySchema>
export type BrowserProfileConfig = z.infer<typeof profileSchema>
export type SitePolicy = Pick<BrowserPolicy, 'allowedOrigins' | 'allowedMutations'>

export function parseBrowserPolicy(value: unknown): BrowserPolicy {
  const parsed = browserPolicySchema.safeParse(value)
  if (!parsed.success) {
    const problems = parsed.error.issues.map((issue) => `${issue.path.join('.') || '(корень)'}: ${issue.message}`)
    throw new Error(`настройка браузера неверна:\n${problems.join('\n')}`)
  }
  return parsed.data
}

export function loadBrowserPolicy(path: string): BrowserPolicy {
  return parseBrowserPolicy(JSON.parse(readFileSync(path, 'utf8')))
}
