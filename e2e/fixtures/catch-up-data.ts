// Catch up's visual fixtures (9 Nov 2026 rebuild: one card per ITEM). Each
// seed adds the rows readCatchUpBodies (src/lib/catch-up/body.ts) and
// readCatchUpChat (reads.ts) read for one card, plus the unread inbox entry
// that makes it, on top of the shared chat world (chat-data.ts):
//   posts by id IN; asset_attachments (entity_type post) with the embedded
//   asset_versions { mime_type } (the !inner embed); top-level comments by
//   entity_id IN (parent_comment_id null) and reply counts by parent IN;
//   briefs, plan_items, plans by id IN; plan_item_comments by item_id IN;
//   the entries' read state by id IN; chat messages by id IN, the main chat's
//   newest top-level messages by channel_id IN and reply counts by
//   thread_root_message_id IN.
// The harness PostgREST does not apply projections, so every comment row
// carries the ledger columns (ledger_batch_id / ledger_seq / closed_at /
// accepted_at) as null when unused: a missing column reads undefined, which
// body.ts would take for a feedback batch.

import type { HarnessNetwork } from './harness-routes';
import type { Row } from './postgrest';
import {
  BUCKET_ID,
  COLLEAGUE_A,
  COLLEAGUE_B,
  ME,
  PEER,
  THREAD_GROUP,
  THREAD_IDS,
  WORKSPACE_ID,
} from './chat-data';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const iso = (ms: number): string => new Date(ms).toISOString();

/** Deterministic ids in the fixture style: one hex group per table. */
function cid(group: number, n: number): string {
  return `0190f1d0-0000-7000-8${group.toString(16)}00-${n.toString(16).padStart(12, '0')}`;
}
const ENTRY = 1;
const POST = 2;
const COMMENT = 3;
const ATTACH = 4;
const VERSION = 5;
const PLAN = 6;
const BRIEF = 7;
const CHAT = 8;
const USER = 9;

// ---------------------------------------------------------------------------
// Ids the spec opens (/activity?catchup=<entry id>).

/** The post at rest: caption + 5 pictures, two comments (one with a reply). */
export const CU_REST_POST = cid(POST, 1);
export const CU_REST_ENTRY = cid(ENTRY, 1);
/** A text-only post (caption, no pictures). */
export const CU_TEXT_POST = cid(POST, 2);
export const CU_TEXT_ENTRY = cid(ENTRY, 2);
/** A video post. */
export const CU_VIDEO_POST = cid(POST, 3);
export const CU_VIDEO_ENTRY = cid(ENTRY, 3);
/** A post whose comment's author has a 25-character name. */
export const CU_LONG_NAME_ENTRY = cid(ENTRY, 4);
/** A post with a 90-character title. */
export const CU_LONG_TITLE_ENTRY = cid(ENTRY, 5);
/** A post with a 1,200-character caption. */
export const CU_LONG_CAPTION_ENTRY = cid(ENTRY, 6);
/** A comment of 34 emoji. */
export const CU_EMOJI_ENTRY = cid(ENTRY, 7);
/** A comment holding a 120-character unbroken link. */
export const CU_LINK_ENTRY = cid(ENTRY, 8);
/** A comment with 10 blank lines inside it. */
export const CU_BLANK_LINES_ENTRY = cid(ENTRY, 9);
/** 50 new comments on one post: the newest entry (all 50 are unread entries). */
export const CU_MANY_ENTRY = cid(ENTRY, 0x100 + 50);
/** A feedback batch (3 points, one resolved) with a comment and a stage change. */
export const CU_FEEDBACK_POST = cid(POST, 10);
export const CU_FEEDBACK_ENTRY = cid(ENTRY, 10);
export const CU_FEEDBACK_BATCH = cid(COMMENT, 0x200);
/** A plan item with a plan comment. */
export const CU_PLAN_ENTRY = cid(ENTRY, 11);
/** A bank idea with a comment. */
export const CU_IDEA_ENTRY = cid(ENTRY, 12);
/** A brief created for me, no due day. */
export const CU_BRIEF_ENTRY = cid(ENTRY, 13);
/** A one-message DM (chat-main). */
export const CU_CHAT_MAIN_ENTRY = cid(ENTRY, 14);
/** Thread crew's main chat: a mention on a top-level message; the root above has 4 replies. */
export const CU_GROUP_MAIN_ENTRY = cid(ENTRY, 15);

