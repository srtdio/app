import { expect, test, type Page } from '@playwright/test';
import { installHarnessNetwork } from '../fixtures/harness-routes';
import {
  FREE_ID,
  FREE_NAME,
  installDeletedRoutes,
  seedRecentlyDeleted,
  type DeletedRoutes,
} from '../fixtures/assets-recently-deleted';
import { expectMinTouchTarget } from './touch-target';
import { swipeStripDown, undoStrip } from './undo-strip';

// Every Undo toast is the bottom strip: on the iPhone viewport it spans the
// width with 16px side margins and floats 8px above the bottom tab bar
// (data-undo-anchor); label left, Undo right, no X and no countdown bar. A
// short swipe down snaps back; a swipe past 40% of its height accepts, so the
// action commits at once. Uses the Assets delete (one Undo) as the trigger.
// Linux WebKit approximates iOS WebKit; it is not iOS.

const LABEL = 'File deleted';

async function setup(page: Page): Promise<{ calls: DeletedRoutes; errors: string[] }> {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const network = await installHarnessNetwork(page);
  seedRecentlyDeleted(network);
  const calls = await installDeletedRoutes(page, network);
  return { calls, errors };
}

async function deleteFromViewer(page: Page, name: string): Promise<void> {
  await page.getByRole('button', { name: `View ${name}`, exact: true }).click();
  const viewer = page.getByLabel(`Viewing ${name}`);
  await viewer.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(viewer).toHaveCount(0);
}

/** Registers the undo strip tests; called from an area spec (see scripts/ci/e2e-areas.ts). */
export function undoStripCases(): void {
  test.describe('undo strip', () => {
    test('the Undo strip sits above the tab bar: label, Undo, no X, swipe down commits', async ({
      page,
    }) => {
      const { calls, errors } = await setup(page);
      await page.goto('/assets');
      const card = page.getByRole('button', { name: `View ${FREE_NAME}`, exact: true });
      await expect(card).toBeVisible({ timeout: 15_000 });

      await deleteFromViewer(page, FREE_NAME);
      await expect(card).toHaveCount(0);

      const strip = undoStrip(page, LABEL);
      await expect(strip).toBeVisible();
      await expect(strip).toHaveAttribute('role', 'status');
      await expect(strip).toHaveAttribute('aria-live', 'polite');

      // Label left, Undo right; nothing else inside.
      const undo = strip.getByRole('button', { name: 'Undo', exact: true });
      await expect(undo).toBeVisible();
      expectMinTouchTarget(await undo.boundingBox());
      await expect(strip.getByRole('button')).toHaveCount(1);
      await expect(strip.getByRole('button', { name: 'Dismiss notification' })).toHaveCount(0);
      await expect(strip.locator('[data-toast-countdown]')).toHaveCount(0);
      await expect(strip.locator('svg')).toHaveCount(0);
      // Not a top card: one strip with the label, and no card X anywhere.
      await expect(undoStrip(page, LABEL)).toHaveCount(1);
      await expect(page.getByRole('button', { name: 'Dismiss notification' })).toHaveCount(0);

      // Geometry: 16px side margins, 8px above the bottom tab bar.
      await strip.evaluate(async (el) => {
        await Promise.all(el.getAnimations().map((anim) => anim.finished));
      });
      const viewport = page.viewportSize();
      if (viewport === null) throw new Error('no viewport');
      const box = await strip.boundingBox();
      const nav = await page.locator('nav[data-undo-anchor]').boundingBox();
      if (box === null || nav === null) throw new Error('strip or tab bar not laid out');
      expect(box.x).toBeCloseTo(16, 0);
      expect(viewport.width - (box.x + box.width)).toBeCloseTo(16, 0);
      expect(nav.y - (box.y + box.height)).toBeCloseTo(8, 0);
      expect(box.height).toBeGreaterThanOrEqual(50 - 0.01);
      // The Undo button is at the strip's right end.
      const undoBox = await undo.boundingBox();
      if (undoBox === null) throw new Error('Undo not laid out');
      expect(undoBox.x + undoBox.width).toBeGreaterThan(box.x + box.width - 16);

      // A short swipe snaps back: still live, nothing written.
      await swipeStripDown(page, strip, 0.2);
      await expect(strip).toBeVisible();
      expect(calls.rpc).toEqual([]);

      // A swipe past 40% accepts: the strip leaves and the delete commits once.
      await swipeStripDown(page, strip, 0.7);
      await expect(undoStrip(page)).toHaveCount(0);
      await expect.poll(() => calls.rpc.length).toBe(1);
      expect(calls.rpc).toEqual([
        { name: 'asset_delete', args: { p_asset_id: FREE_ID, p_trace_id: expect.any(String) } },
      ]);
      await expect(card).toHaveCount(0);
      expect(errors).toEqual([]);
    });

    test('Undo in the strip brings the file back and writes nothing', async ({ page }) => {
      const { calls } = await setup(page);
      await page.goto('/assets');
      const card = page.getByRole('button', { name: `View ${FREE_NAME}`, exact: true });
      await expect(card).toBeVisible({ timeout: 15_000 });
      await deleteFromViewer(page, FREE_NAME);
      const strip = undoStrip(page, LABEL);
      await strip.getByRole('button', { name: 'Undo', exact: true }).click();
      await expect(card).toBeVisible();
      await expect(undoStrip(page)).toHaveCount(0);
      // The 4s window passing afterwards never commits.
      await page.waitForTimeout(4_500);
      expect(calls.rpc).toEqual([]);
    });
  });
}
