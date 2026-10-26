import { defineConfig } from '@playwright/test'

// Браузерные тесты службы против «Пациента». Каждый тест поднимает свою службу со своими данными.
export default defineConfig({
  testDir: 'test/e2e',
  globalSetup: './test/e2e/start-patient.ts',
  fullyParallel: true,
  workers: 4,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [['list']],
  use: { trace: 'off' },
})
