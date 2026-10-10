// Fixture world for the chat harness: one workspace, the signed-in user, a DM
// peer, two group colleagues, one DM and one group with ~40 messages each
// (text, a photo album, a shared post card, a voice note), posts waiting in
// review for the open-loops strip, and read cursors so the DM shows "Seen".
// Plus two chats for iMessage-style card threads: a DM of 80 rows (one thread
// root sits beyond the first page) and a group laid out as board i4-group-b.

import type { Row, Tables } from './postgrest';

export const WORKSPACE_ID = '0190a000-0000-7000-8000-00000000a001';
export const ME = '0190a000-0000-7000-8000-000000000001';
export const PEER = '0190a000-0000-7000-8000-000000000002';
export const COLLEAGUE_A = '0190a000-0000-7000-8000-000000000003';
export const COLLEAGUE_B = '0190a000-0000-7000-8000-000000000004';
export const GROUP_ID = '0190a000-0000-7000-8000-00000000c001';
export const BUCKET_ID = '0190a000-0000-7000-8000-00000000b001';

export const DM_CHANNEL = `dm__${WORKSPACE_ID}__${ME}__${PEER}`;
export const GROUP_CHANNEL = `group__${WORKSPACE_ID}__${GROUP_ID}`;

export const PEER_NAME = 'Priya Raman';
export const GROUP_NAME = 'Launch crew';

const MESSAGES_PER_CHANNEL = 40;
/** The DM message an Activity mention jumps to (0-based). */
export const MENTION_INDEX = 24;
/** Body of the mentioned DM message, shown as the Activity row preview. */
export const MENTION_PREVIEW = 'Can you take a look at the hook before 5pm?';
const HOUR = 3_600_000;

const LINES = [
  'Morning! Draft for the Monday carousel is up.',
  'Can we tighten the hook on slide one?',
  'Sure, pushing a new version in ten.',
  'Client wants the brand blue a touch darker.',
  'Noted. Swapping the palette now.',
  'Does the caption still fit under the limit?',
  'Yes, 212 characters with the hashtags.',
  'Great, sending it to review after lunch.',
  'Quick one: who owns the Friday reel?',
  'That is mine, storyboard is in the brief.',
  'Love the new cover shot.',
  'Can you check the alt text on image three?',
  'Done, it reads well now.',
  'Reminder: approvals close at 5pm today.',
];

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function messageId(channelIndex: number, n: number): string {
  return `0190b000-0000-7000-8${channelIndex}00-${String(n).padStart(12, '0')}`;
}

export function assetId(channelIndex: number, n: number): string {
  return `0190d000-0000-7000-8${channelIndex}00-${String(n).padStart(12, '0')}`;
}

export const POST_IDS = [
  '0190e000-0000-7000-8000-000000000001',
  '0190e000-0000-7000-8000-000000000002',
  '0190e000-0000-7000-8000-000000000003',
];

function buildMessages(
  channelIndex: number,
  channelId: string,
  senders: readonly string[],
  now: number,
): Row[] {
  const rows: Row[] = [];
  const start = now - 30 * HOUR;
  for (let n = 1; n <= MESSAGES_PER_CHANNEL; n += 1) {
    const sender = senders[n % senders.length] ?? ME;
    const createdAt = iso(start + n * 40 * 60_000);
    const base: Row = {
      id: messageId(channelIndex, n),
      channel_id: channelId,
      workspace_id: WORKSPACE_ID,
      sender_user_id: sender,
      body: LINES[n % LINES.length] ?? 'Hello',
      mentions: null,
      attachment_asset_ids: null,
      shared_post_ids: null,
      shared_brief_ids: null,
      reply_to_message_id: null,
      forwarded_from_message_id: null,
      attachment_meta: null,
      agora_event_id: null,
      created_at: createdAt,
      edited_at: null,
      deleted_at: null,
      thread_root_message_id: null,
    };
    if (n === 12) {
      // A photo album: three images in one message.
      const ids = [1, 2, 3].map((k) => assetId(channelIndex, n * 10 + k));
      base.body = 'Three options for the cover';
      base.attachment_asset_ids = ids;
      base.attachment_meta = Object.fromEntries(
        ids.map((id, k) => [id, { mime: 'image/png', name: `cover-${k + 1}.png`, size: 48_000 }]),
      );
    } else if (n === 20) {
      base.body = 'This one is ready for a look';
      base.shared_post_ids = [POST_IDS[0]];
    } else if (n === 28) {
      const id = assetId(channelIndex, n * 10 + 1);
      base.body = null;
      base.attachment_asset_ids = [id];
      base.attachment_meta = {
        [id]: {
          mime: 'audio/webm',
          name: 'voice-note.webm',
          size: 22_000,
          duration_ms: 14_000,
          peaks: Array.from({ length: 48 }, (_, k) => 20 + ((k * 37) % 80)),
        },
      };
    }
    if (channelIndex === 1 && n === MENTION_INDEX + 1) {
      base.sender_user_id = PEER;
      base.body = `${MENTION_PREVIEW} @[${ME}]`;
      base.mentions = [ME];
    }
    rows.push(base);
  }
  return rows;
}

