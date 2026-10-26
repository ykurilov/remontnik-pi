import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const setupFile = fileURLToPath(new URL('./vitest.setup.ts', import.meta.url))
const packagesDirectory = fileURLToPath(new URL('./packages/', import.meta.url))

// Образцы из examples/: полный цикл с настоящим приложением. Приложению нужны собранные пакеты (pnpm build), поэтому
// группа отдельная и идёт после сборки. Сам тест берёт пакеты набора из исходников, как обычные тесты.
export default defineConfig({
  resolve: {
    alias: [
      { find: /^@ykurilov\/remontnik-([a-z-]+)\/(.+)$/, replacement: `${packagesDirectory}$1/src/$2/index.ts` },
      { find: /^@ykurilov\/remontnik-([a-z-]+)$/, replacement: `${packagesDirectory}$1/src/index.ts` },
    ],
  },
  test: {
    include: ['examples/**/*.test.ts'],
    setupFiles: [setupFile],
    testTimeout: 240_000,
  },
})
