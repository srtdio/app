import { defineConfig, devices } from '@playwright/test';

// iPhone visual checks in Playwright WebKit. Linux WebKit is close to, but not
// identical to, iOS Safari: use this to catch layout and paint regressions, not
// as proof of iOS parity. The harness under e2e/harness is a separate Vite entry
// and is never part of the app build.
//
// Speed: every spec runs once, in dark (iphone-webkit). The light project runs
// only tests tagged @theme (at most one per screen family: plan, chat thread,
// chat home, bell, pipeline) for light and dark parity. Screenshots and traces
// are kept on failure only.
const isCI = process.env.CI === 'true';
const port = 4178;

export default defineConfig({
  testDir: 'e2e/tests',
  outputDir: 'e2e/results',
  forbidOnly: isCI,
  fullyParallel: true,
  // Three workers on the 4-vCPU runner: the open-at-once paint test measures
  // against the app's 1s hold, and a fourth worker starves the browser of CPU.
  ...(isCI ? { workers: 3 } : {}),
  // Parallel workers share the runner's CPUs with Vite: long flows get
  // headroom (specs that set their own timeout keep it).
  timeout: 60_000,
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
      grep: /@theme/,
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
