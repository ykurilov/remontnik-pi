import { defineRemontnikConfig, type RemontnikConfig, type RemontnikConfigInput } from '@ykurilov/remontnik-core/config'

// Рабочая настройка приложения для тестов врача: поля верхнего уровня заменяются целиком.
export function testRemontnikConfig(overrides: Partial<RemontnikConfigInput> = {}): RemontnikConfig {
  return defineRemontnikConfig({
    app: { name: 'test-app', timeZone: 'UTC' },
    repo: { mainBranch: 'main', mainline: 'pull-request' },
    workbench: { image: 'node:22', install: 'pnpm install' },
    checks: { test: 'pnpm test' },
    evalScope: [],
    closedPaths: [],
    forbidden: { schema: ['<нет>'], money: ['src/payments/**'], access: ['src/auth/**'] },
    deploy: {
      commands: {
        build: 'node deploy.ts build',
        promote: 'node deploy.ts promote',
        confirm: 'node deploy.ts confirm',
        rollback: 'node deploy.ts rollback',
        current: 'node deploy.ts current',
        health: 'node deploy.ts health',
      },
      lockFile: '.remontnik/deploy.lock',
    },
    reports: { telegram: { botTokenEnv: 'TEST_ALERT_BOT_TOKEN', chatIdEnv: 'TEST_ALERT_CHAT_ID' } },
    ...overrides,
  })
}
