import js from '@eslint/js';
import importPlugin from 'eslint-plugin-import';
import react from 'eslint-plugin-react';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

// Every Supabase .rpc() call must pass _trace_id (PRD section 24, Schema
// section 1). Prefer callRpc() from src/lib/rpc.ts, which adds it. Shared so
// blocks that override no-restricted-syntax keep it.
const rpcTraceId = {
  selector:
    "CallExpression[callee.property.name='rpc'] > ObjectExpression:not(:has(Property[key.name='_trace_id']))",
  message:
    'Supabase .rpc() calls must include _trace_id parameter. Use callRpc() from src/lib/rpc.ts instead.',
};

// Design rules (CLAUDE.md): raw sizes, radii, weights, hex and dark: in a
// className. text-legacy-* is allowed until the type migration PR removes it.
const DESIGN_CLASS =
  '/\\btext-\\[[0-9.]+(px|rem)\\]|\\brounded-\\[[0-9.]+px\\]|\\bdark:|\\bfont-\\[[0-9]+\\]|#[0-9a-fA-F]{3,8}\\b/';
const DESIGN_MESSAGE = 'Design rules: tokens and scale only (see CLAUDE.md)';
const PRIMITIVE = '/^(Button|IconButton|Chip|PressableRow|Backdrop|DropZone)$/';
const BANG_CLASS = '/(^|[\\s:])![a-z[-]/';
const BANG_MESSAGE = 'Never override a ui primitive with "!"; use its props (see CLAUDE.md)';
const RGBA_CLASS = '/rgba\\(/';
const RGBA_MESSAGE = 'No rgba() in a className; add a token in src/index.css';
const designRules = [
  {
    selector: "JSXOpeningElement[name.name='button']",
    message: 'Use Button, IconButton or Chip from src/components/ui',
  },
  {
    selector: `JSXAttribute[name.name='className'] Literal[value=${DESIGN_CLASS}]`,
    message: DESIGN_MESSAGE,
  },
  {
    selector: `JSXAttribute[name.name='className'] TemplateElement[value.raw=${DESIGN_CLASS}]`,
    message: DESIGN_MESSAGE,
  },
  // A "!" override on a ui primitive (same rule as src/__tests__/no-raw-button.test.ts).
  {
    selector: `JSXOpeningElement[name.name=${PRIMITIVE}] JSXAttribute[name.name='className'] Literal[value=${BANG_CLASS}]`,
    message: BANG_MESSAGE,
  },
  {
    selector: `JSXOpeningElement[name.name=${PRIMITIVE}] JSXAttribute[name.name='className'] TemplateElement[value.raw=${BANG_CLASS}]`,
    message: BANG_MESSAGE,
  },
  // Raw colours belong in tokens (src/index.css), not in a className.
  {
    selector: `JSXAttribute[name.name='className'] Literal[value=${RGBA_CLASS}]`,
    message: RGBA_MESSAGE,
  },
  {
    selector: `JSXAttribute[name.name='className'] TemplateElement[value.raw=${RGBA_CLASS}]`,
    message: RGBA_MESSAGE,
  },
];

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      'packages/schemas/dist/**',
      // Supabase types are generated; the drift gate owns their shape.
      'packages/schemas/src/supabase.generated.ts',
    ],
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
      'no-restricted-syntax': ['error', rpcTraceId],
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
    // Design rules apply to app code; ui/ owns the primitives, home/ is the
    // marketing site with its own stylesheet, test-site/ is the staff-only
    // harness outside the app.
    files: ['src/**/*.{ts,tsx}'],
    ignores: [
      'src/components/ui/**',
      'src/components/home/**',
      'src/components/test-site/**',
      'src/**/*.test.{ts,tsx}',
      'src/**/__tests__/**',
    ],
    rules: {
      'no-restricted-syntax': ['error', rpcTraceId, ...designRules],
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
