import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const packagesDirectory = fileURLToPath(new URL('./packages/', import.meta.url))

// Замеры скорости: отдельная группа, в обычный прогон (`vitest.config.ts`) не входит.
export default defineConfig({
  resolve: {
    alias: [
      { find: /^@ykurilov\/remontnik-([a-z-]+)\/(.+)$/, replacement: `${packagesDirectory}$1/src/$2/index.ts` },
      { find: /^@ykurilov\/remontnik-([a-z-]+)$/, replacement: `${packagesDirectory}$1/src/index.ts` },
    ],
  },
  test: {
    include: ['packages/*/test/perf/**/*.bench.ts'],
    testTimeout: 60_000,
    fileParallelism: false,
  },
})