/** The 25-character display name. */
export const CU_LONG_NAME = 'Bartholomew Fitzgerald Jr';
/** The 90-character post title. */
export const CU_LONG_TITLE =
  'Autumn lookbook carousel for the new knitwear range with the warm morning light and covers';
/** 34 emoji, one comment. */
export const CU_EMOJI = [
  '😀😃😄😁😆😅😂🙂🙃😉😊😇',
  '😍😘😗😙😚😋😛😜😝🤑🤗🤔',
  '🤐😐😑😶😏😒🙄😬😌😔',
].join('');
/** A 120-character link with no break in it. */
const LINK_HEAD = 'https://example.com/autumn/';
export const CU_LONG_LINK = `${LINK_HEAD}${'k'.repeat(120 - LINK_HEAD.length)}`;
/** The one-message DM's peer, as a user id (COLLEAGUE_A) and its channel. */
const CU_DM_CHANNEL = `dm__${WORKSPACE_ID}__${ME}__${COLLEAGUE_A}`;
const CU_LONG_NAME_USER = cid(USER, 1);

const CAPTION = [
  'Five looks for the first cold week.',
  'Swipe for the knit, the coat and the scarf.',
  'Shop the range from Friday.',
].join('\n');

/** A 1,200-character caption (sentences, line breaks, no word over 12 letters). */
export const CU_LONG_CAPTION = (() => {
  const lines = [
    'The autumn range lands on Friday with five looks built around one warm palette.',
    'Each slide pairs a knit with a coat, shot in morning light at the old mill.',
    'Tag the store you will visit and we will hold a size for you until Sunday.',
    'Free returns in store for thirty days, and the scarf is on us with any coat.',
  ];
  let text = '';
  for (let i = 0; text.length < 1_200; i += 1) {
    text += `${lines[i % lines.length] ?? ''}${i % 2 === 1 ? '\n' : ' '}`;
  }
  return text.slice(0, 1_200);
})();

// ---------------------------------------------------------------------------
// Row builders.

function entry(id: string, now: number, minsAgo: number, row: Row): Row {
  return {
    id,
    user_id: ME,
    workspace_id: WORKSPACE_ID,
    tier: 'active',
    scope: 'posts',
    scope_key: null,
    read_at: null,
    snoozed_until: null,
    email_sent_at: null,
    deleted_at: null,
    created_at: iso(now - minsAgo * MINUTE),
    ...row,
  };
}

function postRow(
  id: string,
  number: number,
  now: number,
  fields: { title: string; caption: string | null; format: string },
): Row {
  return {
    id,
    number,
    workspace_id: WORKSPACE_ID,
    title: fields.title,
    caption: fields.caption,
    bucket_id: BUCKET_ID,
    owner_user_id: ME,
    platform: 'linkedin',
    format: fields.format,
    stage: 'review',
    stage_entered_at: iso(now - 26 * HOUR),
    approved_by: null,
    approved_at: null,
    target_date: iso(now + 2 * 24 * HOUR),
    origin: 'manual',
    brief_id: null,
    row_version: 1,
    created_by: ME,
    legacy_author_name: null,
    created_at: iso(now - 3 * 24 * HOUR),
    updated_at: iso(now - 26 * HOUR),
    deleted_at: null,
    post_versions: [],
    post_annotations: [],
  };
}

