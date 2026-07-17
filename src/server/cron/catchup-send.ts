// Catch-up email cron Worker. Every 30 minutes it reads unsent inbox activity,
// gates each candidate recipient (local send window + inactivity), assembles a
// per-recipient digest from the pure @srtdio/inbox core, sends it through the
// reused @srtdio/workspace Resend sender, then stamps the included rows.
//
// Mirrors src/server/cron/idempotency-cleanup.ts: the testable logic lives in
// exported functions and the Worker entry is `export default { scheduled }`.
// runCatchup is pure of direct I/O (every read/write goes through injected
// gateways) so it is unit-testable with fakes; handleScheduled wires the real
// service-role Supabase client and Resend sender.

import { v7 as uuidv7 } from 'uuid';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import {
  buildCatchupUrls,
  isInSendWindow,
  renderCatchupEmail,
  type CatchupData,
  type CatchupRow,
  type ChatRow,
  type StageKind,
} from '@srtdio/inbox';
import { createResendSender, type EmailSender } from '@srtdio/workspace';
import { withTraceLogger } from '@/server/trace';

// --- (A) env ----------------------------------------------------------------

interface CatchupEnv {
  SUPABASE_URL: string;
  SUPABASE_SECRET_KEY: string;
  RESEND_API_KEY: string;
  APP_BASE_URL: string;
  CATCHUP_FROM_ADDRESS: string;
}

// --- constants --------------------------------------------------------------

// inbox_entries event types that turn into catch-up rows. A deliberate SUBSET of
// the canonical INBOX_EVENT_TYPES (@srtdio/schemas): points/ready (checkpoints_
// added / post_ready) and the account events (invite / trial_warning /
// billing_failure / system) intentionally do not generate a catch-up digest.
// event-types.test.ts asserts this stays a subset so a value the DB rejects can
// never be read here.
export const CATCHUP_EVENT_TYPES = [
  'comment',
  'mention',
  'comment_resolved',
  'stage_change',
  'brief_created',
  'brief_closed',
  'asset_uploaded',
  'asset_version_added',
] as const;
type CatchupEventType = (typeof CATCHUP_EVENT_TYPES)[number];

// delivery_attempts.template_key for catch-up sends. Doubles as the chat dedupe
// floor: chat has no inbox rows to stamp, so the per-recipient last catch-up
// sent_at is what bounds the next slot's DM counts.
const CATCHUP_TEMPLATE_KEY = 'catchup';

const SLOT_MS = 30 * 60 * 1000;
const INACTIVITY_MS = 5 * 60 * 1000;
const DM_FLOOR_FALLBACK_MS = 24 * 60 * 60 * 1000;
const READ_BATCH = 1000;

// --- (B) gateway boundary ---------------------------------------------------

interface UserInfo {
  displayName: string;
  timezone: string | null;
}
interface WorkspaceInfo {
  name: string;
  timezone: string | null;
}
interface AssetInfo {
  filename: string;
  uploadedBy: string | null;
}
export interface UnsentEntry {
  id: string;
  userId: string;
  workspaceId: string;
  eventType: CatchupEventType;
  entityType: string | null;
  entityId: string | null;
  payload: Record<string, unknown>;
  createdAt: string;
}
export interface DmCount {
  peerUserId: string;
  count: number;
  channelId: string;
}
export interface DeliveryRecord {
  workspace_id: string;
  user_id: string;
  channel: 'email';
  template_key: string;
  provider: 'resend';
  provider_message_id: string | null;
  status: 'sent' | 'failed';
  sent_at: string | null;
  error: string | null;
  email_thread_id: null;
}

// Reuse the sender's message shape verbatim (do not redefine the sender).
type SendMessage = Parameters<EmailSender['send']>[0];

export interface CatchupGateways {
  /** Deep-link base (env.APP_BASE_URL); never hardcoded. */
  baseUrl: string;
  /** Verified Resend sender identity (env.CATCHUP_FROM_ADDRESS). */
  fromAddress: string;
  readUnsentEntries(): Promise<UnsentEntry[]>;
  resolveUsers(ids: string[]): Promise<Map<string, UserInfo>>;
  resolveWorkspaces(ids: string[]): Promise<Map<string, WorkspaceInfo>>;
  resolvePosts(ids: string[]): Promise<Map<string, string>>;
  resolveBriefs(ids: string[]): Promise<Map<string, string>>;
  resolveAssets(ids: string[]): Promise<Map<string, AssetInfo>>;
  latestSeenAt(userIds: string[]): Promise<Map<string, string | null>>;
  lastCatchupAt(userIds: string[]): Promise<Map<string, string | null>>;
  dmCountsSince(userIds: string[], floors: Map<string, string>): Promise<Map<string, DmCount[]>>;
  emailsFor(userIds: string[]): Promise<Map<string, string>>;
  send(message: SendMessage): Promise<{ id: string }>;
  stampSent(entryIds: string[], atIso: string): Promise<void>;
  recordDelivery(row: DeliveryRecord): Promise<void>;
}