export const MAYA = '0190a000-0000-7000-8000-000000000005';
export const MAYA_NAME = 'Maya Chen';
export const THREAD_GROUP_ID = '0190a000-0000-7000-8000-00000000c002';
export const THREAD_GROUP_NAME = 'Thread crew';
export const THREAD_DM = `dm__${WORKSPACE_ID}__${ME}__${MAYA}`;
export const THREAD_GROUP = `group__${WORKSPACE_ID}__${THREAD_GROUP_ID}`;

/** A send whose body carries this is refused by the fixture record (the failed-reply alert). */
export const REFUSED_SEND = 'This one is refused';

/** The record trigger's rule: a reply's root is its parent's root, else its parent. */
export function threadRootOf(rows: readonly Row[], replyTo: unknown): string | null {
  if (typeof replyTo !== 'string') return null;
  const parent = rows.find((r) => r.id === replyTo);
  if (parent === undefined) return null;
  return typeof parent.thread_root_message_id === 'string'
    ? parent.thread_root_message_id
    : String(parent.id);
}

/** One scripted thread-chat message: who, what, and what it replies to or shares. */
interface ThreadSpec {
  key: string;
  from: string;
  body: string;
  card?: number;
  replyTo?: string;
  deleted?: boolean;
}

/** Message ids of the thread chats by key, for the spec to find rows. */
export const THREAD_IDS: Record<string, string> = {};

const FILLER = [
  'Draft is in the folder.',
  'Seen, thanks.',
  'Checking the copy now.',
  'All good on my side.',
];

/**
 * The thread DM, oldest first (80 rows; the first page is the newest 50, so
 * root 'r0' and its first reply sit beyond it): an i3 run under the not-loaded
 * root, an own root card with a run broken by a plain row (a chip-headed second
 * run follows), a peer's root card, a deleted root card, and a plain reply.
 */
