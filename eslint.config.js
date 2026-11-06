import js from '@eslint/js';
import importPlugin from 'eslint-plugin-import';
import react from 'eslint-plugin-react';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';
import { builtinRules } from 'eslint/use-at-your-own-risk';

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
  // B1: the ⋯ glyph lives only in ui/ActionMenu.tsx (ActionMenuTrigger owns
  // the trailing rule); every menu opener renders ActionMenuTrigger.
  {
    selector: "JSXOpeningElement[name.name='IconMore']",
    message: 'Render ActionMenuTrigger (ui/ActionMenu) instead of IconMore',
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

// Layout rules (CLAUDE.md): stacking, icon sizes and fixed-size images.
// A rule with zero hits in src/** is an error (layoutErrors, typeErrors below,
// guarded by src/__tests__/design-lint-errors.test.ts). Rules that still have
// hits warn under design/warn-syntax (CI stays green) and
// scripts/design-ratchet.ts blocks any new one. Exempt only with a
// next-line disable comment plus a reason after "--"; the ratchet counts
// every disable (designDisables). design/warn-syntax is ESLint's own
// no-restricted-syntax under a second id so it can warn while the errors
// above stay errors.
const Z_ARBITRARY = '/(^|[\\s:])-?z-\\[/';
const Z_MESSAGE = 'Use the stacking scale (CLAUDE.md Layout rules)';
// Error: zero hits since the named stacking scale (tailwind.config.ts zIndex).
const layoutErrors = [
  {
    selector: `JSXAttribute[name.name='className'] Literal[value=${Z_ARBITRARY}]`,
    message: Z_MESSAGE,
  },
  {
    selector: `JSXAttribute[name.name='className'] TemplateElement[value.raw=${Z_ARBITRARY}]`,
    message: Z_MESSAGE,
  },
  {
    selector:
      "JSXOpeningElement[name.name=/^Icon[A-Z]/] > JSXAttribute[name.name='size'] > JSXExpressionContainer > Literal[raw=/^[0-9]/]",
    message: 'Use ICON_SIZE.*',
  },
];
// B1 layout system (CLAUDE.md Layout rules). ui/Text.tsx is the only place a
// type override may live; chat-type.ts holds the chat type table as constants.
// Error: zero hits outside them.
// text-[Npx] / text-[Nrem] already error under DESIGN_CLASS; this catches the rest.
const TYPE_OVERRIDE = '/(^|[\\s:])(leading-|tracking-|text-\\[(?![0-9.]+(px|rem)\\]))/';
const TYPE_MESSAGE = 'Use a text role from ui/Text.tsx (no leading-*, tracking-* or text-[..])';
const PLACED_BUTTON = '/(^|[\\s:])(absolute|-m[trblxy]?-[0-9])/';
const typeErrors = [
  {
    selector: `JSXAttribute[name.name='className'] Literal[value=${TYPE_OVERRIDE}]`,
    message: TYPE_MESSAGE,
  },
  {
    selector: `JSXAttribute[name.name='className'] TemplateElement[value.raw=${TYPE_OVERRIDE}]`,
    message: TYPE_MESSAGE,
  },
];
// Warn: these still have hits (placed IconButtons over media, raw inputs and
// headings, click-catcher divs); the ratchet blocks new ones.
const partWarnings = [
  // The trailing rule belongs to the part (ActionMenuTrigger, Row, HeaderBar,
  // Sheet), never an absolute or negative-margin IconButton at a call site.
  {
    selector: `JSXOpeningElement[name.name='IconButton'] JSXAttribute[name.name='className'] Literal[value=${PLACED_BUTTON}]`,
    message: 'Place a trailing IconButton through its part (the trailing rule), not by hand',
  },
  {
    selector: `JSXOpeningElement[name.name='IconButton'] JSXAttribute[name.name='className'] TemplateElement[value.raw=${PLACED_BUTTON}]`,
    message: 'Place a trailing IconButton through its part (the trailing rule), not by hand',
  },
  // Raw controls and headings outside ui/ (extends the no-raw-button rule).
  {
    selector: 'JSXOpeningElement[name.name=/^(input|textarea|select|h[1-6])$/]',
    message: 'Use ui/Input, ui/Textarea, ui/Select or a Text role / HeaderBar title',
  },
  {
    selector: "JSXOpeningElement[name.name='div'] > JSXAttribute[name.name='onClick']",
    message: 'A tappable surface is PressableRow / Button, never <div onClick>',
  },
];
// Chat: ChatCard is the bubble, so no rounded + filled wrapper around it.
const CHAT_CARD_FRAME =
  '/(^|\\s)rounded-[^\\s]*\\s(.*\\s)?bg-|(^|\\s)bg-[^\\s]*\\s(.*\\s)?rounded-/';
const chatCardFrame = {
  selector: `JSXElement:has(JSXOpeningElement[name.name='ChatCard']) > JSXOpeningElement > JSXAttribute[name.name='className'] Literal[value=${CHAT_CARD_FRAME}]`,
  message: 'ChatCard is the bubble: no hand-built rounded + bg frame around it',
};
const imgWarning = {
  selector: "JSXOpeningElement[name.name='img']",
  message: 'Use Avatar / Thumbnail / ui image parts (fixed size)',
};
const designPlugin = {
  rules: { 'warn-syntax': builtinRules.get('no-restricted-syntax') },
};
const LAYOUT_IGNORES = [
  'src/components/home/**',
  'src/components/test-site/**',
  'src/components/dev/**',
  'src/**/*.test.{ts,tsx}',
  'src/**/__tests__/**',
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
    // Layout and type rules with zero hits are errors in components: stacking
    // scale, ICON_SIZE, type roles. Raw <img> and part placement still warn.
    files: ['src/components/**/*.{ts,tsx}', 'src/pages/**/*.{ts,tsx}'],
    ignores: [...LAYOUT_IGNORES, 'src/components/ui/**'],
    plugins: { design: designPlugin },
    rules: {
      'no-restricted-syntax': ['error', rpcTraceId, ...designRules, ...layoutErrors, ...typeErrors],
      'design/warn-syntax': ['warn', imgWarning, ...partWarnings],
    },
  },
  {
    // B1: no hand-built card frame around ChatCard in chat/ (zero today: error).
    files: ['src/components/chat/**/*.{ts,tsx}'],
    ignores: LAYOUT_IGNORES,
    rules: {
      'no-restricted-syntax': [
        'error',
        rpcTraceId,
        ...designRules,
        ...layoutErrors,
        ...typeErrors,
        chatCardFrame,
      ],
    },
  },
  {
    // media/ owns the fixed-size image parts, so a raw <img> is its own.
    files: ['src/components/media/**/*.{ts,tsx}'],
    ignores: LAYOUT_IGNORES,
    plugins: { design: designPlugin },
    rules: {
      'design/warn-syntax': 'off',
    },
  },
  {
    // ui/ owns the raw elements and image parts; the stacking scale, ICON_SIZE
    // and type roles are errors here too, except in Text.tsx (the role table).
    files: ['src/components/ui/**/*.{ts,tsx}'],
    ignores: [...LAYOUT_IGNORES, 'src/components/ui/Text.tsx'],
    rules: {
      'no-restricted-syntax': ['error', rpcTraceId, ...layoutErrors, ...typeErrors],
    },
  },
  {
    files: ['src/components/ui/Text.tsx'],
    rules: {
      'no-restricted-syntax': ['error', rpcTraceId, ...layoutErrors],
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
