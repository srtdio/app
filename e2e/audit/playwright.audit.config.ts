import { defineConfig, devices } from '@playwright/test';

// Audit captures for PR B (before/after screenshots), not a test suite: CI
// never runs this config (playwright.config.ts only reads e2e/tests). Run it
// from the checkout to capture:
//
//   AUDIT_OUT=/abs/out/dir pnpm exec playwright test --config e2e/audit/playwright.audit.config.ts
//
// Four projects: phone (iPhone 13) and laptop (1280x800), each light and dark.
// Chromium by default (AUDIT_BROWSER=webkit to use WebKit when installed).
// AUDIT_PORT picks the harness port (default 4191); a server already on it is reused.
const port = Number(process.env.AUDIT_PORT ?? 4191);
const browserName = process.env.AUDIT_BROWSER === 'webkit' ? 'webkit' : 'chromium';

const phone = { ...devices['iPhone 13'], browserName } as const;
const laptop = {
  browserName,
  viewport: { width: 1280, height: 800 },
  deviceScaleFactor: 1,
  isMobile: false,
  hasTouch: false,
} as const;

export default defineConfig({
  testDir: '.',
  testMatch: process.env.AUDIT_MATCH ?? 'capture-pr-b.spec.ts',
  outputDir: '../results/audit',
  fullyParallel: true,
  workers: Number(process.env.AUDIT_WORKERS ?? 3),
  timeout: 90_000,
  expect: { timeout: 8_000 },
  retries: 0,
  reporter: 'list',
  use: {
    baseURL: `http://localhost:${port}`,
    screenshot: 'off',
    trace: 'off',
    permissions: browserName === 'chromium' ? ['clipboard-read', 'clipboard-write'] : [],
  },
  projects: [
    { name: 'phone-light', use: { ...phone, colorScheme: 'light' } },
    { name: 'phone-dark', use: { ...phone, colorScheme: 'dark' } },
    { name: 'laptop-light', use: { ...laptop, colorScheme: 'light' } },
    { name: 'laptop-dark', use: { ...laptop, colorScheme: 'dark' } },
  ],
  webServer: {
    command: `pnpm exec vite --config e2e/harness/vite.config.ts --port ${port} --strictPort`,
    cwd: '../..',
    url: `http://localhost:${port}`,
    reuseExistingServer: true,
    timeout: 90_000,
  },
});
