import { describe, expect, it } from 'vitest'
import { PathMaskError, assertValidMask, matchesAnyMask, matchesMask, normalizeRepoPath, matchesAllowMask } from './index.js'

describe('matchesMask', () => {
  it('** охватывает любую глубину, в том числе нулевую', () => {
    expect(matchesMask('**/.env*', '.env')).toBe(true)
    expect(matchesMask('**/.env*', 'apps/web/.env.production')).toBe(true)
    expect(matchesMask('src/payments/**', 'src/payments/charge.ts')).toBe(true)
    expect(matchesMask('src/payments/**', 'src/payments/stripe/hooks/charge.ts')).toBe(true)
    expect(matchesMask('src/payments/**', 'src/paymentsx/charge.ts')).toBe(false)
  })

  it('* не пересекает границу папки', () => {
    expect(matchesMask('src/*.ts', 'src/a.ts')).toBe(true)
    expect(matchesMask('src/*.ts', 'src/deep/a.ts')).toBe(false)
  })

  it('регистр не важен', () => {
    expect(matchesMask('**/*secret*', 'Config/MySecrets.json')).toBe(true)
    expect(matchesMask('**/Dockerfile', 'dockerfile')).toBe(true)
  })

  it('маска считается от корня репозитория', () => {
    expect(matchesMask('patches/@ykurilov__agent-chat-*', 'patches/@ykurilov__agent-chat-core@1.0.0.patch')).toBe(true)
    expect(matchesMask('patches/@ykurilov__agent-chat-*', 'apps/web/patches/@ykurilov__agent-chat-core@1.0.0.patch')).toBe(
      false,
    )
  })

  it('? — один символ, {a,b} — выбор, [..] — набор, точки в маске — обычные символы', () => {
    expect(matchesMask('a?.ts', 'ab.ts')).toBe(true)
    expect(matchesMask('a?.ts', 'a.ts')).toBe(false)
    expect(matchesMask('src/*.{ts,tsx}', 'src/a.tsx')).toBe(true)
    expect(matchesMask('src/*.{ts,tsx}', 'src/a.js')).toBe(false)
    expect(matchesMask('file[12].txt', 'file2.txt')).toBe(true)
    expect(matchesMask('a.b', 'axb')).toBe(false)
  })

  it('символы регулярных выражений в маске не ломают разбор', () => {
    expect(matchesMask('src/(core)+/x.ts', 'src/(core)+/x.ts')).toBe(true)
    expect(matchesMask('src/(core)+/x.ts', 'src/corecore/x.ts')).toBe(false)
  })
})

describe('normalizeRepoPath', () => {
  it('убирает ./, двойные слэши и обратные слэши', () => {
    expect(normalizeRepoPath('./src//a.ts')).toBe('src/a.ts')
    expect(normalizeRepoPath('src\\a.ts')).toBe('src/a.ts')
  })

  it('схлопывает .. внутри пути, чтобы нельзя было обойти маску', () => {
    expect(normalizeRepoPath('src/x/../../.env')).toBe('.env')
    expect(matchesAnyMask(['**/.env*'], 'src/x/../../.env')).toBe(true)
  })

  it('путь, выходящий за корень, остаётся с ..', () => {
    expect(normalizeRepoPath('../outside.txt')).toBe('../outside.txt')
  })
})

describe('matchesMask: папка без * охватывает всё внутри', () => {
  it('маска-папка рекурсивна', () => {
    expect(matchesMask('migrations', 'migrations/001.sql')).toBe(true)
    expect(matchesMask('src/payments', 'src/payments/stripe/charge.ts')).toBe(true)
    expect(matchesMask('migrations', 'migrations')).toBe(true)
    expect(matchesMask('migrations', 'migrationsx/001.sql')).toBe(false)
    expect(matchesMask('migrations', 'app/migrations/001.sql')).toBe(false)
  })

  it('маска с * сработает и на файлы внутри подошедшей папки', () => {
    expect(matchesMask('src/pay*', 'src/payments/charge.ts')).toBe(true)
    expect(matchesMask('src/*.ts', 'src/deep/a.ts')).toBe(false)
  })

  it('./ и ведущий / в маске не мешают', () => {
    expect(matchesMask('./src/payments/**', 'src/payments/a.ts')).toBe(true)
    expect(matchesMask('/src/payments/**', 'src/payments/a.ts')).toBe(true)
    expect(matchesMask('/migrations', 'migrations/001.sql')).toBe(true)
  })
})

describe('неподдерживаемый синтаксис масок — ошибка, а не тихое несовпадение', () => {
  it.each(['@(a|b)/x.ts', '!(a)/x.ts', '+(a|b).ts', '?(a).ts', '*(a|b).ts', '!src/**', 'src/[abc', 'src/{a,b', 'src/}/**', 'src/a}b'])(
    '%s',
    (mask) => {
      expect(() => assertValidMask(mask)).toThrow(PathMaskError)
      expect(() => matchesMask(mask, 'src/a.ts')).toThrow(PathMaskError)
    },
  )

  it('обычные маски проходят проверку', () => {
    for (const mask of ['**/.env*', 'src/payments/**', 'a?.ts', 'src/*.{ts,tsx}', 'file[12].txt', '<нет>']) {
      expect(() => assertValidMask(mask)).not.toThrow()
    }
  })
})

describe('белый список: регистр важен, обратный слэш — отказ', () => {
  it('регистр различается: на Linux SRC/ — другая папка', () => {
    expect(matchesAllowMask(['src/**'], 'src/price.ts')).toBe(true)
    expect(matchesAllowMask(['src/**'], 'SRC/price.ts')).toBe(false)
    expect(matchesAllowMask(['src/**'], 'Src/x.ts')).toBe(false)
    expect(matchesAllowMask(['**/*.test.*'], 'test/a.TEST.ts')).toBe(false)
  })

  it('путь с обратным слэшем не подходит: на Linux это имя файла, а не папка', () => {
    expect(matchesAllowMask(['src/**'], 'src\\x.ts')).toBe(false)
    expect(matchesAllowMask(['src/**'], 'src/a\\b.ts')).toBe(false)
  })

  it('.. внутри пути схлопывается до проверки', () => {
    expect(matchesAllowMask(['src/**'], 'src/../lib/x.ts')).toBe(false)
  })
})
