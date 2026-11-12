import { expect, test, type Locator, type Page } from '@playwright/test';
import { installHarnessNetwork } from '../fixtures/harness-routes';
import { POST_IDS } from '../fixtures/chat-data';

// A long caption edited on the post page (phone, page mode, 390 wide): the
// page never moves by itself. Typing mid-text keeps the window still (the
// Textarea fit holds the scroll across its measure) and selecting a range
// mid-text never scrolls (the WritingBox reveal waits while a range is
// selected and lifts a tall box only with the caret at the end). The saved
// caption is exact.

const POST = POST_IDS[0] ?? '';
const LINES = Array.from({ length: 64 }, (_, i) => `Caption line ${i + 1} for the long edit`);
const CAPTION = LINES.join('\n');
// The caption box's line (16px type, 1.55 leading).
const LINE_PX = 25;
const MID_LINE = 30;

/** Two frames: the reveal runs on the next frame after a change. */
async function settle(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))),
  );
}

const scrollY = (page: Page): Promise<number> => page.evaluate(() => window.scrollY);

async function select(area: Locator, start: number, end: number): Promise<void> {
  await area.evaluate(
    (el, [s, e]) => {
      const t = el as HTMLTextAreaElement;
      t.setSelectionRange(s ?? 0, e ?? 0);
      t.dispatchEvent(new Event('select', { bubbles: true }));
      document.dispatchEvent(new Event('selectionchange'));
    },
    [start, end],
  );
}

test('Post caption: editing a long caption mid-text never moves the page', async ({ page }) => {
  const network = await installHarnessNetwork(page);
  const post = (network.world.tables.posts ?? []).find((p) => p.id === POST);
  if (post === undefined) throw new Error('fixture post missing');
  post.stage = 'draft';
  post.caption = CAPTION;
  await page.goto(`/posts/${POST}`);
  await expect(page.getByRole('heading', { name: 'Monday carousel', level: 1 })).toBeVisible({
    timeout: 15_000,
  });
  expect(page.viewportSize()?.width).toBe(390);

  await page.locator('[data-caption-edit]').first().click();
  const area = page.getByRole('textbox', { name: 'Caption', exact: true });
  await expect(area).toHaveValue(CAPTION);

  // Caret at the start of a middle line, that line in the middle of the screen.
  const at = LINES.slice(0, MID_LINE).join('\n').length + 1;
  await area.evaluate((el, line) => {
    const t = el as HTMLTextAreaElement;
    const y = t.getBoundingClientRect().top + window.scrollY + line * 25;
    window.scrollTo(0, Math.max(0, y - window.innerHeight / 2));
  }, MID_LINE);
  await area.focus();
  await select(area, at, at);
  await settle(page);

  // Typing mid-text: the window moves by no more than one line per step.
  let before = await scrollY(page);
  for (const ch of 'abcde') {
    await page.keyboard.type(ch);
    await settle(page);
    const now = await scrollY(page);
    expect(Math.abs(now - before)).toBeLessThanOrEqual(LINE_PX);
    before = now;
  }

  // Selecting a range mid-text: no move.
  const from = at + 2;
  await select(area, from, from + 30);
  await settle(page);
  await settle(page);
  expect(Math.abs((await scrollY(page)) - before)).toBeLessThanOrEqual(LINE_PX);
  await select(area, from - 10, from + 120);
  await settle(page);
  expect(Math.abs((await scrollY(page)) - before)).toBeLessThanOrEqual(LINE_PX);

  // Saved caption is the typed text, exact.
  const expected = `${CAPTION.slice(0, at)}abcde${CAPTION.slice(at)}`;
  await expect(area).toHaveValue(expected);
  await page.getByRole('button', { name: /^Save/ }).first().click();
  await expect
    .poll(
      () => network.rpcCalls.filter((c) => c.name === 'post_caption_update').at(-1)?.args.p_caption,
    )
    .toBe(expected);
  expect(network.blocked).toEqual([]);
});
