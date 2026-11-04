// The palette's workspace search over the fixture world: workspace_search_grouped
// (newest first, at most p_per_kind rows per kind, mention tokens cut at the
// end dropped) and workspace_search_counts (each kind's full total), like the
// SQL in supabase/migrations/20261016213000_workspace_search_counts.sql. Only
// people, posts and groups are searched: the fixture world has no others.

import type { Page, Route } from '@playwright/test';
import {
  COLLEAGUE_A,
  COLLEAGUE_B,
  DM_CHANNEL,
  GROUP_CHANNEL,
  ME,
  PEER,
  WORKSPACE_ID,
} from './chat-data';
import type { Row, Tables } from './postgrest';

type RpcHandler = (args: Record<string, unknown>, tables: Tables) => unknown;

interface Match {
  kind: string;
  id: string;
  parent_id: string | null;
  channel_id: string | null;
  entity_type: string;
  number: number | null;
  title: string;
  body: string;
  actor: string | null;
  created_at: string;
}

function str(row: Row, key: string): string {
  const v = row[key];
  return typeof v === 'string' ? v : '';
}

function activeMember(tables: Tables, workspaceId: string, userId: string | null): boolean {
  return (tables.workspace_members ?? []).some(
    (m) =>
      m.workspace_id === workspaceId &&
      m.user_id === userId &&
      m.active === true &&
      m.removed_at == null,
  );
}

function matches(args: Record<string, unknown>, tables: Tables): Match[] {
  const ws = String(args.p_workspace_id ?? '');
  const q = String(args.p_query ?? '')
    .trim()
    .toLowerCase();
  if (q.length < 2 || q.length > 100) return [];
  const has = (text: string): boolean => text.toLowerCase().includes(q);
  const out: Match[] = [];
  for (const m of tables.workspace_members ?? []) {
    if (m.workspace_id !== ws || m.active !== true || m.removed_at != null) continue;
    const u = (tables.users ?? []).find((x) => x.id === m.user_id && x.deleted_at == null);
    if (u === undefined || !(has(str(u, 'display_name')) || has(str(u, 'username')))) continue;
    out.push({
      kind: 'person',
      id: str(u, 'id'),
      parent_id: null,
      channel_id: null,
      entity_type: 'user',
      number: null,
      title: str(u, 'display_name'),
      body: str(u, 'username'),
      actor: str(u, 'id'),
      created_at: str(m, 'accepted_at'),
    });
  }
  for (const p of tables.posts ?? []) {
    if (p.workspace_id !== ws || p.deleted_at != null) continue;
    if (!(has(str(p, 'title')) || has(str(p, 'caption')))) continue;
    out.push({
      kind: 'post',
      id: str(p, 'id'),
      parent_id: null,
      channel_id: null,
      entity_type: 'post',
      number: typeof p.number === 'number' ? p.number : null,
      title: str(p, 'title'),
      body: str(p, 'caption'),
      actor: str(p, 'created_by'),
      created_at: str(p, 'created_at'),
    });
  }
  for (const g of tables.groups ?? []) {
    if (g.workspace_id !== ws || g.deleted_at != null || !has(str(g, 'name'))) continue;
    out.push({
      kind: 'chat_group',
      id: str(g, 'id'),
      parent_id: null,
      channel_id: `group__${ws}__${str(g, 'id')}`,
      entity_type: 'group',
      number: null,
      title: str(g, 'name'),
      body: '',
      actor: str(g, 'created_by'),
      created_at: str(g, 'created_at'),
    });
  }
  return out;
}

export const SEARCH_RPC: Record<string, RpcHandler> = {
  workspace_search_grouped: (args, tables) => {
    const ws = String(args.p_workspace_id ?? '');
    const per = Math.min(Math.max(Number(args.p_per_kind ?? 5), 1), 20);
    const byKind = new Map<string, Match[]>();
    for (const m of matches(args, tables)) {
      byKind.set(m.kind, [...(byKind.get(m.kind) ?? []), m]);
    }
    return [...byKind.values()].flatMap((rows) =>
      rows
        .sort((a, b) => b.created_at.localeCompare(a.created_at))
        .slice(0, per)
        .map((m) => ({
          kind: m.kind,
          id: m.id,
          parent_id: m.parent_id,
          channel_id: m.channel_id,
          entity_type: m.entity_type,
          number: m.number,
          title: m.title,
          snippet: m.body.slice(0, 160).replace(/@\[[^\]]*$/, ''),
          actor_user_id: m.actor,
          actor_is_member: activeMember(tables, ws, m.actor),
          created_at: m.created_at,
        })),
    );
  },
  workspace_search_counts: (args, tables) => {
    const totals = new Map<string, number>();
    for (const m of matches(args, tables)) totals.set(m.kind, (totals.get(m.kind) ?? 0) + 1);
    return [...totals.entries()].map(([kind, total]) => ({ kind, total }));
  },
};

