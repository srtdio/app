import { defineConfig, devices } from '@playwright/test';

// iPhone visual checks in Playwright WebKit. Linux WebKit is close to, but not
// identical to, iOS Safari: use this to catch layout and paint regressions, not
// as proof of iOS parity. The harness under e2e/harness is a separate Vite entry
// and is never part of the app build.
const isCI = process.env.CI === 'true';
const port = 4178;

export default defineConfig({
  testDir: 'e2e/tests',
  outputDir: 'e2e/results',
  forbidOnly: isCI,
  retries: isCI ? 1 : 0,
  reporter: isCI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: `http://localhost:${port}`,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'iphone-webkit',
      use: { ...devices['iPhone 13'], colorScheme: 'dark' },
    },
    {
      name: 'iphone-webkit-light',
      // Light parity is covered by the paint specs; the rest run dark only.
      testMatch: [
        'smoke.spec.ts',
        'chat-thread.spec.ts',
        'chat-plan-card-paint.spec.ts',
        'chat-status-ticker.spec.ts',
      ],
      use: { ...devices['iPhone 13'], colorScheme: 'light' },
    },
  ],
  webServer: {
    command: `pnpm exec vite --config e2e/harness/vite.config.ts --port ${port} --strictPort`,
    url: `http://localhost:${port}`,
    reuseExistingServer: !isCI,
    timeout: 60_000,
  },
});
