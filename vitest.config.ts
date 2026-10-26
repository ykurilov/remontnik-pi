import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const packagesDirectory = fileURLToPath(new URL('./packages/', import.meta.url))

export default defineConfig({
  resolve: {
    // Тесты идут до сборки: пакеты набора берутся из исходников, подпуть = папка с index.ts.
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
    // Падения врача — своя группа: `vitest.crash.config.ts`.
    exclude: ['**/node_modules/**', '**/dist/**', '**/*.live.test.ts', 'packages/*/test/crash/**'],
  },
})
