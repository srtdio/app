import { defineConfig } from 'vitest/config';

// Dedicated config for the workspace + invite suite. Kept separate from the root
// vitest config so a plain `pnpm test` run never reaches a database: the
// DB-backed specs only execute when WORKSPACE_SUITE=1 (set here) and the global
// setup has a container ready. The pure unit specs run under either config.
// Run with:  pnpm exec vitest run --config tests/workspace/vitest.config.ts
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/workspace/**/*.test.ts'],
    globalSetup: ['./tests/workspace/setup.ts'],
    env: { WORKSPACE_SUITE: '1' },
    // Bringing up the stack and seeding auth users is slower than a unit test.
    hookTimeout: 180_000,
    testTimeout: 60_000,
    // One shared container; run files serially for deterministic ordering.
    fileParallelism: false,
  },
});
