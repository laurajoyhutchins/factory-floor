export default [
  {
    ignores: ['**/dist/**', '**/node_modules/**', '**/.venv/**', '**/__pycache__/**', 'packages/worker-sdk-py/**'],
  },
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        console: 'readonly',
        process: 'readonly',
        URL: 'readonly',
      },
    },
    rules: {
      'no-unused-vars': 'error',
      'no-undef': 'error',
    },
  },
];
