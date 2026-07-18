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
];

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'root-unit',
          include: rootUnitTestInclude,
          exclude: rootNodeUnitTestExclude,
        },
      },
      'apps/console/vitest.config.ts',
    ],
  },
});
