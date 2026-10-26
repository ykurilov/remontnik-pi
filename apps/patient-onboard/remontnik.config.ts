import { defineRemontnikConfig } from '@ykurilov/remontnik-core/config'

// Настройка Ремонтника для «Пациента (onboard)». Секретов здесь нет: только имена переменных окружения.
export default defineRemontnikConfig({
  app: { name: 'patient-onboard', timeZone: 'UTC' },
  repo: { mainBranch: 'main' },
  workbench: { image: 'node:22', install: 'pnpm install --frozen-lockfile' },
  checks: { test: 'pnpm test', typecheck: 'pnpm typecheck' },
  evalScope: [],
  closedPaths: [],
  fixablePaths: ['src/**'],
  forbidden: {
    schema: ['<нет>'], // у приложения нет базы
    money: ['src/payments/**'],
    access: ['src/auth/**'],
  },
  deploy: {
    commands: {
      build: 'node deploy/remontnik-deploy.mjs build',
      promote: 'node deploy/remontnik-deploy.mjs promote',
      confirm: 'node deploy/remontnik-deploy.mjs confirm',
      rollback: 'node deploy/remontnik-deploy.mjs rollback',
      current: 'node deploy/remontnik-deploy.mjs current',
      health: 'node deploy/remontnik-deploy.mjs health',
    },
    lockFile: '.remontnik/deploy.lock',
  },
  reports: { telegram: { botTokenEnv: 'APP_ALERT_BOT_TOKEN', chatIdEnv: 'APP_ALERT_CHAT_ID' } },
})
