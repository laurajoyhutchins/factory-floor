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
  {
    languageOptions: {
      globals: {
        URL: 'readonly',
      },
    },
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
);
