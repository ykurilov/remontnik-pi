import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const root = fileURLToPath(new URL('./', import.meta.url))
const packagesDirectory = fileURLToPath(new URL('./packages/', import.meta.url))

// Падения врача: отдельная группа, в обычный прогон (`vitest.config.ts`) не входит. Каждая проверка гоняет врача
// отдельным процессом, убивает и запускает снова.
export default defineConfig({
  root,
  resolve: {
    alias: [
      { find: /^@ykurilov\/remontnik-([a-z-]+)\/(.+)$/, replacement: `${packagesDirectory}$1/src/$2/index.ts` },
      { find: /^@ykurilov\/remontnik-([a-z-]+)$/, replacement: `${packagesDirectory}$1/src/index.ts` },
    ],
  },
  test: {
    include: ['packages/*/test/crash/**/*.test.ts'],
    testTimeout: 180_000,
    maxConcurrency: 4,
  },
})
