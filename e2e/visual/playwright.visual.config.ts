import { defineConfig, devices } from '@playwright/test';

// Visual lock: one screenshot per screen (screens.spec.ts) in WebKit, compared
// against the committed baselines in e2e/visual/__screenshots__/<project>/.
// A diff over 0.2% of the pixels fails. Not part of the root suite
// (playwright.config.ts reads e2e/tests only); CI runs it in
// .github/workflows/visual-ci.yml as 4 parallel shards (--shard=N/4; with
// fullyParallel each test lands in exactly one shard), gated by one `visual` check.
//
//   Check:   pnpm exec playwright test --config e2e/visual/playwright.visual.config.ts
//   Update:  pnpm exec playwright test --config e2e/visual/playwright.visual.config.ts --update-snapshots=all
//
// Baselines must be rendered on the CI WebKit image (fonts and antialiasing
// differ between machines): push a commit whose message contains
// [update-visual-baselines] and Visual CI renders and commits them to the PR.
//
// Three projects: iPhone 13 light and dark, and a 1280x800 laptop in light,
// plus laptop-dark running only the @laptop-dark shots (screens.spec.ts).
// Plus four touch tablet projects (iPad 820x1180 portrait and 1180x820
// landscape, hasTouch, light and dark) that run only the @tablet shots: the
// page-mode screens (src/lib/scroll-mode.ts TOUCH_TABLET_QUERY).
// The parts gallery (gallery.spec.ts, @gallery @laptop-dark) runs in the
// iphone-* and laptop-* projects, never in ipad-*, and alone in chrome-phone
// (Chromium, Pixel 7, light): no other screen runs in Chromium.
// Plus two narrow phones, phone-360 and phone-320 (iPhone 13 at 360 and 320
// wide, light): they run every layout check of screens.spec.ts and
// gallery.spec.ts (the phone rules, layout-checks-phone.ts, among them) and
// take NO screenshot (the specs skip toHaveScreenshot for a project named
// phone-*), so they have no folder under __screenshots__, never take part in
// a baseline refresh and never run emails.spec.ts.
// VISUAL_PORT picks the harness port (default 4195).
const isCI = process.env.CI === 'true';
const port = Number(process.env.VISUAL_PORT ?? 4195);

// One zone and locale everywhere, so dates and times render the same on
// every machine (the clock itself is fixed in screens.spec.ts).
const stable = { timezoneId: 'UTC', locale: 'en-US' } as const;

const phone = { ...devices['iPhone 13'], ...stable } as const;
/** A narrow phone: the iPhone 13 settings at another width, its height kept. */
const phoneAt = (width: number) =>
  ({ ...phone, viewport: { width, height: phone.viewport.height } }) as const;
/** The specs whose layout checks the phone-* projects run (no shot is taken). */
const CHECKS_ONLY = ['screens.spec.ts', 'gallery.spec.ts'];
const laptop = {
  ...stable,
  browserName: 'webkit',
  viewport: { width: 1280, height: 800 },
  deviceScaleFactor: 1,
  isMobile: false,
  hasTouch: false,
} as const;
const tablet = {
  ...stable,
  browserName: 'webkit',
  userAgent: devices['iPad (gen 7)'].userAgent,
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
} as const;
const portrait = { ...tablet, viewport: { width: 820, height: 1180 } } as const;
const landscape = { ...tablet, viewport: { width: 1180, height: 820 } } as const;
const TABLET = /@tablet/;
// The parts gallery (gallery.spec.ts) also runs once in Chrome on a phone.
const chromePhone = { ...devices['Pixel 7'], ...stable } as const;

export default defineConfig({
  testDir: '.',
  testMatch: ['screens.spec.ts', 'emails.spec.ts', 'gallery.spec.ts'],
  snapshotPathTemplate: '{testDir}/__screenshots__/{projectName}/{arg}{ext}',
  // e2e/results is gitignored; the html report sits beside, never inside, outputDir.
  outputDir: '../results/visual',
  forbidOnly: isCI,
  fullyParallel: true,
  // 2 per CI shard: ubuntu-latest has 4 vCPUs and also runs the harness Vite
  // server, so 4 WebKit workers oversubscribed it. Speed comes from the 4
  // parallel shards in visual-ci.yml, not from more workers per runner.
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
    { name: 'iphone-light', use: { ...phone, colorScheme: 'light' }, grepInvert: TABLET },
    { name: 'iphone-dark', use: { ...phone, colorScheme: 'dark' }, grepInvert: TABLET },
    { name: 'laptop-light', use: { ...laptop, colorScheme: 'light' }, grepInvert: TABLET },
    {
      name: 'laptop-dark',
      use: { ...laptop, colorScheme: 'dark' },
      grep: /@laptop-dark/,
      grepInvert: TABLET,
    },
    { name: 'ipad-portrait-light', use: { ...portrait, colorScheme: 'light' }, grep: TABLET },
    { name: 'ipad-portrait-dark', use: { ...portrait, colorScheme: 'dark' }, grep: TABLET },
    { name: 'ipad-landscape-light', use: { ...landscape, colorScheme: 'light' }, grep: TABLET },
    { name: 'ipad-landscape-dark', use: { ...landscape, colorScheme: 'dark' }, grep: TABLET },
    { name: 'chrome-phone', use: { ...chromePhone, colorScheme: 'light' }, grep: /@gallery/ },
    {
      name: 'phone-360',
      use: { ...phoneAt(360), colorScheme: 'light' },
      testMatch: CHECKS_ONLY,
      grepInvert: TABLET,
    },
    {
      name: 'phone-320',
      use: { ...phoneAt(320), colorScheme: 'light' },
      testMatch: CHECKS_ONLY,
      grepInvert: TABLET,
    },
  ],
  webServer: {
    command: `pnpm exec vite --config e2e/harness/vite.config.ts --port ${port} --strictPort`,
    cwd: '../..',
    url: `http://localhost:${port}`,
    reuseExistingServer: !isCI,
    timeout: 90_000,
  },
});
