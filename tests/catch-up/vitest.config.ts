import { defineConfig } from 'vitest/config';

// Dedicated config for the catch-up suite (thread_started entries, thread
// mentions, inbox_mark_unread_ids). Kept out of the root vitest config so a
// plain `pnpm test` never reaches a database: the specs run only when
// CATCH_UP_SUITE=1 (set here). It boots the same local ephemeral Supabase stack
// as the RLS suite (tests/rls/setup.ts) and never touches the live project.
//   pnpm exec vitest run --config tests/catch-up/vitest.config.ts
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/catch-up/**/*.test.ts'],
    globalSetup: ['./tests/rls/setup.ts'],
    env: { CATCH_UP_SUITE: '1' },
    hookTimeout: 180_000,
    testTimeout: 60_000,
    fileParallelism: false,
    retry: process.env.CI === 'true' ? 1 : 0,
  },
});