function threadDmSpecs(): ThreadSpec[] {
  const head: ThreadSpec[] = [
    { key: 'd1', from: ME, body: 'Kickoff notes are in the brief.' },
    { key: 'd2', from: MAYA, body: 'Great, reading now.' },
    { key: 'r0', from: ME, body: 'Teaser cut, first pass', card: 2 },
    { key: 'r0a', from: MAYA, body: 'Love this cut.', replyTo: 'r0' },
  ];
  const filler: ThreadSpec[] = Array.from({ length: 55 }, (_, i) => ({
    key: `f${i}`,
    from: i % 2 === 0 ? MAYA : ME,
    body: FILLER[i % FILLER.length] ?? 'Noted.',
  }));
  const tail: ThreadSpec[] = [
    {
      key: 'i3a',
      from: MAYA,
      body: 'Picking this back up: the teaser needs captions.',
      replyTo: 'r0a',
    },
    { key: 'i3b', from: ME, body: 'On it, captions by noon.', replyTo: 'i3a' },
    { key: 'i3c', from: MAYA, body: 'Thanks!', replyTo: 'i3b' },
    { key: 'p1', from: MAYA, body: 'Separate topic: invoices went out.' },
    { key: 'r1', from: ME, body: 'Carousel for review', card: 0 },
    { key: 'r1a', from: MAYA, body: 'Slide 2 copy is tight.', replyTo: 'r1' },
    { key: 'r1b', from: ME, body: 'Trimmed it.', replyTo: 'r1a' },
    { key: 'r1c', from: MAYA, body: 'Approving after lunch.', replyTo: 'r1' },
    { key: 'p2', from: MAYA, body: 'Also, lunch at 1?' },
    { key: 'r1d', from: MAYA, body: 'One more: alt text on slide 3?', replyTo: 'r1b' },
    { key: 'p3', from: ME, body: 'Yes, 1 works.' },
    { key: 'r2', from: MAYA, body: 'Can you check this one?', card: 1 },
    { key: 'r2a', from: ME, body: 'Looks good to me.', replyTo: 'r2' },
    { key: 'r2b', from: MAYA, body: 'Great, shipping it.', replyTo: 'r2a' },
    { key: 'p4', from: ME, body: 'Next up: the teaser captions.' },
    { key: 'rd', from: MAYA, body: '', card: 0, deleted: true },
    { key: 'rda', from: ME, body: 'Replying to the deleted card.', replyTo: 'rd' },
    { key: 'pq', from: ME, body: 'The quote on a plain reply stays as it is.', replyTo: 'p4' },
    { key: 'p5', from: MAYA, body: 'See you at 1.' },
    { key: 'p6', from: ME, body: 'Sounds good.' },
    { key: 'p7', from: MAYA, body: 'Perfect.' },
  ];
  return [...head, ...filler, ...tail];
}

/** The thread group as board i4-group-b: two senders with photos, an own reply between, then a plain row. */
function threadGroupSpecs(): ThreadSpec[] {
  return [
    { key: 'g1', from: COLLEAGUE_A, body: 'Morning all.' },
    { key: 'g2', from: ME, body: 'Morning!' },
    { key: 'gr', from: COLLEAGUE_A, body: 'New cut for review', card: 0 },
    { key: 'ga', from: COLLEAGUE_B, body: 'Love the colours.', replyTo: 'gr' },
    { key: 'gb', from: COLLEAGUE_B, body: 'Ship it.', replyTo: 'gr' },
    { key: 'gc', from: ME, body: 'Agreed, shipping today.', replyTo: 'ga' },
    { key: 'gd', from: COLLEAGUE_A, body: 'Thanks both!', replyTo: 'gr' },
    { key: 'ge', from: COLLEAGUE_B, body: 'Unrelated: who has the brief?' },
    { key: 'gf', from: ME, body: 'I do.' },
  ];
}

/**
 * Rows for scripted messages, all on today's date (no day pill splits a run),
 * evenly spaced before `now`.
 */
function buildThreadRows(
  channelIndex: number,
  channelId: string,
  specs: readonly ThreadSpec[],
  now: number,
): Row[] {
  const dayStart = Date.UTC(
    new Date(now).getUTCFullYear(),
    new Date(now).getUTCMonth(),
    new Date(now).getUTCDate(),
  );
  // Three minutes apart (inside a run's 10-minute window), all after midnight.
  const span = Math.min((specs.length + 1) * 3 * 60_000, now - dayStart - 60_000);
  const step = Math.max(1, Math.floor(span / (specs.length + 1)));
  const rows: Row[] = [];
  specs.forEach((spec, i) => {
    const id = messageId(channelIndex, i + 1);
    THREAD_IDS[spec.key] = id;
    const replyTo = spec.replyTo !== undefined ? (THREAD_IDS[spec.replyTo] ?? null) : null;
    const deleted = spec.deleted === true;
    rows.push({
      id,
      channel_id: channelId,
      workspace_id: WORKSPACE_ID,
      sender_user_id: spec.from,
      body: deleted ? null : spec.body,
      mentions: null,
      attachment_asset_ids: null,
      shared_post_ids: spec.card !== undefined && !deleted ? [POST_IDS[spec.card]] : null,
      shared_brief_ids: null,
      reply_to_message_id: replyTo,
      forwarded_from_message_id: null,
      attachment_meta: null,
      agora_event_id: null,
      created_at: iso(now - span + (i + 1) * step),
      edited_at: null,
      deleted_at: deleted ? iso(now - span + (i + 1) * step + 1000) : null,
      thread_root_message_id: threadRootOf(rows, replyTo),
    });
  });
  return rows;
}

