import js from '@eslint/js';
import importPlugin from 'eslint-plugin-import';
import react from 'eslint-plugin-react';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['dist/**', 'node_modules/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    plugins: {
      react,
      'react-hooks': reactHooks,
      import: importPlugin,
    },
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      parserOptions: {
        ecmaFeatures: { jsx: true },
      },
    },
    settings: {
      react: { version: 'detect' },
    },
    rules: {
      ...react.configs.recommended.rules,
      ...react.configs['jsx-runtime'].rules,
      ...reactHooks.configs.recommended.rules,
      '@typescript-eslint/no-explicit-any': 'error',
      // Every Supabase .rpc() call must pass _trace_id (PRD section 24, Schema
      // section 1). Prefer callRpc() from src/lib/rpc.ts, which adds it.
      'no-restricted-syntax': [
        'error',
        {
          selector:
            "CallExpression[callee.property.name='rpc'] > ObjectExpression:not(:has(Property[key.name='_trace_id']))",
          message:
            'Supabase .rpc() calls must include _trace_id parameter. Use callRpc() from src/lib/rpc.ts instead.',
        },
      ],
      // Force all requests through fetchWithTrace() so they carry X-Trace-Id.
      'no-restricted-globals': [
        'error',
        {
          name: 'fetch',
          message: 'Use fetchWithTrace() from src/lib/fetch.ts so requests carry X-Trace-Id.',
        },
      ],
      // TODO: enable in a later PR - custom rule to forbid SELECT * in SQL queries
      // 'sorted/no-select-star': 'error',
      // TODO: tighten in later PRs - enforce src/lib boundaries via zones
      // 'import/no-restricted-paths': ['error', { zones: [/* src/lib boundary */] }],
    },
  },
  {
    // fetchWithTrace() is the single sanctioned wrapper around native fetch.
    files: ['src/lib/fetch.ts'],
    rules: {
      'no-restricted-globals': 'off',
    },
  },
  {
    // All structured logging goes through logger from src/lib/logger.ts.
    // No console.* anywhere in first-party src/** code.
    files: ['src/**/*.{ts,tsx}'],
    ignores: ['src/**/*.test.{ts,tsx}', 'src/**/__tests__/**'],
    rules: {
      'no-console': 'error',
    },
  },
  {
    // The logger files are the single sanctioned console sink. Only warn/error
    // are permitted; the real level is carried in the JSON `level` field.
    files: ['src/lib/logger.ts', 'src/server/logger.ts'],
    rules: {
      'no-console': ['error', { allow: ['warn', 'error'] }],
    },
  },
  {
    files: ['*.config.{js,ts}', 'vite.config.ts'],
    languageOptions: {
      globals: {
        process: 'readonly',
      },
    },
  },
);
