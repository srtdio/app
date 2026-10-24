import { expect, test, type Locator, type Page } from '@playwright/test';
import { installHarnessNetwork } from '../fixtures/harness-routes';
import { GROUP_NAME, MENTION_PREVIEW, PEER_NAME } from '../fixtures/chat-data';
import { checkStep, type StepReport } from '../fixtures/thread-checks';
import { expectButtonsMeetSystem } from '../helpers/button-system';

// Regression for the iPhone DM paint bug (#432): opening a DM showed the header
// and open-loops strip, then the composer row repeated down the screen and no
// messages. The real app tree (App.tsx: providers, AppLayout, ChatPage) runs
// against fixture data; Linux WebKit approximates iOS WebKit, it is not iOS.

interface Scenario {
  name: string;
  isDm: boolean;
  /** Land on the surface the user taps from. */
  start: string;
  /** The tap target that opens the thread. */
  target: (page: Page) => Locator;
}

const SCENARIOS: Scenario[] = [
  {
    name: 'dm-from-list',
    isDm: true,
    start: '/chat',
    target: (page) => page.getByText(PEER_NAME, { exact: true }).first(),
  },
  {
    // A chat mention's card on Notifications.
    name: 'dm-from-notifications',
    isDm: true,
    start: '/notifications',
    target: (page) =>
      page
        .locator('[data-activity-event="mention"]', { hasText: MENTION_PREVIEW })
        .locator('[data-activity-lead]')
        .first(),
  },
  {
    name: 'group-from-list',
    isDm: false,
    start: '/chat',
    target: (page) => page.getByText(GROUP_NAME, { exact: true }).first(),
  },
];

async function scrollList(page: Page, to: 'up' | 'bottom'): Promise<void> {
  await page.evaluate((where) => {
    const list = document.querySelector('[data-msg-id]')?.closest('ul');
    if (!list) return;
    list.scrollTop = where === 'up' ? Math.max(0, list.scrollTop - 1500) : list.scrollHeight;
    list.dispatchEvent(new Event('scroll'));
  }, to);
  await page.waitForTimeout(600);
}

for (const scenario of SCENARIOS) {
  test(`chat thread paints: ${scenario.name}`, async ({ page }, testInfo) => {
    const network = await installHarnessNetwork(page);
    const reports: StepReport[] = [];

    // First paint: hold the history read so the opening state is on screen.
    await page.goto(scenario.start);
    const target = scenario.target(page);
    await target.waitFor({ state: 'visible' });
    const gate = network.holdHistory();
    await target.click();
    await page.waitForTimeout(400);
    reports.push(
      await checkStep(page, `${scenario.name}-1-first-paint`, {
        allowSkeleton: true,
        requireComposer: false,
      }),
    );

    gate.release();
    await page
      .locator('[data-msg-id]')
      .first()
      .waitFor({ state: 'visible', timeout: 8000 })
      .catch(() => undefined);
    await page.waitForTimeout(800);
    reports.push(
      await checkStep(page, `${scenario.name}-2-loaded`, {
        allowSkeleton: false,
        requireComposer: true,
      }),
    );

    await scrollList(page, 'up');
    reports.push(
      await checkStep(page, `${scenario.name}-3-scrolled-up`, {
        allowSkeleton: false,
        requireComposer: true,
      }),
    );

    await scrollList(page, 'bottom');
    reports.push(
      await checkStep(page, `${scenario.name}-4-back-to-latest`, {
        allowSkeleton: false,
        requireComposer: true,
      }),
    );

    await testInfo.attach('checks.json', {
      body: JSON.stringify(reports, null, 2),
      contentType: 'application/json',
    });

    // No request left the harness and every fixture read was recognised.
    expect(network.blocked, 'blocked non-fixture requests').toEqual([]);
    expect([...new Set(network.unmatched)], 'unrecognised fixture requests').toEqual([]);
    for (const report of reports) {
      expect(report.failures, `${report.step}: ${report.failures.join('; ')}`).toEqual([]);
    }
    if (scenario.isDm) {
      // Read receipts survive: the peer read our last own message.
      await expect(page.getByText(/^Seen\b/).first()).toBeVisible();
    }
  });
}

test('chat thread: every button is 44 tall with an 8px radius or round', async ({ page }) => {
  await installHarnessNetwork(page);
  await page.goto('/chat');
  const row = page.getByText(PEER_NAME, { exact: true }).first();
  await row.waitFor({ state: 'visible' });
  await row.click();
  await page.locator('[data-msg-id]').first().waitFor({ state: 'visible', timeout: 8000 });
  await page.waitForTimeout(400);
  await expectButtonsMeetSystem(page);
});

// Type roles around the chat thread (design rules, locked 24 Oct 2026). The
// chat list's section labels are the shared section label (12px/600,
// uppercase). The thread itself keeps its chat-type.ts sizes (WhatsApp lock):
// a bubble body is 17px on touch, not the 14px app body. The Seen time is meta
// in the sans face with tabular numbers, never mono.
test(
  'chat thread type roles: list section label 12px uppercase, bubble 17px, Seen not mono',
  { tag: '@theme' },
  async ({ page }) => {
    const network = await installHarnessNetwork(page);
    await page.goto('/chat');
    const label = page.locator('[data-section-label]').first();
    await label.waitFor({ state: 'visible', timeout: 15_000 });
    const labelType = await label.evaluate((el) => {
      const s = getComputedStyle(el);
      return { size: s.fontSize, weight: s.fontWeight, transform: s.textTransform };
    });
    expect(labelType.size).toBe('12px');
    expect(labelType.weight).toBe('600');
    expect(labelType.transform).toBe('uppercase');

    const row = page.getByText(PEER_NAME, { exact: true }).first();
    await row.click();
    await page.locator('[data-msg-id]').first().waitFor({ state: 'visible', timeout: 8000 });
    await page.waitForTimeout(400);

    const body = page
      .locator('[data-bubble]', { hasText: MENTION_PREVIEW })
      .getByText(MENTION_PREVIEW)
      .first();
    await body.scrollIntoViewIfNeeded();
    expect(await body.evaluate((el) => getComputedStyle(el).fontSize)).toBe('17px');

    const seen = page.locator('[data-seen-line]').first();
    await expect(seen).toBeVisible();
    const families = await seen.evaluate((el) =>
      [el, ...Array.from(el.querySelectorAll('*'))].map((n) => getComputedStyle(n).fontFamily),
    );
    for (const family of families) {
      expect(family).not.toMatch(/JetBrains Mono|monospace/);
    }
    expect(network.blocked, 'blocked non-fixture requests').toEqual([]);
  },
);