export interface ChatWorld {
  tables: Tables;
  dmMessages: Row[];
  groupMessages: Row[];
  threadDmMessages: Row[];
  threadGroupMessages: Row[];
}

export function buildWorld(now: number = Date.now()): ChatWorld {
  // DM: alternate me/peer; the last two messages are the peer's, unread by me.
  const dmMessages = buildMessages(1, DM_CHANNEL, [ME, PEER], now);
  const lastDm = dmMessages.length - 1;
  const tailSender = (index: number): void => {
    const row = dmMessages[index];
    if (row) row.sender_user_id = PEER;
  };
  tailSender(lastDm);
  tailSender(lastDm - 1);
  const lastOwnDm = [...dmMessages].reverse().find((m) => m.sender_user_id === ME);
  const groupMessages = buildMessages(2, GROUP_CHANNEL, [ME, COLLEAGUE_A, COLLEAGUE_B], now);
  const lastGroup = groupMessages[groupMessages.length - 1];
  const myDmCursor = dmMessages[lastDm - 2];
  const threadDmMessages = buildThreadRows(3, THREAD_DM, threadDmSpecs(), now);
  const threadGroupMessages = buildThreadRows(4, THREAD_GROUP, threadGroupSpecs(), now);
  const lastThreadDm = threadDmMessages[threadDmMessages.length - 1];
  const lastThreadGroup = threadGroupMessages[threadGroupMessages.length - 1];

  const users: Row[] = [
    { id: ME, display_name: 'Sam Okafor', designation: 'Account lead', avatar_url: null },
    { id: PEER, display_name: PEER_NAME, designation: 'Brand manager', avatar_url: null },
    { id: COLLEAGUE_A, display_name: 'Leo Martins', designation: 'Designer', avatar_url: null },
    { id: COLLEAGUE_B, display_name: 'Ana Silva', designation: 'Copywriter', avatar_url: null },
    { id: MAYA, display_name: MAYA_NAME, designation: 'Social lead', avatar_url: null },
  ].map((u) => ({
    ...u,
    email_opt_in: true,
    profile_completed_at: '2026-01-02T00:00:00Z',
    timezone: null,
    deleted_at: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  }));

  const posts: Row[] = POST_IDS.map((id, k) => ({
    id,
    number: 101 + k,
    workspace_id: WORKSPACE_ID,
    title: ['Monday carousel', 'Friday reel', 'Product teaser'][k],
    caption: 'Fixture caption',
    bucket_id: BUCKET_ID,
    owner_user_id: ME,
    platform: 'instagram',
    format: k === 1 ? 'video' : 'carousel',
    stage: 'review',
    stage_entered_at: iso(now - (k + 2) * 24 * HOUR),
    approved_by: null,
    approved_at: null,
    target_date: iso(now + (k + 1) * 24 * HOUR),
    origin: 'manual',
    brief_id: null,
    row_version: 1,
    created_by: ME,
    legacy_author_name: null,
    created_at: iso(now - 5 * 24 * HOUR),
    updated_at: iso(now - 2 * 24 * HOUR),
    deleted_at: null,
    post_versions: [],
    post_annotations: [],
  }));

  const tables: Tables = {
    users,
    workspaces: [
      {
        id: WORKSPACE_ID,
        name: 'Harness Studio',
        owner_user_id: ME,
        plan_tier: 'studio',
        timezone: 'UTC',
        week_start_day: 1,
        subscription_state: 'active',
        asset_bucket: `assets-${WORKSPACE_ID}`,
        row_version: 1,
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
        deleted_at: null,
      },
    ],
    workspace_members: [ME, PEER, COLLEAGUE_A, COLLEAGUE_B, MAYA].map((userId, k) => ({
      id: `0190f000-0000-7000-8000-00000000000${k + 1}`,
      workspace_id: WORKSPACE_ID,
      user_id: userId,
      role: userId === ME ? 'owner' : userId === PEER || userId === MAYA ? 'client' : 'agency',
      active: true,
      invited_by: null,
      invited_at: '2026-01-01T00:00:00Z',
      accepted_at: '2026-01-01T00:00:00Z',
      removed_at: null,
      rejoined_at: null,
    })),
    groups: [
      {
        id: GROUP_ID,
        name: GROUP_NAME,
        workspace_id: WORKSPACE_ID,
        avatar_url: null,
        created_by: ME,
        created_at: '2026-01-03T00:00:00Z',
        deleted_at: null,
      },
      {
        id: THREAD_GROUP_ID,
        name: THREAD_GROUP_NAME,
        workspace_id: WORKSPACE_ID,
        avatar_url: null,
        created_by: ME,
        created_at: '2026-01-05T00:00:00Z',
        deleted_at: null,
      },
    ],
    group_members: [GROUP_ID, THREAD_GROUP_ID].flatMap((groupId) =>
      [ME, COLLEAGUE_A, COLLEAGUE_B].map((userId) => ({
        group_id: groupId,
        user_id: userId,
        workspace_id: WORKSPACE_ID,
        joined_at: '2026-01-03T00:00:00Z',
      })),
    ),
    chat_channels: [
      {
        channel_id: DM_CHANNEL,
        workspace_id: WORKSPACE_ID,
        channel_type: 'dm',
        entity_id: null,
        agora_group_id: null,
        dm_user_a: ME,
        dm_user_b: PEER,
        last_synced_at: null,
        created_at: '2026-01-04T00:00:00Z',
      },
      {
        channel_id: GROUP_CHANNEL,
        workspace_id: WORKSPACE_ID,
        channel_type: 'group',
        entity_id: GROUP_ID,
        agora_group_id: 'agora-group-1',
        dm_user_a: null,
        dm_user_b: null,
        last_synced_at: null,
        created_at: '2026-01-03T00:00:00Z',
      },
      {
        channel_id: THREAD_DM,
        workspace_id: WORKSPACE_ID,
        channel_type: 'dm',
        entity_id: null,
        agora_group_id: null,
        dm_user_a: ME,
        dm_user_b: MAYA,
        last_synced_at: null,
        created_at: '2026-01-06T00:00:00Z',
      },
      {
        channel_id: THREAD_GROUP,
        workspace_id: WORKSPACE_ID,
        channel_type: 'group',
        entity_id: THREAD_GROUP_ID,
        agora_group_id: 'agora-group-2',
        dm_user_a: null,
        dm_user_b: null,
        last_synced_at: null,
        created_at: '2026-01-05T00:00:00Z',
      },
    ],
    chat_messages: [...dmMessages, ...groupMessages, ...threadDmMessages, ...threadGroupMessages],
    chat_reactions: [
      {
        message_id: dmMessages[10]?.id,
        channel_id: DM_CHANNEL,
        workspace_id: WORKSPACE_ID,
        user_id: PEER,
        emoji: '👍',
        created_at: dmMessages[10]?.created_at,
      },
      {
        message_id: groupMessages[15]?.id,
        channel_id: GROUP_CHANNEL,
        workspace_id: WORKSPACE_ID,
        user_id: COLLEAGUE_A,
        emoji: '🔥',
        created_at: groupMessages[15]?.created_at,
      },
    ],
    chat_read_cursors: [
      {
        channel_id: DM_CHANNEL,
        user_id: PEER,
        workspace_id: WORKSPACE_ID,
        last_read_message_id: lastOwnDm?.id,
        last_read_at: lastOwnDm?.created_at,
        updated_at: lastOwnDm?.created_at,
      },
      {
        channel_id: DM_CHANNEL,
        user_id: ME,
        workspace_id: WORKSPACE_ID,
        last_read_message_id: myDmCursor?.id,
        last_read_at: myDmCursor?.created_at,
        updated_at: myDmCursor?.created_at,
      },
      ...[ME, COLLEAGUE_A].map((userId) => ({
        channel_id: GROUP_CHANNEL,
        user_id: userId,
        workspace_id: WORKSPACE_ID,
        last_read_message_id: lastGroup?.id,
        last_read_at: lastGroup?.created_at,
        updated_at: lastGroup?.created_at,
      })),
      // The thread chats are read to the end: no unread divider splits a run.
      ...[ME, MAYA].map((userId) => ({
        channel_id: THREAD_DM,
        user_id: userId,
        workspace_id: WORKSPACE_ID,
        last_read_message_id: lastThreadDm?.id,
        last_read_at: lastThreadDm?.created_at,
        updated_at: lastThreadDm?.created_at,
      })),
      ...[ME, COLLEAGUE_A, COLLEAGUE_B].map((userId) => ({
        channel_id: THREAD_GROUP,
        user_id: userId,
        workspace_id: WORKSPACE_ID,
        last_read_message_id: lastThreadGroup?.id,
        last_read_at: lastThreadGroup?.created_at,
        updated_at: lastThreadGroup?.created_at,
      })),
    ],
    chat_channel_clears: [],
    chat_message_marks: [],
    // The viewer's scheduled messages (RLS: own rows only); specs seed rows.
    chat_scheduled_messages: [],
    // The viewer's message reminders (RLS: own rows only); specs seed rows.
    chat_message_reminders: [],
    chat_message_stars: [],
    posts,
    briefs: [],
    inbox_entries: [
      {
        id: '0190f100-0000-7000-8000-000000000001',
        user_id: ME,
        actor_user_id: PEER,
        workspace_id: WORKSPACE_ID,
        event_type: 'mention',
        entity_type: 'chat_channel',
        entity_id: DM_CHANNEL,
        scope: 'people',
        scope_key: null,
        tier: 'urgent',
        payload: { message_id: dmMessages[MENTION_INDEX]?.id },
        read_at: null,
        snoozed_until: null,
        email_sent_at: null,
        deleted_at: null,
        created_at: dmMessages[MENTION_INDEX]?.created_at,
      },
    ],
    comments: [],
    assets: [],
    asset_attachments: [],
    // Plans in chat (RLS is not emulated: specs seed only what the viewer reads).
    plans: [],
    plan_items: [],
    plan_item_reviews: [],
    plan_item_comments: [],
    folders: [],
    workspace_buckets: [
      {
        id: BUCKET_ID,
        workspace_id: WORKSPACE_ID,
        name: 'Always on',
        created_at: '2026-01-01T00:00:00Z',
      },
    ],
  };
  return { tables, dmMessages, groupMessages, threadDmMessages, threadGroupMessages };
}

