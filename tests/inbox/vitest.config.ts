import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

// Dedicated config for the inbox-writer suite. Kept separate from the root
// vitest config so a plain `pnpm test` run never reaches a database: these specs
// only execute when INBOX_SUITE=1 (set here) and the global setup has a
// container ready. Run with:
//   pnpm exec vitest run --config tests/inbox/vitest.config.ts
export default defineConfig({
  // The Worker imports the package by its bare specifier (@srtdio/inbox); the
  // tsconfig `paths` cover type-checking, this alias covers the test runtime.
  // (@srtdio/schemas already resolves via its node_modules workspace symlink.)
  resolve: {
    alias: {
      '@srtdio/inbox': resolve(process.cwd(), 'packages/inbox/src/index.ts'),
    },
  },
  test: {
    environment: 'node',
    include: ['tests/inbox/**/*.test.ts'],
    globalSetup: ['./tests/inbox/setup.ts'],
    env: { INBOX_SUITE: '1' },
    // Bringing up the stack and seeding auth users is slower than a unit test.
    hookTimeout: 180_000,
    testTimeout: 60_000,
    // One shared container; run files serially for deterministic ordering.
    fileParallelism: false,
  },
});