function commentRow(
  id: string,
  entityType: 'post' | 'brief',
  entityId: string,
  author: string,
  body: string,
  at: number,
  extra: Partial<Row> = {},
): Row {
  return {
    id,
    workspace_id: WORKSPACE_ID,
    entity_type: entityType,
    entity_id: entityId,
    parent_comment_id: null,
    author_user_id: author,
    body,
    mentions: null,
    attachment_asset_ids: null,
    resolved_at: null,
    resolved_by: null,
    unaccepted_by: null,
    ledger_batch_id: null,
    ledger_seq: null,
    closed_at: null,
    accepted_at: null,
    created_at: iso(at),
    edited_at: null,
    deleted_at: null,
    ...extra,
  };
}

/** `count` attachments on a post, each with its embedded version mime (the !inner embed). */
function attachments(
  postId: string,
  first: number,
  count: number,
  mime: string,
  now: number,
): Row[] {
  return Array.from({ length: count }, (_, i) => ({
    id: cid(ATTACH, first + i),
    workspace_id: WORKSPACE_ID,
    entity_type: 'post',
    entity_id: postId,
    asset_id: cid(VERSION, first + i),
    asset_version_id: cid(VERSION, first + i),
    position: i,
    attached_by: ME,
    attached_at: iso(now - 3 * 24 * HOUR + i * 1000),
    deleted_at: null,
    asset_versions: { mime_type: mime, kind: mime.startsWith('video/') ? 'video' : 'image' },
  }));
}

function commentEntry(
  id: string,
  postId: string,
  commentId: string,
  actor: string,
  now: number,
  minsAgo: number,
): Row {
  return entry(id, now, minsAgo, {
    actor_user_id: actor,
    event_type: 'comment',
    entity_type: 'post',
    entity_id: postId,
    payload: { comment_id: commentId },
  });
}

/** One post card: the post, its pictures, comments, and the newest comment's entry. */
function seedPostCard(
  network: HarnessNetwork,
  now: number,
  opts: {
    postId: string;
    number: number;
    entryId: string;
    title: string;
    caption: string | null;
    format?: string;
    pictures?: number;
    video?: boolean;
    firstAttach?: number;
    comments: Array<{ author: string; body: string; minsAgo: number }>;
  },
): void {
  const t = network.world.tables;
  (t.posts ??= []).push(
    postRow(opts.postId, opts.number, now, {
      title: opts.title,
      caption: opts.caption,
      format: opts.format ?? (opts.video === true ? 'video' : 'carousel'),
    }),
  );
  const first = opts.firstAttach ?? opts.number * 10;
  if ((opts.pictures ?? 0) > 0) {
    const pictures = attachments(opts.postId, first, opts.pictures ?? 0, 'image/png', now);
    (t.asset_attachments ??= []).push(...pictures);
  }
  if (opts.video === true) {
    (t.asset_attachments ??= []).push(...attachments(opts.postId, first, 1, 'video/mp4', now));
  }
  const ids = opts.comments.map((_, i) => cid(COMMENT, opts.number * 0x10 + i));
  (t.comments ??= []).push(
    ...opts.comments.map((c, i) =>
      commentRow(ids[i] ?? '', 'post', opts.postId, c.author, c.body, now - c.minsAgo * MINUTE),
    ),
  );
  const newest = opts.comments.length - 1;
  const last = opts.comments[newest];
  if (last !== undefined) {
    (t.inbox_entries ??= []).push(
      commentEntry(opts.entryId, opts.postId, ids[newest] ?? '', last.author, now, last.minsAgo),
    );
  }
}

// ---------------------------------------------------------------------------
// Seeds, one card each (the spec opens the card's entry).

/** The rest card: caption + a 5-picture carousel, two comments, the first with a reply. */
export function seedCatchUpRest(network: HarnessNetwork, now: number): void {
  seedPostCard(network, now, {
    postId: CU_REST_POST,
    number: 1,
    entryId: CU_REST_ENTRY,
    title: 'Autumn lookbook',
    caption: CAPTION,
    pictures: 5,
    comments: [
      { author: PEER, body: 'Love the second look. Can the coat slide go first?', minsAgo: 40 },
      { author: COLLEAGUE_A, body: `@[${ME}] the scarf shot is ready in Assets.`, minsAgo: 6 },
    ],
  });
  const reply = commentRow(cid(COMMENT, 0x1f), 'post', CU_REST_POST, ME, 'Yes, swapping now.', 0, {
    parent_comment_id: cid(COMMENT, 0x10),
    created_at: iso(now - 30 * MINUTE),
  });
  (network.world.tables.comments ??= []).push(reply);
}

