import { defineRemontnikConfig } from '@ykurilov/remontnik-core/config'

// Образец настройки: подробности каждого поля — docs/configuration.md.
export default defineRemontnikConfig({
  app: { name: 'mini-app', timeZone: 'UTC' },
  repo: { mainBranch: 'main', mainline: 'merge' },
  workbench: { image: 'node:22', install: 'true' },
  checks: { test: 'node --test' },
  fixablePaths: ['src/**'],
  evalScope: [],
  closedPaths: [],
  forbidden: { schema: ['<нет>'], money: ['<нет>'], access: ['<нет>'] },
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
    buildEnv: ['APP_DEPLOY_DIR'],
  },
  reports: { telegram: { botTokenEnv: 'APP_ALERT_BOT_TOKEN', chatIdEnv: 'APP_ALERT_CHAT_ID' } },
})
