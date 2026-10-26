import { defineRemontnikConfig } from '@ykurilov/remontnik-core/config'
import { BOT_DESCRIPTION } from './src/bot/description.ts'

// Настройка Ремонтника для учебного «Пациента». Секретов здесь нет: только имена переменных окружения.
export default defineRemontnikConfig({
  app: { name: 'patient', timeZone: 'UTC' },
  repo: { mainBranch: 'main' },
  workbench: { image: 'node:22', install: 'pnpm install --frozen-lockfile' },
  checks: {
    test: 'pnpm test',
    typecheck: 'pnpm typecheck',
    eval: {
      run: 'node eval/run-eval.ts --scenarios {scenarios} --repeat {repeat} --max-cost {maxCostUsd} --out {outDir}',
      resultFile: 'eval-result.json',
      repeat: 3,
      maxScenarios: 3,
      env: [],
    },
  },
  evalScope: [
    { paths: ['src/bot/**'], scenarios: 'all' },
    { paths: ['src/pages.ts', 'src/server.ts'], scenarios: ['greeting', 'small-talk'] },
  ],
  closedPaths: [],
  forbidden: {
    schema: ['<нет>'], // у «Пациента» нет базы
    money: ['src/payments/**'],
    access: ['src/auth/**'],
  },
  deploy: {
    commands: {
      build: 'node deploy/remontnik-deploy.ts build',
      promote: 'node deploy/remontnik-deploy.ts promote',
      confirm: 'node deploy/remontnik-deploy.ts confirm',
      rollback: 'node deploy/remontnik-deploy.ts rollback',
      current: 'node deploy/remontnik-deploy.ts current',
      health: 'node deploy/remontnik-deploy.ts health',
    },
    lockFile: '.remontnik/deploy.lock',
  },
  review: { botDescription: BOT_DESCRIPTION, usdPerDay: 0.5 },
  reports: { telegram: { botTokenEnv: 'PATIENT_ALERT_BOT_TOKEN', chatIdEnv: 'PATIENT_ALERT_CHAT_ID' } },
})
