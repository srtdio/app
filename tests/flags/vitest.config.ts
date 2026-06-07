import { defineConfig } from 'vitest/config';

// Dedicated config for the feature-flag e2e suite. Like the RLS suite, it only
// runs against a local Supabase container and gates the DB-backed specs on
// RLS_SUITE=1. Reuses the RLS global setup, which brings up (or reuses) the
// local stack and writes the connection handoff. Run with:
//   pnpm exec vitest run --config tests/flags/vitest.config.ts
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/flags/**/*.test.ts'],
    // Resolved relative to the project root (repo root), like tests/rls's config.
    globalSetup: ['./tests/rls/setup.ts'],
    env: { RLS_SUITE: '1' },
    hookTimeout: 180_000,
    testTimeout: 120_000,
    fileParallelism: false,
  },
});
