import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vitest/config';

// Unit test config. Kept separate from vite.config.ts so tests do not load the
// Sentry build plugin. The Zod-validated env (src/lib/env.ts) is satisfied with
// dummy values so importing modules under test never throws.
export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    env: {
      VITE_SUPABASE_URL: 'https://test.supabase.co',
      VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test_000000000000',
    },
  },
});
