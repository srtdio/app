import { defineConfig } from 'vitest/config';

// Dedicated config for the ETL suite. These are pure boundary specs (transform
// mappings + config guards): no database, no global setup, so they run fast and
// in isolation. CI never connects to a real database. Run with:
//   pnpm exec vitest run --config tests/etl/vitest.config.ts
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/etl/**/*.test.ts'],
  },
});
