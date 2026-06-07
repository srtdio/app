import { defineConfig } from 'vitest/config';

// Dedicated config for the RPC proc suite. Kept separate from the root vitest
// config so a plain `pnpm test` run never reaches a database: these specs only
// execute when RPC_SUITE=1 (set here) and the global setup has a container
// ready. Run with:  pnpm exec vitest run --config tests/rpc/vitest.config.ts
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/rpc/**/*.test.ts'],
    globalSetup: ['./tests/rpc/setup.ts'],
    env: { RPC_SUITE: '1' },
    // Bringing up the stack and seeding auth users is slower than a unit test.
    hookTimeout: 180_000,
    testTimeout: 60_000,
    // One shared container; run files serially for deterministic ordering.
    fileParallelism: false,
  },
});