/** A text-only post: a caption, no pictures. */
export function seedCatchUpTextOnly(network: HarnessNetwork, now: number): void {
  seedPostCard(network, now, {
    postId: CU_TEXT_POST,
    number: 2,
    entryId: CU_TEXT_ENTRY,
    title: 'Opening hours update',
    caption: 'New winter hours from Monday.\nOpen 9 to 6 on weekdays and 10 to 4 on Saturdays.',
    format: 'text',
    comments: [{ author: PEER, body: 'Can we add the Sunday line too?', minsAgo: 12 }],
  });
}

/** A video post. */
export function seedCatchUpVideo(network: HarnessNetwork, now: number): void {
  seedPostCard(network, now, {
    postId: CU_VIDEO_POST,
    number: 3,
    entryId: CU_VIDEO_ENTRY,
    title: 'Mill walk reel',
    caption: 'Thirty seconds at the mill, morning light.',
    video: true,
    comments: [{ author: PEER, body: 'The first two seconds feel slow.', minsAgo: 9 }],
  });
}

/** A comment by a member with a 25-character name. */
export function seedCatchUpLongName(network: HarnessNetwork, now: number): void {
  const t = network.world.tables;
  (t.users ??= []).push({
    id: CU_LONG_NAME_USER,
    display_name: CU_LONG_NAME,
    designation: 'Photographer',
    avatar_url: null,
    email_opt_in: true,
    profile_completed_at: '2026-01-02T00:00:00Z',
    timezone: null,
    deleted_at: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  });
  (t.workspace_members ??= []).push({
    id: cid(USER, 0x101),
    workspace_id: WORKSPACE_ID,
    user_id: CU_LONG_NAME_USER,
    role: 'agency',
    active: true,
    invited_by: null,
    invited_at: '2026-01-01T00:00:00Z',
    accepted_at: '2026-01-01T00:00:00Z',
    removed_at: null,
    rejoined_at: null,
  });
  seedPostCard(network, now, {
    postId: cid(POST, 4),
    number: 4,
    entryId: CU_LONG_NAME_ENTRY,
    title: 'Studio portraits',
    format: 'single_image',
    caption: 'Meet the team behind the range.',
    pictures: 1,
    comments: [{ author: CU_LONG_NAME_USER, body: 'Retouched files are up.', minsAgo: 7 }],
  });
}

/** A post with a 90-character title. */
export function seedCatchUpLongTitle(network: HarnessNetwork, now: number): void {
  seedPostCard(network, now, {
    postId: cid(POST, 5),
    number: 5,
    entryId: CU_LONG_TITLE_ENTRY,
    title: CU_LONG_TITLE,
    caption: CAPTION,
    pictures: 2,
    comments: [{ author: PEER, body: 'Title is long, can we trim it?', minsAgo: 8 }],
  });
}

/** A post with a 1,200-character caption. */
export function seedCatchUpLongCaption(network: HarnessNetwork, now: number): void {
  seedPostCard(network, now, {
    postId: cid(POST, 6),
    number: 6,
    entryId: CU_LONG_CAPTION_ENTRY,
    title: 'Range launch long read',
    caption: CU_LONG_CAPTION,
    format: 'text',
    comments: [{ author: PEER, body: 'Is this too long for the feed?', minsAgo: 5 }],
  });
}

/** A comment of 34 emoji. */
export function seedCatchUpEmoji(network: HarnessNetwork, now: number): void {
  seedPostCard(network, now, {
    postId: cid(POST, 7),
    number: 7,
    entryId: CU_EMOJI_ENTRY,
    title: 'Team photo',
    format: 'single_image',
    caption: 'The whole crew at the mill.',
    pictures: 1,
    comments: [{ author: PEER, body: CU_EMOJI, minsAgo: 4 }],
  });
}

