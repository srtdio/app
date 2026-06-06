import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vitest/config';

// Dedicated config for the auth E2E suite. Like the RLS suite it only runs when
// AUTH_SUITE=1 and the global setup has a Supabase container ready. The `@`
// alias mirrors the app build so specs can import the module under test from
// '@/server/auth'. Run with:
//   pnpm exec vitest run --config tests/auth/vitest.config.ts
export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('../../src', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    include: ['tests/auth/**/*.test.ts'],
    globalSetup: ['./tests/auth/setup.ts'],
    env: { AUTH_SUITE: '1' },
    hookTimeout: 180_000,
    testTimeout: 60_000,
    fileParallelism: false,
  },
});
