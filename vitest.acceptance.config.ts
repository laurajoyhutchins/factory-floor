import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@factory-floor/artifact-store': fileURLToPath(
        new URL('./packages/artifact-store/src/public.ts', import.meta.url),
      ),
      '@factory-floor/db': fileURLToPath(
        new URL('./packages/db/src/index.ts', import.meta.url),
      ),
    },
  },
  test: {
    include: ['tests/acceptance/**/*.test.ts'],
    fileParallelism: false,
    maxWorkers: 1,
    minWorkers: 1,
    passWithNoTests: false,
    testTimeout: 190_000,
    hookTimeout: 30_000,
  },
});
