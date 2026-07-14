import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/.venv/**',
      '**/__pycache__/**',
      'packages/worker-sdk-py/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
);