// ---------------------------------------------------------------------------
// Plans in chat
// ---------------------------------------------------------------------------

export const PLAN_ID = '0190d000-0000-7000-8000-00000000d001';
export const TEAM_PLAN_ID = '0190d000-0000-7000-8000-00000000d002';
/** A plan id with no row: the viewer cannot read it ("Plan not available"). */
export const HIDDEN_PLAN_ID = '0190d000-0000-7000-8000-00000000d003';
export const PLAN_CONCEPT_ITEM = '0190d100-0000-7000-8000-00000000d101';
export const PLAN_POST_ITEM = '0190d100-0000-7000-8000-00000000d102';
export const PLAN_TITLE = 'Week of 12 Oct';
export const PLAN_CONCEPT_TITLE = 'Season opening reel';
export const PLAN_MESSAGE_ID = '0190d200-0000-7000-8000-00000000d201';

function planRow(id: string, title: string, audience: 'team' | 'client', by: string): Row {
  return {
    id,
    workspace_id: WORKSPACE_ID,
    title,
    starts_on: '2026-10-12',
    ends_on: '2026-10-18',
    audience,
    shared_with_client_at: audience === 'client' ? '2026-10-09T09:00:00Z' : null,
    shared_with_client_by: audience === 'client' ? by : null,
    created_by: by,
    created_at: '2026-10-09T09:00:00Z',
    updated_at: '2026-10-09T09:00:00Z',
    deleted_at: null,
  };
}

