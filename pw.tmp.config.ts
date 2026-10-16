import { defineConfig, devices } from '@playwright/test';
import base from './playwright.config';
const iphone = { ...devices['iPhone 13'] } as Record<string, unknown>;
delete iphone.defaultBrowserType;
const exe = { executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' };
export default defineConfig({
  ...base,
  testDir: '/home/user/app/e2e/tests',
  outputDir: '/tmp/claude-0/e2e-results',
  webServer: { ...(base.webServer as object), cwd: '/home/user/app' } as never,
  projects: [
    { name: 'chromium-dark', use: { ...iphone, browserName: 'chromium', colorScheme: 'dark', launchOptions: exe } },
    { name: 'chromium-light', grep: /@theme/, use: { ...iphone, browserName: 'chromium', colorScheme: 'light', launchOptions: exe } },
  ],
});