/** A comment holding a 120-character unbroken link. */
export function seedCatchUpLongLink(network: HarnessNetwork, now: number): void {
  seedPostCard(network, now, {
    postId: cid(POST, 8),
    number: 8,
    entryId: CU_LINK_ENTRY,
    title: 'Store locator post',
    caption: 'Find your nearest store.',
    format: 'text',
    comments: [{ author: PEER, body: `Use this one: ${CU_LONG_LINK}`, minsAgo: 4 }],
  });
}

/** A comment with 10 blank lines inside it. */
export function seedCatchUpBlankLines(network: HarnessNetwork, now: number): void {
  seedPostCard(network, now, {
    postId: cid(POST, 9),
    number: 9,
    entryId: CU_BLANK_LINES_ENTRY,
    title: 'Price card',
    caption: 'Prices from Friday.',
    format: 'text',
    comments: [
      {
        author: PEER,
        body: `Top line.${'\n'.repeat(11)}Bottom line after ten blank lines.`,
        minsAgo: 4,
      },
    ],
  });
}

/** 50 new comments on one post, each with its own unread entry (newest is CU_MANY_ENTRY). */
export function seedCatchUpManyComments(network: HarnessNetwork, now: number): void {
  const t = network.world.tables;
  const postId = cid(POST, 0x11);
  (t.posts ??= []).push(
    postRow(postId, 17, now, {
      title: 'Weekend sale',
      caption: 'Twenty percent off knitwear.',
      format: 'text',
    }),
  );
  const authors = [PEER, COLLEAGUE_A, COLLEAGUE_B];
  for (let i = 1; i <= 50; i += 1) {
    const id = cid(COMMENT, 0x100 + i);
    const author = authors[i % authors.length] ?? PEER;
    const minsAgo = 51 - i;
    const body = `Note ${i}: one more tweak on slide ${(i % 5) + 1}.`;
    (t.comments ??= []).push(commentRow(id, 'post', postId, author, body, now - minsAgo * MINUTE));
    (t.inbox_entries ??= []).push(
      commentEntry(cid(ENTRY, 0x100 + i), postId, id, author, now, minsAgo),
    );
  }
}

/**
 * A feedback batch with mixed states on one post: a checkpoints_added entry
 * and three points sharing ledger_batch_id (ledger_seq 1..3, the second
 * resolved), a plain comment after it and a stage change to Review, all
 * unread. Activity groups the three entries into one card ("3 updates").
 */
export function seedCatchUpFeedback(network: HarnessNetwork, now: number): void {
  const t = network.world.tables;
  const postId = CU_FEEDBACK_POST;
  (t.posts ??= []).push(
    postRow(postId, 10, now, {
      title: 'Coat launch carousel',
      caption: CAPTION,
      format: 'carousel',
    }),
  );
  (t.asset_attachments ??= []).push(...attachments(postId, 100, 3, 'image/png', now));
  const points = [
    'Logo too small on slide one.',
    'Swap the second photo for the warmer one.',
    'Price line should read from Friday, not today.',
  ];
  points.forEach((body, i) => {
    const at = now - 20 * MINUTE + i * 1000;
    (t.comments ??= []).push(
      commentRow(cid(COMMENT, 0x201 + i), 'post', postId, PEER, body, at, {
        ledger_batch_id: CU_FEEDBACK_BATCH,
        ledger_seq: i + 1,
        ...(i === 1 ? { resolved_at: iso(now - 10 * MINUTE), resolved_by: ME } : {}),
      }),
    );
  });
  const plainId = cid(COMMENT, 0x20a);
  (t.comments ??= []).push(
    commentRow(plainId, 'post', postId, PEER, 'Otherwise this is close.', now - 15 * MINUTE),
  );
  (t.inbox_entries ??= []).push(
    entry(CU_FEEDBACK_ENTRY, now, 20, {
      actor_user_id: PEER,
      event_type: 'checkpoints_added',
      entity_type: 'post',
      entity_id: postId,
      payload: { batch_id: CU_FEEDBACK_BATCH, count: 3, title: 'Coat launch carousel' },
    }),
    commentEntry(cid(ENTRY, 0x1a), postId, plainId, PEER, now, 15),
    entry(cid(ENTRY, 0x1b), now, 3, {
      actor_user_id: COLLEAGUE_A,
      event_type: 'stage_change',
      entity_type: 'post',
      entity_id: postId,
      payload: { from_stage: 'draft', to_stage: 'review', title: 'Coat launch carousel' },
    }),
  );
}

