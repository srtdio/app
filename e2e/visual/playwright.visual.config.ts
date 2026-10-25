import { defineConfig, devices } from '@playwright/test';

// Visual lock: one screenshot per screen (screens.spec.ts) in WebKit, compared
// against the committed baselines in e2e/visual/__screenshots__/<project>/.
// A diff over 0.2% of the pixels fails. Not part of the root suite
// (playwright.config.ts reads e2e/tests only); CI runs it in
// .github/workflows/visual-ci.yml.
//
//   Check:   pnpm exec playwright test --config e2e/visual/playwright.visual.config.ts
//   Update:  pnpm exec playwright test --config e2e/visual/playwright.visual.config.ts --update-snapshots
//
// Baselines must be rendered on the CI WebKit image (fonts and antialiasing
// differ between machines): push a commit whose message contains
// [update-visual-baselines] and Visual CI renders and commits them to the PR.
//
// Three projects: iPhone 13 light and dark, and a 1280x800 laptop in light.
// VISUAL_PORT picks the harness port (default 4195).
const isCI = process.env.CI === 'true';
const port = Number(process.env.VISUAL_PORT ?? 4195);

// One zone and locale everywhere, so dates and times render the same on
// every machine (the clock itself is fixed in screens.spec.ts).
const stable = { timezoneId: 'UTC', locale: 'en-US' } as const;

const phone = { ...devices['iPhone 13'], ...stable } as const;
const laptop = {
  ...stable,
  browserName: 'webkit',
  viewport: { width: 1280, height: 800 },
  deviceScaleFactor: 1,
  isMobile: false,
  hasTouch: false,
} as const;

export default defineConfig({
  testDir: '.',
  testMatch: 'screens.spec.ts',
  snapshotPathTemplate: '{testDir}/__screenshots__/{projectName}/{arg}{ext}',
  // e2e/results is gitignored; the html report sits beside, never inside, outputDir.
  outputDir: '../results/visual',
  forbidOnly: isCI,
  fullyParallel: true,
  workers: isCI ? 2 : 3,
  timeout: 90_000,
  expect: {
    timeout: isCI ? 10_000 : 5_000,
    toHaveScreenshot: { maxDiffPixelRatio: 0.002, animations: 'disabled', caret: 'hide' },
  },
  retries: 0,
  reporter: isCI
    ? [['list'], ['html', { open: 'never', outputFolder: '../results/visual-report' }]]
    : 'list',
  use: {
    baseURL: `http://localhost:${port}`,
    screenshot: 'off',
    trace: 'off',
  },
  projects: [
    { name: 'iphone-light', use: { ...phone, colorScheme: 'light' } },
    { name: 'iphone-dark', use: { ...phone, colorScheme: 'dark' } },
    { name: 'laptop-light', use: { ...laptop, colorScheme: 'light' } },
  ],
  webServer: {
    command: `pnpm exec vite --config e2e/harness/vite.config.ts --port ${port} --strictPort`,
    cwd: '../..',
    url: `http://localhost:${port}`,
    reuseExistingServer: !isCI,
    timeout: 90_000,
  },
});
