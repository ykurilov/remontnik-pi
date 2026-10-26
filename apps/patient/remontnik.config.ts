import { defineRemontnikConfig } from '@ykurilov/remontnik-core/config'

// Настройка Ремонтника для учебного «Пациента». Секретов здесь нет: только имена переменных окружения.
// Настройка не подключает файлы из src/**: всё, что она подключает, врач не правит (`docs/security.md`).

// Описание бота для чтения разговоров сторожем: что бот должен и не должен делать. Тарифы сверяет `test/config.test.ts`.
const BOT_DESCRIPTION = [
  'Бот поддержки учебного сервиса «Пациент». Задачи: называть цены тарифов и сообщать статус заказа по номеру.',
  'Тарифы: «Старт» — 990 ₽ в месяц, «Про» — 2990 ₽ в месяц; других тарифов нет.',
  'Правила: общается по-русски, вежливо и коротко. Статус заказа называет только по результату проверки заказа; если проверка не удалась, так и говорит.',
  'Не выдумывает цены, условия и возможности. Не обещает скидок, возвратов и сроков. Если вопрос вне задач, говорит, о чём можно спросить.',
].join('\n')

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
  review: { botDescription: BOT_DESCRIPTION },
  reports: { telegram: { botTokenEnv: 'PATIENT_ALERT_BOT_TOKEN', chatIdEnv: 'PATIENT_ALERT_CHAT_ID' } },
})