// --- small pure helpers -----------------------------------------------------

function pstr(payload: Record<string, unknown>, key: string): string | undefined {
  const v = payload[key];
  return typeof v === 'string' ? v : undefined;
}

const STAGE_KINDS = new Set<StageKind>(['approved', 'rejected', 'review', 'parked']);
function toStageKind(v: string | undefined): StageKind | undefined {
  return v !== undefined && STAGE_KINDS.has(v as StageKind) ? (v as StageKind) : undefined;
}

// Comment/mention and brief_created carry their actor in the payload;
// stage_change, brief_closed and comment_resolved are actor-less; asset actors
// come from the resolved assets.uploaded_by (handled at the call site).
function payloadActorId(e: UnsentEntry): string | undefined {
  switch (e.eventType) {
    case 'comment':
    case 'mention':
      return pstr(e.payload, 'author_user_id');
    case 'brief_created':
      return pstr(e.payload, 'created_by');
    default:
      return undefined;
  }
}

function entityKind(e: UnsentEntry): 'post' | 'brief' | 'asset' | null {
  switch (e.eventType) {
    case 'stage_change':
      return 'post';
    case 'brief_created':
    case 'brief_closed':
      return 'brief';
    case 'asset_uploaded':
    case 'asset_version_added':
      return 'asset';
    case 'comment':
    case 'mention':
    case 'comment_resolved':
      return e.entityType === 'brief' ? 'brief' : 'post';
    default:
      return null;
  }
}

function floorToSlotIso(now: Date): string {
  return new Date(Math.floor(now.getTime() / SLOT_MS) * SLOT_MS).toISOString();
}

function formatTime(iso: string, timezone: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(iso));
}

function formatSinceLabel(iso: string, timezone: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    weekday: 'short',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(iso));
}

function unique(ids: string[]): string[] {
  return [...new Set(ids)];
}

// --- (B/D/F/G/H) the pure orchestration -------------------------------------