function planItemRow(
  id: string,
  planId: string | null,
  title: string,
  description: string | null,
  now: number,
): Row {
  return {
    id,
    workspace_id: WORKSPACE_ID,
    plan_id: planId,
    kind: 'concept',
    position: 0,
    title,
    description,
    post_id: null,
    target_date: planId !== null ? '2026-10-23' : null,
    linked_post_id: null,
    created_by: ME,
    created_at: iso(now - 3 * 24 * HOUR),
    updated_at: iso(now - 24 * HOUR),
    last_active_at: iso(now - 24 * HOUR),
    show_to_client: planId !== null,
    archived_at: null,
    starred_at: null,
    came_from_plan_title: null,
    deleted_at: null,
  };
}

function planCommentRow(id: string, itemId: string, author: string, body: string, at: number): Row {
  return {
    id,
    workspace_id: WORKSPACE_ID,
    item_id: itemId,
    author_user_id: author,
    body,
    visibility: 'everyone',
    created_at: iso(at),
    edited_at: null,
    deleted_at: null,
  };
}

/** A plan item (in a plan) with two plan comments, the newest unread. */
export function seedCatchUpPlanItem(network: HarnessNetwork, now: number): void {
  const t = network.world.tables;
  const planId = cid(PLAN, 1);
  const itemId = cid(PLAN, 0x11);
  (t.plans ??= []).push({
    id: planId,
    workspace_id: WORKSPACE_ID,
    title: 'Week of 19 Oct',
    visibility: 'client',
    created_by: ME,
    created_at: iso(now - 5 * 24 * HOUR),
    updated_at: iso(now - 24 * HOUR),
    deleted_at: null,
  });
  (t.plan_items ??= []).push(
    planItemRow(itemId, planId, 'Mill morning reel', 'Twenty seconds at sunrise.\nNo music.', now),
  );
  const older = cid(PLAN, 0x21);
  const newest = cid(PLAN, 0x22);
  (t.plan_item_comments ??= []).push(
    planCommentRow(older, itemId, ME, 'Shooting Thursday.', now - 50 * MINUTE),
    planCommentRow(newest, itemId, PEER, 'Can we keep it under 20 seconds?', now - 6 * MINUTE),
  );
  (t.inbox_entries ??= []).push(
    entry(CU_PLAN_ENTRY, now, 6, {
      actor_user_id: PEER,
      event_type: 'plan_comment',
      entity_type: 'plan_item',
      entity_id: itemId,
      scope_key: planId,
      payload: { plan_id: planId, comment_id: newest, title: 'Mill morning reel' },
    }),
  );
}

/** A bank idea (no plan) with one comment from a colleague. */
export function seedCatchUpBankIdea(network: HarnessNetwork, now: number): void {
  const t = network.world.tables;
  const itemId = cid(PLAN, 0x12);
  (t.plan_items ??= []).push(
    planItemRow(itemId, null, 'Founder story reel', 'Ten questions, one take.', now),
  );
  const commentId = cid(PLAN, 0x23);
  (t.plan_item_comments ??= []).push(
    planCommentRow(commentId, itemId, COLLEAGUE_A, 'I can film this next week.', now - 5 * MINUTE),
  );
  (t.inbox_entries ??= []).push(
    entry(CU_IDEA_ENTRY, now, 5, {
      actor_user_id: COLLEAGUE_A,
      event_type: 'plan_comment',
      entity_type: 'plan_item',
      entity_id: itemId,
      scope_key: 'bank',
      payload: { plan_id: null, comment_id: commentId, title: 'Founder story reel' },
    }),
  );
}