// ---------------------------------------------------------------------------
// Media chips (Photos, Videos, Files, Links, Voice notes): chat_message_search
// rows for each p_kind, as the live proc returns them (whole chat_messages
// rows), with attachment_asset_ids and attachment_meta keyed by version id
// ({mime, name, size, duration_ms?, page_count?, thumb_w?, thumb_h?}).
// Seeded into the harness world so the thread renders the same messages when
// a tile's Show in chat opens it.

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Message ids of the media fixtures (uuid v7 shaped). */
export const MEDIA_MSG = {
  photoAlbum: '0190f500-0000-7000-8000-0000000000a1',
  photoOne: '0190f500-0000-7000-8000-0000000000a2',
  videoTimed: '0190f500-0000-7000-8000-0000000000b1',
  videoBare: '0190f500-0000-7000-8000-0000000000b2',
  pdf: '0190f500-0000-7000-8000-0000000000c1',
  docx: '0190f500-0000-7000-8000-0000000000c2',
  links: '0190f500-0000-7000-8000-0000000000d1',
  voice: '0190f500-0000-7000-8000-0000000000e1',
} as const;

/** Asset version ids carried by the media fixtures. */
export const MEDIA_VERSION = {
  album1: '0190f600-0000-7000-8000-0000000000a1',
  album2: '0190f600-0000-7000-8000-0000000000a2',
  album3: '0190f600-0000-7000-8000-0000000000a3',
  one: '0190f600-0000-7000-8000-0000000000a4',
  videoTimed: '0190f600-0000-7000-8000-0000000000b1',
  videoBare: '0190f600-0000-7000-8000-0000000000b2',
  pdf: '0190f600-0000-7000-8000-0000000000c1',
  docx: '0190f600-0000-7000-8000-0000000000c2',
  voice: '0190f600-0000-7000-8000-0000000000e1',
} as const;

export const MEDIA_ALBUM_BODY = 'Cover picks for Friday';
export const MEDIA_VIDEO_BODY = 'Reel cut v2';
export const MEDIA_PDF_BODY = 'Brief deck for review';
export const MEDIA_LINK_A = 'https://northwind.example/moodboard';
export const MEDIA_LINK_B = 'https://docs.example.com/brief/launch';
export const MEDIA_LINKS_BODY = `Two refs: ${MEDIA_LINK_A} and ${MEDIA_LINK_B}`;
/** The video with a recorded length: 12 s, shown as 0:12 on its tile. */
export const MEDIA_VIDEO_DURATION_MS = 12_000;
export const MEDIA_VOICE_DURATION_MS = 9_000;

const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

/** Chips in order on the chat home, by data-search-chip value. */
export const SEARCH_CHIP_ORDER = ['starred', 'photo', 'video', 'link', 'file', 'voice'] as const;
export type MediaKind = 'photo' | 'video' | 'link' | 'file' | 'voice';

function mediaRow(over: {
  id: string;
  channel: string;
  sender: string;
  at: number;
  body: string | null;
  meta?: Record<string, Record<string, unknown>>;
}): Row {
  const ids = over.meta !== undefined ? Object.keys(over.meta) : null;
  return {
    id: over.id,
    channel_id: over.channel,
    workspace_id: WORKSPACE_ID,
    sender_user_id: over.sender,
    body: over.body,
    mentions: null,
    attachment_asset_ids: ids,
    shared_post_ids: null,
    shared_brief_ids: null,
    reply_to_message_id: null,
    forwarded_from_message_id: null,
    attachment_meta: over.meta ?? null,
    agora_event_id: null,
    created_at: new Date(over.at).toISOString(),
    edited_at: null,
    deleted_at: null,
    thread_root_message_id: null,
  };
}

