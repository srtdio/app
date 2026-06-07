import { defineConfig } from 'vitest/config';

// Dedicated config for the comments suite. Kept separate from the root vitest
// config so a plain `pnpm test` run never reaches a database: the DB-backed
// specs only execute when COMMENTS_SUITE=1 (set here) and the global setup has a
// container ready. The pure mentions-parser unit test has no such guard and so
// also runs under the root config. Run with:
//   pnpm exec vitest run --config tests/comments/vitest.config.ts
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/comments/**/*.test.ts'],
    globalSetup: ['./tests/comments/setup.ts'],
    env: { COMMENTS_SUITE: '1' },
    // Bringing up the stack and seeding auth users is slower than a unit test.
    hookTimeout: 180_000,
    testTimeout: 60_000,
    // One shared container; run files serially for deterministic ordering.
    fileParallelism: false,
  },
});
