import { expect, test, type Page } from '@playwright/test';
import { installHarnessNetwork } from '../fixtures/harness-routes';
import { POST_IDS, setHarnessPlatform } from '../fixtures/chat-data';
import { expectMinTouchTarget } from '../helpers/touch-target';

// A post's platform always equals its workspace's. The PCS "{Platform} preview"
// chip and panel name the workspace platform and list that platform's sizes.
// Tagged @theme for light and dark. Fixture names are fictional.

function workspaceLabel(page: Page) {
  return (page.viewportSize()?.width ?? 0) >= 768
    ? page.locator('aside button').first()
    : page.getByRole('button', { name: 'Switch workspace' });
}

const CASES = [
  { platform: 'linkedin', label: 'LinkedIn', format: 'carousel', size: '1200 x 627 · 1.91:1' },
  { platform: 'instagram', label: 'Instagram', format: 'carousel', size: '1080 x 566 · 1.91:1' },
] as const;

for (const c of CASES) {
  test(`a post in a ${c.label} workspace shows the ${c.label} preview @theme`, async ({ page }) => {
    const network = await installHarnessNetwork(page);
    setHarnessPlatform(network.world, c.platform, c.format);
    await page.goto(`/posts/${POST_IDS[0]}`);

    await expect(workspaceLabel(page)).toContainText(`Harness Studio - ${c.label}`, {
      timeout: 15_000,
    });
    const chip = page.getByRole('button', { name: `${c.label} preview` });
    await expect(chip).toBeVisible();
    expectMinTouchTarget(await chip.boundingBox());
    await chip.click();

    const panel = page.getByRole('dialog', { name: `${c.label} preview` });
    await expect(panel).toBeVisible();
    await expect(panel.getByRole('radio', { name: /Portrait/ })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    await expect(panel).toContainText(c.size);
    await page.keyboard.press('Escape');
    await expect(panel).toHaveCount(0);
    expect(network.blocked, 'blocked non-fixture requests').toEqual([]);
  });
}
