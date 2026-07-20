import { defineConfig } from 'vitest/config';

export const rootUnitTestInclude = [
  'apps/**/*.test.ts',
  'apps/**/*.test.tsx',
  'packages/**/*.test.ts',
  'packages/**/*.test.tsx',
  'workers/**/*.test.ts',
  'workers/**/*.test.tsx',
  'scripts/**/*.test.mjs',
];

export const rootUnitTestExclude = [
  'tests/**',
  '**/node_modules/**',
  '**/dist/**',
  '**/build/**',
  '**/coverage/**',
  '**/generated/**',
];

export const rootNodeUnitTestExclude = [
  ...rootUnitTestExclude,
  'apps/console/**',
  'packages/operator-ui-react/**',
];

export const rootCoverageInclude = [
  'apps/*/src/**/*.{ts,tsx}',
  'packages/*/src/**/*.{ts,tsx}',
  'workers/*/src/**/*.{ts,tsx}',
  'scripts/**/*.mjs',
];

export const rootCoverageExclude = [
  '**/*.d.ts',
  '**/generated/**',
  '**/*.test.{ts,tsx}',
  '**/*.spec.{ts,tsx}',
  '**/*.test.mjs',
  'apps/control-plane/src/server.ts',
  'apps/console/src/main.tsx',
  'workers/demo-ts/src/index.ts',
];

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      include: rootCoverageInclude,
      exclude: rootCoverageExclude,
      reportsDirectory: '.factory-floor/coverage/typescript',
      reporter: [
        'text-summary',
        'json-summary',
        'json',
        'lcov',
        'cobertura',
        'html',
      ],
      reportOnFailure: true,
    },
    projects: [
      {
        test: {
          name: 'root-unit',
          include: rootUnitTestInclude,
          exclude: rootNodeUnitTestExclude,
        },
      },
      'apps/console/vitest.config.ts',
      'packages/operator-ui-react/vitest.config.ts',
    ],
  },
});
