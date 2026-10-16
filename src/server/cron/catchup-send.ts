// Catch-up email cron Worker (G2): reads, tenant scoping and digest assembly.
//
// Every 30 minutes the Worker reads recent unsent inbox activity and unread DM
// messages, asks the schedule whether each (recipient, workspace) pair is at a
// 10:30 or 15:30 local slot, and sends one email per user per workspace per
// slot covering only activity inside that slot's window.
//
// Tenant rule: the service-role client bypasses RLS, so this file enforces
// isolation itself. Every read is scoped to the recipient's own inbox_entries
// and to workspaces where they are an active member; post and brief titles,
// review lists and DMs come only from that workspace. Draft posts are never
// selected (every posts query carries .neq('stage', 'draft')).
//
// Query shape: no N+1. Every lookup is one batched IN read across all
// candidates (chunked), or a time-bounded paged read; per-recipient work is in
// memory except getEmail and deliver. The client surface is CatchupDbClient's
// documented subset (no .or, .rpc or .single).
//
// Transactions: none. PostgREST has no multi-statement transactions, and none
// is needed: the deliverer sends first and stamps email_sent_at only after
// Resend accepts. A crash between send and stamp leaves the entries unstamped;
// a re-run of the same slot reuses the same Idempotency-Key, so Resend treats
// it as a no-op inside its 24h idempotency window instead of sending twice.

import { v7 as uuidv7 } from 'uuid';
import { createClient } from '@supabase/supabase-js';
import {
  AGENCY_ROLES,
  buildCatchupUrls,
  buildOneClickUrl,
  buildUnsubscribePageUrl,
  renderCatchupEmail,
  signUnsubscribeToken,
  type Role,
} from '@srtdio/inbox';
import { TRACE_ID_HEADER, withTraceLogger } from '@/server/trace';
import { decideSlot } from './catchup-schedule';
import {
  buildIdempotencyKey,
  buildUnsubscribeHeaders,
  createDeliverer,
  createSupabaseDeliveryStore,
  resolveCatchupGate,
} from './catchup-deliver';
import type {
  CatchupDbClient,
  CatchupEnv,
  CatchupTickResult,
  CommentItem,
  DmItem,
  PostItem,
  RecipientDigest,
  RunCatchupDeps,
  SlotDecision,
  StageItem,
} from './catchup-contracts';

// inbox_entries event types that can trigger a catch-up. Each maps to a
// rendered section or summary count: comment and mention to Comments,
// stage_change to Approved / the parked count, brief_created to the new briefs
// count. Must stay a subset of INBOX_EVENT_TYPES (event-types.test.ts).
export const CATCHUP_EVENT_TYPES = ['comment', 'mention', 'stage_change', 'brief_created'] as const;