/**
 * The media fixture rows at `now`. Photos: a 3-photo album (the newest photo
 * message, in the DM) and a single photo 40 days back (another month header,
 * in the group). Videos: one with duration_ms 12000 and one without. Files: a
 * pdf with page_count and a docx. Links: one message with 2 urls. Voice: an
 * audio/webm note with duration_ms.
 */
export function mediaSearchRows(now: number = Date.now()): Row[] {
  const v = MEDIA_VERSION;
  return [
    mediaRow({
      id: MEDIA_MSG.photoAlbum,
      channel: DM_CHANNEL,
      sender: PEER,
      at: now - 20 * MINUTE,
      body: MEDIA_ALBUM_BODY,
      meta: {
        [v.album1]: { mime: 'image/jpeg', name: 'cover-a.jpg', size: 182_000 },
        [v.album2]: { mime: 'image/jpeg', name: 'cover-b.jpg', size: 176_000 },
        [v.album3]: { mime: 'image/png', name: 'cover-c.png', size: 240_000 },
      },
    }),
    mediaRow({
      id: MEDIA_MSG.photoOne,
      channel: GROUP_CHANNEL,
      sender: COLLEAGUE_A,
      at: now - 40 * DAY,
      body: null,
      meta: { [v.one]: { mime: 'image/png', name: 'moodboard.png', size: 96_000 } },
    }),
    mediaRow({
      id: MEDIA_MSG.videoTimed,
      channel: DM_CHANNEL,
      sender: ME,
      at: now - 2 * HOUR,
      body: MEDIA_VIDEO_BODY,
      meta: {
        [v.videoTimed]: {
          mime: 'video/mp4',
          name: 'reel-cut-v2.mp4',
          size: 8_400_000,
          duration_ms: MEDIA_VIDEO_DURATION_MS,
          thumb_w: 580,
          thumb_h: 326,
        },
      },
    }),
    mediaRow({
      id: MEDIA_MSG.videoBare,
      channel: GROUP_CHANNEL,
      sender: COLLEAGUE_A,
      at: now - 3 * DAY,
      body: null,
      meta: {
        [v.videoBare]: {
          mime: 'video/quicktime',
          name: 'behind-the-scenes.mov',
          size: 21_000_000,
          thumb_w: 326,
          thumb_h: 580,
        },
      },
    }),
    mediaRow({
      id: MEDIA_MSG.pdf,
      channel: DM_CHANNEL,
      sender: PEER,
      at: now - 5 * HOUR,
      body: MEDIA_PDF_BODY,
      meta: {
        [v.pdf]: {
          mime: 'application/pdf',
          name: 'Launch brief.pdf',
          size: 1_240_000,
          page_count: 12,
          thumb_w: 580,
          thumb_h: 751,
        },
      },
    }),
    mediaRow({
      id: MEDIA_MSG.docx,
      channel: GROUP_CHANNEL,
      sender: COLLEAGUE_B,
      at: now - 2 * DAY,
      body: null,
      meta: { [v.docx]: { mime: DOCX, name: 'Caption drafts.docx', size: 38_000 } },
    }),
    mediaRow({
      id: MEDIA_MSG.links,
      channel: DM_CHANNEL,
      sender: PEER,
      at: now - 1 * HOUR,
      body: MEDIA_LINKS_BODY,
    }),
    mediaRow({
      id: MEDIA_MSG.voice,
      channel: DM_CHANNEL,
      sender: PEER,
      at: now - 30 * MINUTE,
      body: null,
      meta: {
        [v.voice]: {
          mime: 'audio/webm',
          name: 'voice-note.webm',
          size: 18_000,
          duration_ms: MEDIA_VOICE_DURATION_MS,
          peaks: Array.from({ length: 48 }, (_, k) => 15 + ((k * 29) % 85)),
        },
      },
    }),
  ];
}

/** Put the media fixture rows into the world's chat_messages (once). */
export function seedMediaSearch(tables: Tables, now: number = Date.now()): void {
  const messages = (tables.chat_messages ??= []);
  for (const row of mediaSearchRows(now)) {
    if (!messages.some((m) => m.id === row.id)) messages.push(row);
  }
}