export async function runCatchup(
  g: CatchupGateways,
  now: Date,
): Promise<{ sent: number; skipped: number }> {
  const entries = await g.readUnsentEntries();
  if (entries.length === 0) return { sent: 0, skipped: 0 };

  // (C) one candidate email per (recipient, workspace).
  const candidates = new Map<
    string,
    { userId: string; workspaceId: string; entries: UnsentEntry[] }
  >();
  for (const e of entries) {
    const key = `${e.userId}::${e.workspaceId}`;
    const c = candidates.get(key) ?? { userId: e.userId, workspaceId: e.workspaceId, entries: [] };
    c.entries.push(e);
    candidates.set(key, c);
  }

  // (D) collect every id once, then resolve each kind in ONE batched read.
  const postIds = new Set<string>();
  const briefIds = new Set<string>();
  const assetIds = new Set<string>();
  for (const e of entries) {
    if (e.entityId === null) continue;
    const kind = entityKind(e);
    if (kind === 'post') postIds.add(e.entityId);
    else if (kind === 'brief') briefIds.add(e.entityId);
    else if (kind === 'asset') assetIds.add(e.entityId);
  }

  // Assets first: their uploaded_by feeds the actor id set.
  const assets = await g.resolveAssets([...assetIds]);

  const actorIds = new Set<string>();
  for (const e of entries) {
    const a = payloadActorId(e);
    if (a !== undefined) actorIds.add(a);
    if (
      (e.eventType === 'asset_uploaded' || e.eventType === 'asset_version_added') &&
      e.entityId !== null
    ) {
      const up = assets.get(e.entityId)?.uploadedBy;
      if (up) actorIds.add(up);
    }
  }

  const [posts, briefs] = await Promise.all([
    g.resolvePosts([...postIds]),
    g.resolveBriefs([...briefIds]),
  ]);

  const recipientIds = unique([...candidates.values()].map((c) => c.userId));
  const lastCatchup = await g.lastCatchupAt(recipientIds);

  // (F) per-recipient DM floor = their last catch-up, else now-24h.
  const fallbackFloor = new Date(now.getTime() - DM_FLOOR_FALLBACK_MS).toISOString();
  const floors = new Map<string, string>();
  for (const id of recipientIds) floors.set(id, lastCatchup.get(id) ?? fallbackFloor);

  const dm = await g.dmCountsSince(recipientIds, floors);
  const latestSeen = await g.latestSeenAt(recipientIds);
  const emails = await g.emailsFor(recipientIds);

  const peerIds = new Set<string>();
  for (const list of dm.values()) for (const d of list) peerIds.add(d.peerUserId);

  const users = await g.resolveUsers(unique([...recipientIds, ...actorIds, ...peerIds]));
  const workspaces = await g.resolveWorkspaces(
    unique([...candidates.values()].map((c) => c.workspaceId)),
  );

  const slotIso = floorToSlotIso(now);
  const nowIso = now.toISOString();

  let sent = 0;
  let skipped = 0;

  for (const c of candidates.values()) {
    const user = users.get(c.userId);
    const workspace = workspaces.get(c.workspaceId);
    const timezone = user?.timezone ?? workspace?.timezone ?? null;

    // (G) Gate 1: must be inside the recipient's local send window. Gate 2:
    // inactive for >= 5 min, or no device row at all. A failed gate skips the
    // recipient: no send, no stamp, so the entries roll to the next slot.
    if (timezone === null || !isInSendWindow(timezone, now)) {
      skipped++;
      continue;
    }
    const seen = latestSeen.get(c.userId) ?? null;
    if (seen !== null && now.getTime() - new Date(seen).getTime() < INACTIVITY_MS) {
      skipped++;
      continue;
    }

    const email = emails.get(c.userId);
    if (email === undefined) {
      skipped++;
      continue;
    }

    const urls = buildCatchupUrls(g.baseUrl, c.workspaceId);
    const stages: CatchupRow[] = [];
    const comments: CatchupRow[] = [];
    const briefRows: CatchupRow[] = [];
    const assetRows: CatchupRow[] = [];
    const includedEntryIds: string[] = [];

    const actorName = (id: string | undefined): string =>
      (id !== undefined ? users.get(id)?.displayName : undefined) ?? 'Someone';

    for (const e of c.entries) {
      if (e.entityId === null) continue;
      const time = formatTime(e.createdAt, timezone);

      switch (e.eventType) {
        case 'comment':
        case 'mention':
        case 'comment_resolved': {
          const et: 'post' | 'brief' = e.entityType === 'brief' ? 'brief' : 'post';
          const title =
            (et === 'brief' ? briefs.get(e.entityId) : posts.get(e.entityId)) ?? 'Untitled';
          const verb =
            e.eventType === 'comment'
              ? 'commented on'
              : e.eventType === 'mention'
                ? 'mentioned you on'
                : 'resolved a comment thread on';
          comments.push({
            who: actorName(pstr(e.payload, 'author_user_id')),
            verb,
            target: title,
            time,
            url: urls.comment(et, e.entityId, pstr(e.payload, 'comment_id') ?? ''),
          });
          includedEntryIds.push(e.id);
          break;
        }
        case 'stage_change': {
          // Actor-less, state-led: target = post title, coloured by stage.
          const stage = toStageKind(pstr(e.payload, 'to_stage'));
          const stageRow: CatchupRow = {
            verb: stage ? '' : 'stage updated',
            target: posts.get(e.entityId) ?? 'Untitled',
            time,
            url: urls.post(e.entityId),
          };
          if (stage !== undefined) stageRow.stage = stage;
          stages.push(stageRow);
          includedEntryIds.push(e.id);
          break;
        }
        case 'brief_created': {
          briefRows.push({
            who: actorName(pstr(e.payload, 'created_by')),
            verb: 'opened a brief:',
            target: pstr(e.payload, 'title') ?? briefs.get(e.entityId) ?? 'Untitled',
            time,
            url: urls.brief(e.entityId),
          });
          includedEntryIds.push(e.id);
          break;
        }
        case 'brief_closed': {
          // Actor-less: "Brief closed: {title}".
          briefRows.push({
            verb: 'Brief closed:',
            target: briefs.get(e.entityId) ?? pstr(e.payload, 'title') ?? 'Untitled',
            time,
            url: urls.brief(e.entityId),
          });
          includedEntryIds.push(e.id);
          break;
        }
        case 'asset_uploaded':
        case 'asset_version_added': {
          const asset = assets.get(e.entityId);
          if (asset === undefined) continue;
          assetRows.push({
            who: actorName(asset.uploadedBy ?? undefined),
            verb: e.eventType === 'asset_uploaded' ? 'added' : 'added a new version of',
            target: asset.filename,
            time,
            url: urls.asset(e.entityId),
          });
          includedEntryIds.push(e.id);
          break;
        }
      }
    }

    const chats: ChatRow[] = (dm.get(c.userId) ?? [])
      .filter((d) => d.count > 0)
      .map((d) => ({
        who: users.get(d.peerUserId)?.displayName ?? 'Someone',
        count: d.count,
        url: urls.chat(d.channelId),
      }));

    const rowCount = stages.length + comments.length + briefRows.length + assetRows.length;
    if (rowCount === 0 && chats.length === 0) {
      skipped++;
      continue;
    }

    const floor = floors.get(c.userId) ?? fallbackFloor;
    const data: CatchupData = {
      workspaceId: c.workspaceId,
      workspaceName: workspace?.name ?? 'Workspace',
      recipientUserId: c.userId,
      sinceLabel: formatSinceLabel(floor, timezone),
      stages,
      comments,
      briefs: briefRows,
      assets: assetRows,
      chats,
    };

    const { subject, html, text, messageId } = renderCatchupEmail(data);

    // (H) Send THEN stamp. A crash between the two risks at most one duplicate
    // at the next slot, which is acceptable per the PR spec. On send failure we
    // record the attempt as failed and do NOT stamp, so the rows retry next slot.
    let providerMessageId: string;
    try {
      const res = await g.send({
        to: email,
        from: g.fromAddress,
        subject,
        messageId: messageId(slotIso),
        html,
        text,
      });
      providerMessageId = res.id;
    } catch (err) {
      await g.recordDelivery({
        workspace_id: c.workspaceId,
        user_id: c.userId,
        channel: 'email',
        template_key: CATCHUP_TEMPLATE_KEY,
        provider: 'resend',
        provider_message_id: null,
        status: 'failed',
        sent_at: null,
        error: err instanceof Error ? err.message : String(err),
        email_thread_id: null,
      });
      skipped++;
      continue;
    }

    await g.stampSent(includedEntryIds, nowIso);
    // recordDelivery runs for every successful send: it is the chat dedupe floor
    // (chat has no inbox rows to stamp).
    await g.recordDelivery({
      workspace_id: c.workspaceId,
      user_id: c.userId,
      channel: 'email',
      template_key: CATCHUP_TEMPLATE_KEY,
      provider: 'resend',
      provider_message_id: providerMessageId,
      status: 'sent',
      sent_at: nowIso,
      error: null,
      email_thread_id: null,
    });
    sent++;
  }

  return { sent, skipped };
}

