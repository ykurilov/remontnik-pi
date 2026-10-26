import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const setupFile = fileURLToPath(new URL('./vitest.setup.ts', import.meta.url))
const packagesDirectory = fileURLToPath(new URL('./packages/', import.meta.url))

export default defineConfig({
  resolve: {
    // Тесты идут до сборки: пакеты набора берутся из исходников, подпуть = папка с index.ts. Дочерний процесс чтения настройки врача (config-source.ts) тоже берёт пакеты из исходников, когда сам врач запущен из `.ts`.
    alias: [
      { find: /^@ykurilov\/remontnik-([a-z-]+)\/(.+)$/, replacement: `${packagesDirectory}$1/src/$2/index.ts` },
      { find: /^@ykurilov\/remontnik-([a-z-]+)$/, replacement: `${packagesDirectory}$1/src/index.ts` },
    ],
  },
  test: {
    include: [
      'scripts/**/*.test.mjs',
      'packages/*/src/**/*.test.ts',
      'packages/*/test/**/*.test.ts',
      'apps/*/test/**/*.test.ts',
      'apps/*/deploy/**/*.test.ts',
    ],
    setupFiles: [setupFile],
    // Падения врача — своя группа: `vitest.crash.config.ts`.
    exclude: ['**/node_modules/**', '**/dist/**', '**/*.live.test.ts', 'packages/*/test/crash/**'],
  },
})
