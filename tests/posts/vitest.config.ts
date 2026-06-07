import { defineConfig } from 'vitest/config';

// Dedicated config for the posts suite. These are pure boundary specs (stage
// machine, Zod validation, proc-error mapping): no database, no global setup, so
// they run fast and in isolation. Run with:
//   pnpm exec vitest run --config tests/posts/vitest.config.ts
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/posts/**/*.test.ts'],
  },
});