// --- real Supabase-backed gateways ------------------------------------------

// Row shapes for casts. The service-role client is built without the Database
// generic (like idempotency-cleanup's store); each select casts to these.
interface InboxEntryRow {
  id: string;
  user_id: string;
  workspace_id: string;
  event_type: string;
  entity_type: string | null;
  entity_id: string | null;
  payload: unknown;
  created_at: string;
}
interface UserRow {
  id: string;
  display_name: string;
  timezone: string | null;
}
interface WorkspaceRow {
  id: string;
  name: string;
  timezone: string | null;
}
interface TitleRow {
  id: string;
  title: string;
}
interface AssetRow {
  id: string;
  filename: string;
  uploaded_by: string | null;
}
interface SeenRow {
  user_id: string;
  last_seen_at: string | null;
}
interface AttemptRow {
  user_id: string | null;
  sent_at: string | null;
}
interface DmChannelRow {
  channel_id: string;
  dm_user_a: string | null;
  dm_user_b: string | null;
}
interface DmMessageRow {
  channel_id: string;
  sender_user_id: string | null;
  created_at: string;
}

/**
 * Connection/transaction choice: ONE service-role client for the whole run with
 * no explicit transaction. Every resolution below is a single batched IN read
 * (no N+1); stamping is a single bulk UPDATE ... WHERE id IN (...). The
 * send-then-stamp ordering (see runCatchup) accepts at most one duplicate on a
 * mid-flight crash.
 */
