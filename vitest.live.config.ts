import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const setupFile = fileURLToPath(new URL('./vitest.setup.ts', import.meta.url))
const root = fileURLToPath(new URL('.', import.meta.url))
const packagesDirectory = fileURLToPath(new URL('./packages/', import.meta.url))

// Живые тесты: настоящие поставщики моделей, платные. В обычный прогон (`vitest.config.ts`) не входят.
export default defineConfig({
  root,
  resolve: {
    alias: [
      { find: /^@ykurilov\/remontnik-([a-z-]+)\/(.+)$/, replacement: `${packagesDirectory}$1/src/$2/index.ts` },
      { find: /^@ykurilov\/remontnik-([a-z-]+)$/, replacement: `${packagesDirectory}$1/src/index.ts` },
    ],
  },
  test: {
    include: ['packages/*/test/live/**/*.live.test.ts'],
    setupFiles: [setupFile],
    testTimeout: 600_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
})
