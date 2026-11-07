import { expect, test, type Locator, type Page } from '@playwright/test';
import { installHarnessNetwork, type HarnessNetwork } from '../fixtures/harness-routes';
import { ME, PEER, POST_IDS, WORKSPACE_ID } from '../fixtures/chat-data';
import { undoStrip } from '../helpers/undo-strip';

// Post comments swipe both ways on touch (CLAUDE.md Swipe: right = Reply,
// left = Delete), through the one core (src/lib/chat/swipe-reply.ts). Right
// opens the row's reply composer on anyone's comment. Left on the viewer's own
// comment is the ⋯ menu's Delete (the row hides, the Undo strip says "Comment
// deleted", Undo brings it back); on someone else's comment it only
// rubber-bands and nothing opens. The real app tree runs against fixture
// data; Linux WebKit approximates iOS WebKit, it is not iOS.

const POST = POST_IDS[0] ?? '';
const OWN_ID = '0190f200-0000-7000-8000-0000000000e1';
const PEER_ID = '0190f200-0000-7000-8000-0000000000e2';
const OWN_BODY = 'My own note on the hook line';
const PEER_BODY = 'Their note on the cover photo';

function comment(id: string, author: string, body: string, ago: number): Record<string, unknown> {
  return {
    id,
    workspace_id: WORKSPACE_ID,
    entity_type: 'post',
    entity_id: POST,
    author_user_id: author,
    body,
    parent_comment_id: null,
    attachment_asset_ids: null,
    mentions: null,
    created_at: new Date(Date.now() - ago).toISOString(),
    edited_at: null,
    deleted_at: null,
    legacy_author_name: null,
    legacy_author_email: null,
    ledger_seq: null,
    ledger_batch_id: null,
    resolved_at: null,
    resolved_by: null,
    resolved_version_id: null,
    resolution_note: null,
    asked_at: null,
    asked_by: null,
    sent_back_at: null,
    sent_back_by: null,
    closed_at: null,
    closed_by: null,
    accepted_at: null,
    accepted_by: null,
    unaccepted_at: null,
    unaccepted_by: null,
  };
}

/** One comment by the viewer and one by a peer on the first post. */
function seedComments(network: HarnessNetwork): void {
  const rows = (network.world.tables.comments ??= []);
  rows.push(comment(OWN_ID, ME, OWN_BODY, 60_000));
  rows.push(comment(PEER_ID, PEER, PEER_BODY, 120_000));
}

/** A comment's own sliding row (not a reply's under it). */
function rowOf(page: Page, id: string): Locator {
  return page.locator(`#post-comments [id="comment-${id}"] [data-comment-row]`).first();
}

function composerUnder(page: Page, id: string): Locator {
  return page.locator(`#post-comments [id="comment-${id}"] [data-reply-composer]`);
}

/** A finger drags a row by dx px (left when negative) and lets go, on touch. */
async function swipeRow(row: Locator, dx: number): Promise<void> {
  await row.scrollIntoViewIfNeeded();
  const box = await row.boundingBox();
  if (box === null) throw new Error('row has no box');
  const y = box.y + Math.min(box.height / 2, 24);
  const x0 = box.x + box.width / 2;
  const touch = { pointerType: 'touch', pointerId: 7, isPrimary: true, clientY: y };
  // Park the cursor off the row: a cursor over the row sends a pointermove
  // when the row slides under it, which drags the swipe back.
  await row.page().mouse.move(1, 1);
  await row.dispatchEvent('pointerdown', { ...touch, clientX: x0 });
  const steps = 8;
  for (let i = 1; i <= steps; i += 1) {
    await row.dispatchEvent('pointermove', { ...touch, clientX: x0 + (dx * i) / steps });
  }
  await row.dispatchEvent('pointerup', { ...touch, clientX: x0 + dx });
}

test('post comments swipe right to Reply and left to Delete (own only) @theme', async ({
  page,
}) => {
  const network = await installHarnessNetwork(page);
  seedComments(network);
  await page.goto(`/posts/${POST}`);
  await expect(page.getByRole('heading', { name: 'Monday carousel', level: 1 })).toBeVisible({
    timeout: 15_000,
  });
  const own = rowOf(page, OWN_ID);
  const peer = rowOf(page, PEER_ID);
  await expect(own).toContainText(OWN_BODY);
  await expect(peer).toContainText(PEER_BODY);

  // The row slides on its own: vertical scroll stays the list's, and a slid
  // row never makes anything scroll sideways.
  expect(await own.evaluate((el) => getComputedStyle(el).touchAction)).toContain('pan-y');
  expect(await own.evaluate((el) => getComputedStyle(el.parentElement as Element).overflowX)).toBe(
    'clip',
  );

  // Someone else's comment, left: a rubber band, nothing opens or goes.
  await swipeRow(peer, -120);
  await expect(peer).toContainText(PEER_BODY);
  await expect(undoStrip(page)).toHaveCount(0);
  await expect(page.getByRole('menu')).toHaveCount(0);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(peer).not.toHaveAttribute('style', /translate/);

  // Right on someone else's comment: its reply composer opens.
  await swipeRow(peer, 120);
  await expect(composerUnder(page, PEER_ID)).toBeVisible();
  await expect(peer.locator('[data-row-action="reply"]')).toHaveText('Cancel');

  // Right on the viewer's own comment: the same.
  await swipeRow(own, 120);
  await expect(composerUnder(page, OWN_ID)).toBeVisible();

  // Left on the viewer's own comment: the ⋯ menu's Delete (Undo strip).
  await swipeRow(own, -120);
  await expect(page.locator('#post-comments').getByText(OWN_BODY)).toHaveCount(0);
  const strip = undoStrip(page, 'Comment deleted');
  await expect(strip).toBeVisible();
  await strip.getByRole('button', { name: 'Undo' }).click();
  await expect(rowOf(page, OWN_ID)).toContainText(OWN_BODY);

  expect(network.blocked, 'blocked non-fixture requests').toEqual([]);
});