/** A brief created for me, with no due day (no comments: the event row alone). */
export function seedCatchUpBrief(network: HarnessNetwork, now: number): void {
  const t = network.world.tables;
  const briefId = cid(BRIEF, 1);
  (t.briefs ??= []).push({
    id: briefId,
    number: 310,
    workspace_id: WORKSPACE_ID,
    title: 'Winter gifting guide',
    objective: 'Three posts that sell the gift boxes.\nOne carousel, two single photos.',
    format_requested: 'carousel',
    brand_requirements: null,
    target_date: null,
    reference_links: null,
    status: 'open',
    closed_at: null,
    closed_by: null,
    created_by: PEER,
    legacy_author_name: null,
    created_via: 'app',
    row_version: 1,
    updated_at: iso(now - 8 * MINUTE),
    created_at: iso(now - 8 * MINUTE),
    deleted_at: null,
  });
  (t.inbox_entries ??= []).push(
    entry(CU_BRIEF_ENTRY, now, 8, {
      actor_user_id: PEER,
      event_type: 'brief_created',
      entity_type: 'brief',
      entity_id: briefId,
      payload: { title: 'Winter gifting guide' },
    }),
  );
}

/** A DM with Leo (COLLEAGUE_A) holding one message that mentions me (chat-main). */
export function seedCatchUpChatMain(network: HarnessNetwork, now: number): void {
  const t = network.world.tables;
  (t.chat_channels ??= []).push({
    channel_id: CU_DM_CHANNEL,
    workspace_id: WORKSPACE_ID,
    channel_type: 'dm',
    entity_id: null,
    agora_group_id: null,
    dm_user_a: ME,
    dm_user_b: COLLEAGUE_A,
    last_synced_at: null,
    created_at: iso(now - 24 * HOUR),
  });
  const messageId = cid(CHAT, 1);
  (t.chat_messages ??= []).push({
    id: messageId,
    channel_id: CU_DM_CHANNEL,
    workspace_id: WORKSPACE_ID,
    sender_user_id: COLLEAGUE_A,
    body: `@[${ME}] are you free for the shoot on Thursday?`,
    mentions: [ME],
    attachment_asset_ids: null,
    shared_post_ids: null,
    shared_brief_ids: null,
    shared_plan_ids: null,
    shared_plan_item_ids: null,
    reply_to_message_id: null,
    forwarded_from_message_id: null,
    attachment_meta: null,
    agora_event_id: null,
    created_at: iso(now - 4 * MINUTE),
    edited_at: null,
    deleted_at: null,
    thread_root_message_id: null,
  });
  (t.inbox_entries ??= []).push(
    entry(CU_CHAT_MAIN_ENTRY, now, 4, {
      actor_user_id: COLLEAGUE_A,
      event_type: 'mention',
      entity_type: 'chat_channel',
      entity_id: CU_DM_CHANNEL,
      scope: 'people',
      tier: 'urgent',
      payload: { message_id: messageId },
    }),
  );
}

/**
 * The Thread crew group's main chat (chat-main): a mention on its newest
 * top-level message ("I do."), so the card lists the top-level messages with
 * the post-card root's "4 replies" row (tap opens the thread full screen).
 */
export function seedCatchUpGroupMain(network: HarnessNetwork, now: number): void {
  const t = network.world.tables;
  const target = THREAD_IDS.ge ?? '';
  for (const row of t.chat_messages ?? []) {
    if (row.id === target) row.body = `@[${ME}] unrelated: who has the brief?`;
  }
  (t.inbox_entries ??= []).push(
    entry(CU_GROUP_MAIN_ENTRY, now, 1, {
      actor_user_id: COLLEAGUE_B,
      event_type: 'mention',
      entity_type: 'chat_channel',
      entity_id: THREAD_GROUP,
      scope: 'groups',
      tier: 'urgent',
      payload: { message_id: target },
    }),
  );
}
