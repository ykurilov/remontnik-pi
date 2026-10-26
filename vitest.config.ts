import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: [
      'scripts/**/*.test.mjs',
      'packages/*/src/**/*.test.ts',
      'packages/*/test/**/*.test.ts',
      'apps/*/test/**/*.test.ts',
    ],
    exclude: ['**/node_modules/**', '**/dist/**', '**/*.live.test.ts'],
  },
})
