import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vitest/config';

// Dedicated config for the assets suite. Kept separate from the root vitest
// config so a plain `pnpm test` run never reaches a database: the DB-backed
// specs only execute when ASSETS_SUITE=1 (set here) and the global setup has a
// container ready. The pure specs (pipeline, repository dedup) need no gate and
// run in either config. Run with:
//   pnpm exec vitest run --config tests/assets/vitest.config.ts
export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('../../src', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    include: ['tests/assets/**/*.test.ts'],
    globalSetup: ['./tests/assets/setup.ts'],
    env: {
      ASSETS_SUITE: '1',
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
