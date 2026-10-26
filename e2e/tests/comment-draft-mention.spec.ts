import { expect, test } from '@playwright/test';
import { installHarnessNetwork, type HarnessNetwork } from '../fixtures/harness-routes';
import { PEER, POST_IDS } from '../fixtures/chat-data';

// A client tagged in a comment on a draft post: the @-mention picker does not
// offer clients on a draft, so the tag is the @[uuid] token typed by hand (the
// body carries it as is). comment_create's mention rule (the fixture mirrors
// the live proc) raises invalid_mention with the client's id as DETAIL; the
// one toast explains, and the composer keeps the typed text. PEER is a client
// member and the harness viewer (ME) is the owner. iPhone viewport, dark and
// light (@theme).

const POST = POST_IDS[0] ?? '';
const TOAST = "Clients can't see drafts. Tag them once it's in Review.";

function expectClean(network: HarnessNetwork): void {
  expect(network.blocked, 'blocked non-fixture requests').toEqual([]);
  expect(
    network.unmatched.filter((u) => u.includes('comment')),
    'unrecognised comment requests',
  ).toEqual([]);
}

/** Put the post in Draft before the page reads it. */
function makeDraft(network: HarnessNetwork): void {
  const post = (network.world.tables.posts ?? []).find((p) => p.id === POST);
  if (post === undefined) throw new Error('fixture post missing');
  post.stage = 'draft';
}

test('Draft post: tagging a client keeps the comment and shows the drafts toast @theme', async ({
  page,
}) => {
  const network = await installHarnessNetwork(page);
  makeDraft(network);
  await page.goto(`/posts/${POST}`);
  await expect(page.getByRole('heading', { name: 'Monday carousel', level: 1 })).toBeVisible({
    timeout: 15_000,
  });

  const section = page.locator('#post-comments');
  const box = section.getByRole('textbox', { name: 'Comment body', exact: true });
  await box.scrollIntoViewIfNeeded();
  await box.click();
  const text = `Over to @[${PEER}] for a look`;
  await page.keyboard.type(text);
  await expect(box).toHaveText(text);

  await section.getByRole('button', { name: 'Post', exact: true }).click();

  await expect(page.getByRole('status').getByText(TOAST, { exact: true })).toBeVisible();
  // The server refused it: nothing landed, and the draft is still in the box.
  const creates = network.rpcCalls.filter((c) => c.name === 'comment_create');
  expect(creates).toHaveLength(1);
  expect(String(creates[0]?.args.p_body)).toContain(`@[${PEER}]`);
  expect(network.world.tables.comments ?? []).toHaveLength(0);
  await expect(box).toHaveText(text);
  // The toast is the one explanation: no inline error under the composer.
  await expect(section.getByRole('alert')).toHaveCount(0);
  expectClean(network);
});