function createCatchupGateways(
  client: SupabaseClient,
  sender: EmailSender,
  env: CatchupEnv,
  now: Date,
): CatchupGateways {
  const nowIso = now.toISOString();

  return {
    baseUrl: env.APP_BASE_URL,
    fromAddress: env.CATCHUP_FROM_ADDRESS,

    async readUnsentEntries() {
      const out: UnsentEntry[] = [];
      for (let from = 0; ; from += READ_BATCH) {
        const { data, error } = await client
          .from('inbox_entries')
          .select('id,user_id,workspace_id,event_type,entity_type,entity_id,payload,created_at')
          .is('email_sent_at', null)
          .is('deleted_at', null)
          .or(`snoozed_until.is.null,snoozed_until.lte.${nowIso}`)
          .in('event_type', [...CATCHUP_EVENT_TYPES])
          .order('created_at', { ascending: true })
          .range(from, from + READ_BATCH - 1);
        if (error) throw error;
        const rows = (data ?? []) as InboxEntryRow[];
        for (const r of rows) {
          out.push({
            id: r.id,
            userId: r.user_id,
            workspaceId: r.workspace_id,
            eventType: r.event_type as CatchupEventType,
            entityType: r.entity_type,
            entityId: r.entity_id,
            payload:
              r.payload !== null && typeof r.payload === 'object'
                ? (r.payload as Record<string, unknown>)
                : {},
            createdAt: r.created_at,
          });
        }
        if (rows.length < READ_BATCH) break;
      }
      return out;
    },

    async resolveUsers(ids) {
      const m = new Map<string, UserInfo>();
      if (ids.length === 0) return m;
      const { data, error } = await client
        .from('users')
        .select('id,display_name,timezone')
        .in('id', ids);
      if (error) throw error;
      for (const r of (data ?? []) as UserRow[])
        m.set(r.id, { displayName: r.display_name, timezone: r.timezone });
      return m;
    },

    async resolveWorkspaces(ids) {
      const m = new Map<string, WorkspaceInfo>();
      if (ids.length === 0) return m;
      const { data, error } = await client
        .from('workspaces')
        .select('id,name,timezone')
        .in('id', ids);
      if (error) throw error;
      for (const r of (data ?? []) as WorkspaceRow[])
        m.set(r.id, { name: r.name, timezone: r.timezone });
      return m;
    },

    async resolvePosts(ids) {
      const m = new Map<string, string>();
      if (ids.length === 0) return m;
      const { data, error } = await client.from('posts').select('id,title').in('id', ids);
      if (error) throw error;
      for (const r of (data ?? []) as TitleRow[]) m.set(r.id, r.title);
      return m;
    },

    async resolveBriefs(ids) {
      const m = new Map<string, string>();
      if (ids.length === 0) return m;
      const { data, error } = await client.from('briefs').select('id,title').in('id', ids);
      if (error) throw error;
      for (const r of (data ?? []) as TitleRow[]) m.set(r.id, r.title);
      return m;
    },

    async resolveAssets(ids) {
      const m = new Map<string, AssetInfo>();
      if (ids.length === 0) return m;
      const { data, error } = await client
        .from('assets')
        .select('id,filename,uploaded_by')
        .in('id', ids);
      if (error) throw error;
      for (const r of (data ?? []) as AssetRow[])
        m.set(r.id, { filename: r.filename, uploadedBy: r.uploaded_by });
      return m;
    },

    async latestSeenAt(userIds) {
      const m = new Map<string, string | null>();
      if (userIds.length === 0) return m;
      const { data, error } = await client
        .from('session_devices')
        .select('user_id,last_seen_at')
        .is('revoked_at', null)
        .in('user_id', userIds);
      if (error) throw error;
      for (const r of (data ?? []) as SeenRow[]) {
        if (r.last_seen_at === null) continue;
        const prev = m.get(r.user_id) ?? null;
        if (prev === null || r.last_seen_at > prev) m.set(r.user_id, r.last_seen_at);
      }
      return m;
    },

    async lastCatchupAt(userIds) {
      const m = new Map<string, string | null>();
      if (userIds.length === 0) return m;
      const { data, error } = await client
        .from('delivery_attempts')
        .select('user_id,sent_at')
        .eq('template_key', CATCHUP_TEMPLATE_KEY)
        .eq('status', 'sent')
        .in('user_id', userIds);
      if (error) throw error;
      for (const r of (data ?? []) as AttemptRow[]) {
        if (r.user_id === null || r.sent_at === null) continue;
        const prev = m.get(r.user_id) ?? null;
        if (prev === null || r.sent_at > prev) m.set(r.user_id, r.sent_at);
      }
      return m;
    },

    async dmCountsSince(userIds, floors) {
      const result = new Map<string, DmCount[]>();
      if (userIds.length === 0) return result;
      // Two batched IN reads (channels, then their messages), reduced in memory.
      // Constant query count regardless of recipient count: no N+1.
      const idList = userIds.join(',');
      const { data: chData, error: chErr } = await client
        .from('chat_channels')
        .select('channel_id,dm_user_a,dm_user_b')
        .eq('channel_type', 'dm')
        .or(`dm_user_a.in.(${idList}),dm_user_b.in.(${idList})`);
      if (chErr) throw chErr;
      const channels = (chData ?? []) as DmChannelRow[];
      if (channels.length === 0) return result;

      const byChannel = new Map<string, DmChannelRow>();
      for (const ch of channels) byChannel.set(ch.channel_id, ch);
      const recipientSet = new Set(userIds);

      let minFloor: string | null = null;
      for (const id of userIds) {
        const f = floors.get(id);
        if (f !== undefined && (minFloor === null || f < minFloor)) minFloor = f;
      }

      let msgQuery = client
        .from('chat_messages')
        .select('channel_id,sender_user_id,created_at')
        .is('deleted_at', null)
        .in('channel_id', [...byChannel.keys()]);
      if (minFloor !== null) msgQuery = msgQuery.gt('created_at', minFloor);
      const { data: msgData, error: msgErr } = await msgQuery;
      if (msgErr) throw msgErr;
      const messages = (msgData ?? []) as DmMessageRow[];

      const acc = new Map<string, Map<string, { count: number; channelId: string }>>();
      for (const msg of messages) {
        const ch = byChannel.get(msg.channel_id);
        if (!ch || ch.dm_user_a === null || ch.dm_user_b === null) continue;
        for (const recipient of [ch.dm_user_a, ch.dm_user_b]) {
          if (!recipientSet.has(recipient)) continue;
          if (msg.sender_user_id === null || msg.sender_user_id === recipient) continue;
          const floor = floors.get(recipient);
          if (floor !== undefined && !(msg.created_at > floor)) continue;
          const peer = ch.dm_user_a === recipient ? ch.dm_user_b : ch.dm_user_a;
          const peerMap =
            acc.get(recipient) ?? new Map<string, { count: number; channelId: string }>();
          const cell = peerMap.get(peer) ?? { count: 0, channelId: ch.channel_id };
          cell.count += 1;
          peerMap.set(peer, cell);
          acc.set(recipient, peerMap);
        }
      }
      for (const [recipient, peerMap] of acc) {
        const list: DmCount[] = [];
        for (const [peerUserId, cell] of peerMap)
          list.push({ peerUserId, count: cell.count, channelId: cell.channelId });
        result.set(recipient, list);
      }
      return result;
    },

    async emailsFor(userIds) {
      const m = new Map<string, string>();
      if (userIds.length === 0) return m;
      const want = new Set(userIds);
      const perPage = 1000;
      for (let page = 1; ; page++) {
        const { data, error } = await client.auth.admin.listUsers({ page, perPage });
        if (error) throw error;
        const list = data.users;
        for (const u of list) {
          if (u.email !== undefined && u.email.length > 0 && want.has(u.id)) m.set(u.id, u.email);
        }
        if (list.length < perPage) break;
      }
      return m;
    },

    async send(message) {
      return sender.send(message);
    },

    async stampSent(entryIds, atIso) {
      if (entryIds.length === 0) return;
      const { error } = await client
        .from('inbox_entries')
        .update({ email_sent_at: atIso })
        .in('id', entryIds);
      if (error) throw error;
    },

    async recordDelivery(row) {
      const { error } = await client.from('delivery_attempts').insert(row);
      if (error) throw error;
    },
  };
}

// --- entry points -----------------------------------------------------------

export async function handleScheduled(
  env: CatchupEnv,
  now: Date = new Date(),
): Promise<{ sent: number; skipped: number }> {
  const traceId = uuidv7();
  const log = withTraceLogger(traceId);
  const client: SupabaseClient = createClient(env.SUPABASE_URL, env.SUPABASE_SECRET_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const sender = createResendSender({ apiKey: env.RESEND_API_KEY });
  try {
    const result = await runCatchup(createCatchupGateways(client, sender, env, now), now);
    log.info('catch-up send complete', result);
    return result;
  } finally {
    await client.removeAllChannels();
  }
}

export default {
  async scheduled(_controller: unknown, env: CatchupEnv): Promise<void> {
    await handleScheduled(env);
  },
};
