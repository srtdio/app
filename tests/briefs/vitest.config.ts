import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vitest/config';

// Dedicated config for the briefs suite. Kept separate from the root vitest
// config so a plain `pnpm test` run never reaches a database: the integration,
// RLS, and no-update DB specs only execute when BRIEFS_SUITE=1 (set here) and the
// global setup has a container ready. The pure-unit specs guard themselves and
// run in either config. Run with:
//   pnpm exec vitest run --config tests/briefs/vitest.config.ts
export default defineConfig({
  resolve: {
    alias: {
      // src/lib/brief-list reads the fill count (src/lib/use-fill-count), which uses '@/'.
      '@': fileURLToPath(new URL('../../src', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    include: ['tests/briefs/**/*.test.ts'],
    globalSetup: ['./tests/briefs/setup.ts'],
    env: {
      BRIEFS_SUITE: '1',
      // src/lib modules read the Zod-validated env on import (root config does the same).
      VITE_SUPABASE_URL: 'https://test.supabase.co',
      VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test_000000000000',
    },
    // Bringing up the stack and seeding auth users is slower than a unit test.
    hookTimeout: 180_000,
    testTimeout: 60_000,
    // One shared container; run files serially for deterministic ordering.
    fileParallelism: false,
  },
});