/** Bounds the longest window (Fri 15:30 to Mon 10:30 is 67h, plus DST slack). */
const LOOKBACK_MS = 80 * 60 * 60 * 1000;
const PAGE_SIZE = 1000;
const ID_CHUNK = 200;
/** Review posts listed per digest; the renderer shows at most SECTION_ROW_CAP. */
const REVIEW_ITEM_LIMIT = 25;
const MENTION_TOKEN = /@\[([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\]/gi;
const UNKNOWN_NAME = 'Someone';

// --- row shapes (the service-role client has no Database generic) ----------

interface InboxRow {
  id: string;
  user_id: string;
  workspace_id: string;
  event_type: string;
  entity_type: string | null;
  entity_id: string | null;
  actor_user_id: string | null;
  payload: unknown;
  snoozed_until: string | null;
  created_at: string;
}
interface ChannelRow {
  channel_id: string;
  workspace_id: string;
  dm_user_a: string | null;
  dm_user_b: string | null;
}
interface MessageRow {
  id: string;
  channel_id: string;
  sender_user_id: string | null;
  body: string | null;
  created_at: string;
}
interface CursorRow {
  channel_id: string;
  user_id: string;
  last_read_at: string | null;
}
interface UserRow {
  id: string;
  display_name: string;
  timezone: string | null;
  email_opt_in: boolean;
  deleted_at: string | null;
}
interface WorkspaceRow {
  id: string;
  name: string;
  timezone: string | null;
}
interface MemberRow {
  user_id: string;
  workspace_id: string;
  role: string;
}
interface PostRow {
  id: string;
  workspace_id: string;
  title: string;
  stage: string;
  stage_entered_at: string;
}
interface BriefRow {
  id: string;
  workspace_id: string;
  title: string;
}

interface Candidate {
  userId: string;
  workspaceId: string;
  entries: InboxRow[];
  channels: ChannelRow[];
}

interface DueCandidate extends Candidate {
  decision: Extract<SlotDecision, { send: true }>;
  workspaceName: string;
  role: Role;
}

// --- read helpers -----------------------------------------------------------

type QueryResult = PromiseLike<{ data: unknown; error: { message: string } | null }>;

function chunks(ids: readonly string[]): string[][] {
  const out: string[][] = [];
  for (let i = 0; i < ids.length; i += ID_CHUNK) out.push(ids.slice(i, i + ID_CHUNK));
  return out;
}

/** Reads every page of one query (.range paging; callers order by a unique key). */
async function readPaged<T>(what: string, build: (from: number, to: number) => QueryResult) {
  const out: T[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await build(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(`catch-up read ${what} failed: ${error.message}`);
    const rows = (data ?? []) as T[];
    out.push(...rows);
    if (rows.length < PAGE_SIZE) return out;
  }
}

/** Paged read per chunk of ids; an empty id list reads nothing. */
async function readByIds<T>(
  what: string,
  ids: readonly string[],
  build: (chunk: string[], from: number, to: number) => QueryResult,
): Promise<T[]> {
  const out: T[] = [];
  for (const chunk of chunks(ids)) {
    out.push(...(await readPaged<T>(what, (from, to) => build(chunk, from, to))));
  }
  return out;
}

/** Paged read per (chunk of a, chunk of b); empty when either list is empty. */
async function readByIdPairs<T>(
  what: string,
  aIds: readonly string[],
  bIds: readonly string[],
  build: (a: string[], b: string[], from: number, to: number) => QueryResult,
): Promise<T[]> {
  const out: T[] = [];
  for (const a of chunks(aIds)) {
    for (const b of chunks(bIds)) {
      out.push(...(await readPaged<T>(what, (from, to) => build(a, b, from, to))));
    }
  }
  return out;
}

// --- small pure helpers -----------------------------------------------------

function pairKey(a: string, b: string): string {
  return `${a}|${b}`;
}

function ms(iso: string): number {
  return Date.parse(iso);
}

function payloadString(payload: unknown, key: string): string | undefined {
  if (payload === null || typeof payload !== 'object') return undefined;
  const value = (payload as Record<string, unknown>)[key];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function commentActorId(entry: InboxRow): string | null {
  return payloadString(entry.payload, 'author_user_id') ?? entry.actor_user_id;
}

function mentionIds(body: string | null): string[] {
  if (body === null) return [];
  return [...body.matchAll(MENTION_TOKEN)].map((m) => (m[1] ?? '').toLowerCase());
}

function newestFirst<T>(items: T[], at: (item: T) => string): T[] {
  return items.sort((x, y) => ms(at(y)) - ms(at(x)));
}

function isAgency(role: Role): boolean {
  return AGENCY_ROLES.includes(role);
}

// --- reads ------------------------------------------------------------------

async function readCandidateEntries(
  client: CatchupDbClient,
  trialIds: string[] | null,
  sinceIso: string,
  nowIso: string,
  now: Date,
): Promise<InboxRow[]> {
  const cols =
    'id,user_id,workspace_id,event_type,entity_type,entity_id,actor_user_id,payload,snoozed_until,created_at';
  const base = () =>
    client
      .from('inbox_entries')
      .select(cols)
      .gte('created_at', sinceIso)
      .lt('created_at', nowIso)
      .is('read_at', null)
      .is('deleted_at', null)
      .is('email_sent_at', null)
      .in('event_type', [...CATCHUP_EVENT_TYPES]);
  const rows =
    trialIds === null
      ? await readPaged<InboxRow>('inbox_entries', (from, to) => base().order('id').range(from, to))
      : await readByIds<InboxRow>('inbox_entries', trialIds, (chunk, from, to) =>
          base().in('user_id', chunk).order('id').range(from, to),
        );
  return rows.filter((r) => r.snoozed_until === null || ms(r.snoozed_until) <= now.getTime());
}

interface DmData {
  channels: ChannelRow[];
  messages: MessageRow[];
}

/**
 * DM channels with at least one message in [since, now), and those messages.
 * Live: discovered from the time-bounded message read. Trial: only channels
 * where a trial user is dm_user_a or dm_user_b (two queries, no .or).
 */
async function readDmData(
  client: CatchupDbClient,
  trialIds: string[] | null,
  sinceIso: string,
  nowIso: string,
): Promise<DmData> {
  const msgCols = 'id,channel_id,sender_user_id,body,created_at';
  const chanCols = 'channel_id,workspace_id,dm_user_a,dm_user_b';
  const messagesBase = () =>
    client
      .from('chat_messages')
      .select(msgCols)
      .gte('created_at', sinceIso)
      .lt('created_at', nowIso)
      .is('deleted_at', null)
      .not('sender_user_id', 'is', null);

  let channels: ChannelRow[];
  let messages: MessageRow[];
  if (trialIds === null) {
    messages = await readPaged<MessageRow>('chat_messages', (from, to) =>
      messagesBase().order('id').range(from, to),
    );
    const channelIds = [...new Set(messages.map((m) => m.channel_id))];
    channels = await readByIds<ChannelRow>('chat_channels', channelIds, (chunk, from, to) =>
      client
        .from('chat_channels')
        .select(chanCols)
        .eq('channel_type', 'dm')
        .in('channel_id', chunk)
        .order('channel_id')
        .range(from, to),
    );
  } else {
    const byColumn = (column: 'dm_user_a' | 'dm_user_b') =>
      readByIds<ChannelRow>('chat_channels', trialIds, (chunk, from, to) =>
        client
          .from('chat_channels')
          .select(chanCols)
          .eq('channel_type', 'dm')
          .in(column, chunk)
          .order('channel_id')
          .range(from, to),
      );
    const all = [...(await byColumn('dm_user_a')), ...(await byColumn('dm_user_b'))];
    channels = [...new Map(all.map((c) => [c.channel_id, c])).values()];
    messages = await readByIds<MessageRow>(
      'chat_messages',
      channels.map((c) => c.channel_id),
      (chunk, from, to) => messagesBase().in('channel_id', chunk).order('id').range(from, to),
    );
  }
  const dmIds = new Set(channels.map((c) => c.channel_id));
  return { channels, messages: messages.filter((m) => dmIds.has(m.channel_id)) };
}

// --- digest assembly --------------------------------------------------------

interface Lookups {
  names: Map<string, string>;
  posts: Map<string, PostRow>;
  briefs: Map<string, BriefRow>;
  reviewByWorkspace: Map<string, PostRow[]>;
  messagesByChannel: Map<string, MessageRow[]>;
  cursors: Map<string, string | null>;
  activeMembers: Set<string>;
}

interface Assembled {
  digest: Omit<RecipientDigest, 'unsubscribeUrl'>;
  entryIds: string[];
}

function assembleDigest(c: DueCandidate, look: Lookups, appBaseUrl: string): Assembled | null {
  const urls = buildCatchupUrls(appBaseUrl, c.workspaceId);
  const { window } = c.decision;
  const name = (id: string | null): string =>
    (id !== null ? look.names.get(id) : undefined) ?? UNKNOWN_NAME;
  const postIn = (id: string | null): PostRow | undefined => {
    const post = id !== null ? look.posts.get(id) : undefined;
    return post?.workspace_id === c.workspaceId ? post : undefined;
  };
  const briefIn = (id: string | null): BriefRow | undefined => {
    const brief = id !== null ? look.briefs.get(id) : undefined;
    return brief?.workspace_id === c.workspaceId ? brief : undefined;
  };

  const comments: CommentItem[] = [];
  const approved: StageItem[] = [];
  let parked = 0;
  let newBriefs = 0;
  const entryIds: string[] = [];

  for (const e of c.entries) {
    if (e.event_type === 'comment' || e.event_type === 'mention') {
      const entityType =
        e.entity_type === 'post' || e.entity_type === 'brief' ? e.entity_type : null;
      const target = entityType === 'post' ? postIn(e.entity_id) : briefIn(e.entity_id);
      if (entityType === null || target === undefined) continue;
      const commentId = payloadString(e.payload, 'comment_id');
      comments.push({
        actorName: name(commentActorId(e)),
        targetTitle: target.title,
        entityType,
        entityId: target.id,
        url:
          commentId !== undefined
            ? urls.comment(entityType, target.id, commentId)
            : entityType === 'post'
              ? urls.post(target.id)
              : urls.brief(target.id),
        createdAt: e.created_at,
        mention: e.event_type === 'mention',
      });
      entryIds.push(e.id);
    } else if (e.event_type === 'stage_change') {
      const post = postIn(e.entity_id);
      const toStage = payloadString(e.payload, 'to_stage');
      if (post === undefined) continue;
      if (toStage === 'approved') {
        approved.push({
          postId: post.id,
          title: post.title,
          url: urls.post(post.id),
          toStage,
          createdAt: e.created_at,
        });
      } else if (toStage === 'parked') {
        parked++;
      } else {
        continue;
      }
      entryIds.push(e.id);
    } else if (e.event_type === 'brief_created') {
      if (briefIn(e.entity_id) === undefined) continue;
      newBriefs++;
      entryIds.push(e.id);
    }
  }

  const dms: DmItem[] = [];
  const latestAt = new Map<string, string>();
  let dmInWindow = false;
  for (const ch of c.channels) {
    const cursor = look.cursors.get(pairKey(ch.channel_id, c.userId)) ?? null;
    // After the read cursor when one exists; otherwise the half-open window
    // start, so a message at exactly window.start is not lost between slots.
    const afterFloor = (iso: string): boolean =>
      cursor !== null ? ms(iso) > ms(cursor) : ms(iso) >= ms(window.start);
    const unread = (look.messagesByChannel.get(ch.channel_id) ?? []).filter(
      (m) =>
        m.sender_user_id !== null &&
        m.sender_user_id !== c.userId &&
        afterFloor(m.created_at) &&
        ms(m.created_at) < ms(window.end),
    );
    const latest = newestFirst(unread, (m) => m.created_at)[0];
    if (latest === undefined || latest.sender_user_id === null) continue;
    if (unread.some((m) => ms(m.created_at) >= ms(window.start))) dmInWindow = true;
    dms.push({
      channelId: ch.channel_id,
      senderUserId: latest.sender_user_id,
      senderName: name(latest.sender_user_id),
      unreadCount: unread.length,
      latestBody: latest.body,
      url: urls.chat(ch.channel_id),
    });
    latestAt.set(ch.channel_id, latest.created_at);
  }

  if (entryIds.length === 0 && !dmInWindow) return null;

  newestFirst(comments, (i) => i.createdAt);
  newestFirst(approved, (i) => i.createdAt);
  newestFirst(dms, (d) => latestAt.get(d.channelId) ?? window.start);

  const mentionNames: Record<string, string> = {};
  for (const dm of dms) {
    for (const id of mentionIds(dm.latestBody)) {
      const display = look.names.get(id);
      if (display !== undefined && look.activeMembers.has(pairKey(id, c.workspaceId))) {
        mentionNames[id] = display;
      }
    }
  }

  const audience = isAgency(c.role) ? 'agency' : 'client';
  const reviewRows = [...(look.reviewByWorkspace.get(c.workspaceId) ?? [])];
  reviewRows.sort((x, y) =>
    audience === 'client'
      ? ms(y.stage_entered_at) - ms(x.stage_entered_at)
      : ms(x.stage_entered_at) - ms(y.stage_entered_at),
  );
  const review: PostItem[] = reviewRows.slice(0, REVIEW_ITEM_LIMIT).map((p) => ({
    postId: p.id,
    title: p.title,
    url: urls.post(p.id),
    stageEnteredAt: p.stage_entered_at,
  }));

  return {
    entryIds,
    digest: {
      userId: c.userId,
      workspaceId: c.workspaceId,
      workspaceName: c.workspaceName,
      role: c.role,
      audience,
      slot: c.decision.slot,
      local: c.decision.local,
      previous: c.decision.previous,
      appBaseUrl,
      mentionNames,
      counts: {
        inReview: reviewRows.length,
        unreadMessages: dms.reduce((sum, d) => sum + d.unreadCount, 0),
        comments: comments.length,
        approved: approved.length,
        parked,
        newBriefs,
      },
      review: { items: review, total: reviewRows.length },
      comments: { items: comments, total: comments.length },
      approved: { items: approved, total: approved.length },
      dms: { items: dms, total: dms.length },
    },
  };
}

// --- orchestration ----------------------------------------------------------

export async function runCatchup(deps: RunCatchupDeps): Promise<CatchupTickResult> {
  const { client, env, gate, deliverer, getEmail, now, log } = deps;
  const nowIso = now.toISOString();
  const sinceIso = new Date(now.getTime() - LOOKBACK_MS).toISOString();
  const trialIds = gate.mode === 'trial' ? [...gate.userIds] : null;
  const allowed = (userId: string) => gate.mode === 'live' || gate.userIds.has(userId);

  // 1. Candidates: (recipient, workspace) pairs with unsent entries or DMs.
  const entries = await readCandidateEntries(client, trialIds, sinceIso, nowIso, now);
  const dm = await readDmData(client, trialIds, sinceIso, nowIso);

  const candidates = new Map<string, Candidate>();
  const candidate = (userId: string, workspaceId: string): Candidate => {
    const key = pairKey(userId, workspaceId);
    const existing = candidates.get(key);
    if (existing !== undefined) return existing;
    const created: Candidate = { userId, workspaceId, entries: [], channels: [] };
    candidates.set(key, created);
    return created;
  };
  for (const e of entries) {
    if (allowed(e.user_id)) candidate(e.user_id, e.workspace_id).entries.push(e);
  }

  const messagesByChannel = new Map<string, MessageRow[]>();
  for (const m of dm.messages) {
    const list = messagesByChannel.get(m.channel_id) ?? [];
    list.push(m);
    messagesByChannel.set(m.channel_id, list);
  }
  for (const ch of dm.channels) {
    const msgs = messagesByChannel.get(ch.channel_id) ?? [];
    for (const participant of [ch.dm_user_a, ch.dm_user_b]) {
      if (participant === null || !allowed(participant)) continue;
      if (msgs.some((m) => m.sender_user_id !== null && m.sender_user_id !== participant)) {
        candidate(participant, ch.workspace_id).channels.push(ch);
      }
    }
  }
  if (candidates.size === 0) return { sent: 0, failed: 0, skipped: 0 };

  // 2. Batched lookups across every candidate.
  const recipientIds = [...new Set([...candidates.values()].map((c) => c.userId))];
  const workspaceIds = [...new Set([...candidates.values()].map((c) => c.workspaceId))];
  const mentioned = new Set<string>();
  const nameIds = new Set<string>(recipientIds);
  for (const c of candidates.values()) {
    for (const e of c.entries) {
      const actor = commentActorId(e);
      if (actor !== null) nameIds.add(actor);
    }
  }
  for (const m of dm.messages) {
    if (m.sender_user_id !== null) nameIds.add(m.sender_user_id);
    for (const id of mentionIds(m.body)) mentioned.add(id);
  }
  for (const id of mentioned) nameIds.add(id);

  const users = new Map<string, UserRow>();
  for (const u of await readByIds<UserRow>('users', [...nameIds], (chunk, from, to) =>
    client
      .from('users')
      .select('id,display_name,timezone,email_opt_in,deleted_at')
      .in('id', chunk)
      .order('id')
      .range(from, to),
  )) {
    users.set(u.id, u);
  }

  const workspaces = new Map<string, WorkspaceRow>();
  for (const w of await readByIds<WorkspaceRow>('workspaces', workspaceIds, (chunk, from, to) =>
    client
      .from('workspaces')
      .select('id,name,timezone')
      .in('id', chunk)
      .is('deleted_at', null)
      .order('id')
      .range(from, to),
  )) {
    workspaces.set(w.id, w);
  }

  const memberUserIds = [...new Set([...recipientIds, ...mentioned])];
  const roles = new Map<string, string>();
  for (const m of await readByIdPairs<MemberRow>(
    'workspace_members',
    memberUserIds,
    workspaceIds,
    (userChunk, wsChunk, from, to) =>
      client
        .from('workspace_members')
        .select('id,user_id,workspace_id,role')
        .in('user_id', userChunk)
        .in('workspace_id', wsChunk)
        .eq('active', true)
        .is('removed_at', null)
        .order('id')
        .range(from, to),
  )) {
    roles.set(pairKey(m.user_id, m.workspace_id), m.role);
  }

  // 3. Per-candidate gating: opt-in, membership, slot, window.
  let skipped = 0;
  const due: DueCandidate[] = [];
  for (const c of candidates.values()) {
    const user = users.get(c.userId);
    const workspace = workspaces.get(c.workspaceId);
    const role = roles.get(pairKey(c.userId, c.workspaceId));
    if (
      user === undefined ||
      user.deleted_at !== null ||
      !user.email_opt_in ||
      workspace === undefined ||
      role === undefined
    ) {
      skipped++;
      continue;
    }
    const decision = decideSlot(user.timezone ?? workspace.timezone ?? null, now);
    if (!decision.send) {
      if (decision.reason === 'no_timezone' || decision.reason === 'invalid_timezone') {
        log.warn('catch-up skipped: no usable timezone', {
          user_id: c.userId,
          workspace_id: c.workspaceId,
          reason: decision.reason,
        });
      }
      skipped++;
      continue;
    }
    const start = ms(decision.window.start);
    const end = ms(decision.window.end);
    due.push({
      ...c,
      entries: c.entries.filter((e) => ms(e.created_at) >= start && ms(e.created_at) < end),
      decision,
      workspaceName: workspace.name,
      // workspace_members.role is CHECK-constrained to the Role values.
      role: role as Role,
    });
  }

  // 4. Content lookups for due candidates only, scoped to their workspaces.
  const dueWorkspaceIds = [...new Set(due.map((c) => c.workspaceId))];
  const dueUserIds = [...new Set(due.map((c) => c.userId))];
  const postIds = new Set<string>();
  const briefIds = new Set<string>();
  for (const c of due) {
    for (const e of c.entries) {
      if (e.entity_id === null) continue;
      if (e.event_type === 'stage_change' || e.entity_type === 'post') postIds.add(e.entity_id);
      else if (e.event_type === 'brief_created' || e.entity_type === 'brief')
        briefIds.add(e.entity_id);
    }
  }

  const postCols = 'id,workspace_id,title,stage,stage_entered_at';
  const posts = new Map<string, PostRow>();
  for (const p of await readByIdPairs<PostRow>(
    'posts',
    [...postIds],
    dueWorkspaceIds,
    (idChunk, wsChunk, from, to) =>
      client
        .from('posts')
        .select(postCols)
        .in('id', idChunk)
        .in('workspace_id', wsChunk)
        .neq('stage', 'draft')
        .is('deleted_at', null)
        .order('id')
        .range(from, to),
  )) {
    posts.set(p.id, p);
  }

  const briefs = new Map<string, BriefRow>();
  for (const b of await readByIdPairs<BriefRow>(
    'briefs',
    [...briefIds],
    dueWorkspaceIds,
    (idChunk, wsChunk, from, to) =>
      client
        .from('briefs')
        .select('id,workspace_id,title')
        .in('id', idChunk)
        .in('workspace_id', wsChunk)
        .is('deleted_at', null)
        .order('id')
        .range(from, to),
  )) {
    briefs.set(b.id, b);
  }

  const reviewByWorkspace = new Map<string, PostRow[]>();
  for (const p of await readByIds<PostRow>('review posts', dueWorkspaceIds, (chunk, from, to) =>
    client
      .from('posts')
      .select(postCols)
      .in('workspace_id', chunk)
      .eq('stage', 'review')
      .neq('stage', 'draft')
      .is('deleted_at', null)
      .order('id')
      .range(from, to),
  )) {
    const list = reviewByWorkspace.get(p.workspace_id) ?? [];
    list.push(p);
    reviewByWorkspace.set(p.workspace_id, list);
  }

  const dueChannelIds = [...new Set(due.flatMap((c) => c.channels.map((ch) => ch.channel_id)))];
  const cursors = new Map<string, string | null>();
  for (const r of await readByIdPairs<CursorRow>(
    'chat_read_cursors',
    dueChannelIds,
    dueUserIds,
    (chChunk, userChunk, from, to) =>
      client
        .from('chat_read_cursors')
        .select('channel_id,user_id,last_read_at')
        .in('channel_id', chChunk)
        .in('user_id', userChunk)
        .order('channel_id')
        .order('user_id')
        .range(from, to),
  )) {
    cursors.set(pairKey(r.channel_id, r.user_id), r.last_read_at);
  }

  const names = new Map<string, string>();
  for (const [id, u] of users) names.set(id, u.display_name);
  const look: Lookups = {
    names,
    posts,
    briefs,
    reviewByWorkspace,
    messagesByChannel,
    cursors,
    activeMembers: new Set(roles.keys()),
  };

  // 5. Assemble, render and deliver: one email per user per workspace per slot.
  let sent = 0;
  let failed = 0;
  const tokens = new Map<string, string>();
  for (const c of due) {
    const assembled = assembleDigest(c, look, env.APP_BASE_URL);
    if (assembled === null) {
      skipped++;
      continue;
    }
    try {
      const to = await getEmail(c.userId);
      if (to === null) {
        skipped++;
        continue;
      }
      const token =
        tokens.get(c.userId) ??
        (await signUnsubscribeToken(c.userId, env.UNSUBSCRIBE_SIGNING_SECRET));
      tokens.set(c.userId, token);
      const digest: RecipientDigest = {
        ...assembled.digest,
        unsubscribeUrl: buildUnsubscribePageUrl(env.APP_BASE_URL, c.userId, token),
      };
      const result = await deliverer.deliver({
        userId: c.userId,
        workspaceId: c.workspaceId,
        email: {
          to,
          from: env.CATCHUP_FROM_ADDRESS,
          rendered: renderCatchupEmail(digest),
          idempotencyKey: buildIdempotencyKey(
            c.userId,
            c.workspaceId,
            c.decision.local.isoDate,
            c.decision.slot,
          ),
          headers: buildUnsubscribeHeaders(buildOneClickUrl(env.SUPABASE_URL, c.userId, token)),
        },
        entryIds: assembled.entryIds,
      });
      if (result.ok) sent++;
      else failed++;
    } catch (err) {
      failed++;
      log.error('catch-up delivery threw', {
        user_id: c.userId,
        workspace_id: c.workspaceId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { sent, failed, skipped };
}

// --- entry points -----------------------------------------------------------

export async function handleScheduled(
  env: CatchupEnv,
  now: Date = new Date(),
): Promise<CatchupTickResult> {
  const traceId = uuidv7();
  const log = withTraceLogger(traceId);
  const gate = resolveCatchupGate(env);
  const client = createClient(env.SUPABASE_URL, env.SUPABASE_SECRET_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { [TRACE_ID_HEADER]: traceId } },
  });
  const deliverer = createDeliverer({
    env,
    store: createSupabaseDeliveryStore(client),
    traceId,
    log,
  });
  const getEmail = async (userId: string): Promise<string | null> => {
    const { data, error } = await client.auth.admin.getUserById(userId);
    if (error) {
      log.warn('catch-up email lookup failed', { user_id: userId, error: error.message });
      return null;
    }
    const email = data.user.email;
    return email !== undefined && email !== '' ? email : null;
  };
  const result = await runCatchup({ client, env, gate, deliverer, getEmail, now, log });
  log.info('catch-up tick complete', { mode: gate.mode, ...result });
  return result;
}

export default {
  async scheduled(_controller: unknown, env: CatchupEnv): Promise<void> {
    await handleScheduled(env);
  },
};