/** One plan-card message in a chat (shared by `sender`), newest in the thread. */
export function planMessage(
  id: string,
  channelId: string,
  sender: string,
  planIds: string[],
  now: number = Date.now(),
): Row {
  return {
    id,
    channel_id: channelId,
    workspace_id: WORKSPACE_ID,
    sender_user_id: sender,
    body: null,
    mentions: null,
    attachment_asset_ids: null,
    shared_post_ids: null,
    shared_brief_ids: null,
    shared_plan_ids: planIds,
    reply_to_message_id: null,
    forwarded_from_message_id: null,
    attachment_meta: null,
    agora_event_id: null,
    created_at: iso(now - 60_000),
    edited_at: null,
    deleted_at: null,
    thread_root_message_id: null,
  };
}

/**
 * Seed a client plan (one concept with one library file, one post item, an
 * Everyone comment on the concept) shared by `sender` into `channelId`.
 */
export function seedClientPlan(
  world: ChatWorld,
  opts: { channelId: string; sender: string; fileVersionId: string; now?: number },
): void {
  const t = world.tables;
  (t.plans ??= []).push(planRow(PLAN_ID, PLAN_TITLE, 'client', opts.sender));
  (t.plan_items ??= []).push(
    {
      id: PLAN_CONCEPT_ITEM,
      workspace_id: WORKSPACE_ID,
      plan_id: PLAN_ID,
      kind: 'concept',
      position: 0,
      title: PLAN_CONCEPT_TITLE,
      description: 'Short reel of the season starting. Morning light, 20 to 30 seconds.',
      post_id: null,
      created_by: opts.sender,
      created_at: '2026-10-09T09:00:00Z',
      updated_at: '2026-10-09T09:00:00Z',
      deleted_at: null,
    },
    {
      id: PLAN_POST_ITEM,
      workspace_id: WORKSPACE_ID,
      plan_id: PLAN_ID,
      kind: 'post',
      position: 1,
      title: null,
      description: null,
      post_id: POST_IDS[0],
      created_by: opts.sender,
      created_at: '2026-10-09T09:00:01Z',
      updated_at: '2026-10-09T09:00:01Z',
      deleted_at: null,
    },
  );
  (t.plan_item_comments ??= []).push({
    id: '0190d300-0000-7000-8000-00000000d301',
    workspace_id: WORKSPACE_ID,
    item_id: PLAN_CONCEPT_ITEM,
    author_user_id: opts.sender,
    body: 'Can we keep it under 30 seconds?',
    visibility: 'everyone',
    created_at: '2026-10-09T09:30:00Z',
    edited_at: null,
    deleted_at: null,
  });
  (t.asset_attachments ??= []).push({
    id: '0190d400-0000-7000-8000-00000000d401',
    asset_id: opts.fileVersionId,
    asset_version_id: opts.fileVersionId,
    entity_type: 'plan_item',
    entity_id: PLAN_CONCEPT_ITEM,
    workspace_id: WORKSPACE_ID,
    position: 0,
    attached_by: opts.sender,
    attached_at: '2026-10-09T09:00:00Z',
    deleted_at: null,
  });
  (t.chat_messages ??= []).push(
    planMessage(PLAN_MESSAGE_ID, opts.channelId, opts.sender, [PLAN_ID], opts.now),
  );
}

