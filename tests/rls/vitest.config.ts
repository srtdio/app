import { defineConfig } from 'vitest/config';

// Dedicated config for the RLS suite. Kept separate from the root vitest config
// so the default `pnpm test` run never tries to reach a database: these specs
// only execute when RLS_SUITE=1 (set here) and the global setup has a container
// ready. Run with:  pnpm exec vitest run --config tests/rls/vitest.config.ts
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/rls/**/*.test.ts'],
    globalSetup: ['./tests/rls/setup.ts'],
    env: { RLS_SUITE: '1' },
    // Bringing up the stack and seeding auth users is slower than a unit test.
    hookTimeout: 180_000,
    testTimeout: 60_000,
    // One shared container; run files serially for deterministic ordering. Each
    // test still builds its own fixtures, so they remain independently runnable.
    fileParallelism: false,
  },
});