function metaMimes(m: Row): string[] {
  const meta = m.attachment_meta;
  if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) return [];
  return Object.values(meta as Record<string, unknown>).map((v) =>
    typeof v === 'object' && v !== null ? String((v as Record<string, unknown>).mime ?? '') : '',
  );
}

/**
 * chat_message_search with p_kind, by the live rule
 * (supabase/migrations/20261104120000_chat_search_video_kind.sql): link by an
 * http(s) url in the body; photo image/*, video video/*, voice audio/*, file
 * anything else, by attachment_meta mime. A 1-character or over-100 query is
 * empty; 2+ characters narrow by word prefix. Newest first, keyset paging,
 * the limit clamped 1..50.
 */
export function mediaKindSearch(args: Record<string, unknown>, tables: Tables): Row[] {
  const kind = String(args.p_kind);
  const query = String(args.p_query ?? '').trim();
  if (query.length === 1 || query.length > 100) return [];
  const words = query.toLowerCase().match(/[\p{L}\p{M}\p{N}]+/gu) ?? [];
  const limit = Math.min(50, Math.max(1, Number(args.p_limit ?? 30)));
  const beforeAt = typeof args.p_before_created_at === 'string' ? args.p_before_created_at : null;
  const beforeId = typeof args.p_before_id === 'string' ? args.p_before_id : null;
  const media = (t: string): boolean =>
    t.startsWith('image/') || t.startsWith('video/') || t.startsWith('audio/');
  const ofKind = (m: Row): boolean => {
    if (kind === 'link') return /https?:\/\//i.test(String(m.body ?? ''));
    const list = metaMimes(m);
    if (kind === 'photo') return list.some((t) => t.startsWith('image/'));
    if (kind === 'video') return list.some((t) => t.startsWith('video/'));
    if (kind === 'voice') return list.some((t) => t.startsWith('audio/'));
    if (kind === 'file') return list.some((t) => !media(t));
    return false;
  };
  return (tables.chat_messages ?? [])
    .filter((m) => m.deleted_at == null && ofKind(m))
    .filter((m) => args.p_channel_id == null || m.channel_id === args.p_channel_id)
    .filter((m) => {
      if (words.length === 0) return true;
      const tokens =
        String(m.body ?? '')
          .toLowerCase()
          .match(/[\p{L}\p{M}\p{N}]+/gu) ?? [];
      return words.every((w) => tokens.some((t) => t.startsWith(w)));
    })
    .sort(
      (a, b) =>
        String(b.created_at).localeCompare(String(a.created_at)) ||
        String(b.id).localeCompare(String(a.id)),
    )
    .filter((m) => {
      if (beforeAt === null || beforeId === null) return true;
      const at = String(m.created_at);
      return at < beforeAt || (at === beforeAt && String(m.id) < beforeId);
    })
    .slice(0, limit);
}

/**
 * Seed the media rows and answer every chat_message_search call that carries
 * p_kind with mediaKindSearch over the same tables (registered after
 * installHarnessNetwork, so it is asked first); text-only searches fall back
 * to the harness. Returns the p_kind calls seen, in order.
 */
export async function installMediaSearch(
  page: Page,
  tables: Tables,
  now: number = Date.now(),
): Promise<Array<Record<string, unknown>>> {
  seedMediaSearch(tables, now);
  const calls: Array<Record<string, unknown>> = [];
  await page.route('**/rest/v1/rpc/chat_message_search', async (route: Route) => {
    const request = route.request();
    const args =
      request.method() === 'POST'
        ? ((request.postDataJSON() ?? {}) as Record<string, unknown>)
        : {};
    if (typeof args.p_kind !== 'string') {
      await route.fallback();
      return;
    }
    calls.push(args);
    await route.fulfill({
      status: 200,
      headers: {
        'access-control-allow-origin': '*',
        'access-control-allow-headers': '*',
        'access-control-allow-methods': 'GET, POST, PATCH, DELETE, HEAD, OPTIONS',
        'access-control-expose-headers': 'content-range',
        'content-type': 'application/json',
      },
      body: JSON.stringify(mediaKindSearch(args, tables)),
    });
  });
  return calls;
}