/** Seed a team only plan card and a card whose plan the viewer cannot read into a chat. */
export function seedTeamAndHiddenPlans(
  world: ChatWorld,
  opts: { channelId: string; sender: string; now?: number },
): void {
  const t = world.tables;
  const now = opts.now ?? Date.now();
  (t.plans ??= []).push(planRow(TEAM_PLAN_ID, 'Launch week drafts', 'team', opts.sender));
  (t.plan_items ??= []).push({
    id: '0190d100-0000-7000-8000-00000000d103',
    workspace_id: WORKSPACE_ID,
    plan_id: TEAM_PLAN_ID,
    kind: 'concept',
    position: 0,
    title: 'Teaser countdown',
    description: null,
    post_id: null,
    created_by: opts.sender,
    created_at: '2026-10-09T09:00:00Z',
    updated_at: '2026-10-09T09:00:00Z',
    deleted_at: null,
  });
  (t.chat_messages ??= []).push(
    planMessage(
      '0190d200-0000-7000-8000-00000000d202',
      opts.channelId,
      opts.sender,
      [TEAM_PLAN_ID],
      now - 120_000,
    ),
    planMessage(
      '0190d200-0000-7000-8000-00000000d203',
      opts.channelId,
      opts.sender,
      [HIDDEN_PLAN_ID],
      now,
    ),
  );
}
