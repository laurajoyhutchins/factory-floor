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
      '@factory-floor/runtime-core': fileURLToPath(
        new URL('./packages/runtime-core/src/index.ts', import.meta.url),
      ),
      kysely: fileURLToPath(
        new URL(
          './packages/db/node_modules/kysely/dist/esm/index.js',
          import.meta.url,
        ),
      ),
    },
  },
  test: {
    include: ['tests/integration/**/*.test.ts', 'packages/**/*.integration.ts'],
    passWithNoTests: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
