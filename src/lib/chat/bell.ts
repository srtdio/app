// The chat bell's data layer. "Now" is one inbox_entries query narrowed to the
// bell's rows (bell-types.ts: chat mentions, reminders, scheduled, the plan and
// task alerts) for the current workspace, unread, newest first, paged by 50. "Upcoming" is one chat_message_reminders query (pending) and one
// chat_scheduled_messages query (status scheduled; RLS: own rows only). The
// message previews, the failed scheduled rows and the people's names are then
// batched with IN reads (one per table, never per row), as are the plan rows'
// plan titles (when the payload carries none), item titles and post titles.
// Each enrichment read is best-effort: a failure leaves its field empty and
// the row still renders.
//
// The writes are the inbox read-state procs (inbox_mark_read, inbox_snooze,
// inbox_mark_read_events), each with an explicit p_trace_id. Pure helpers take
// `nowMs`; nothing here touches React.

import type { Client, Result } from '@srtdio/rpc';
import { inboxMarkRead, inboxSnooze } from '@srtdio/rpc';
import type { Database, Json } from '@srtdio/schemas';
import { abortable, readProfiles } from '@/lib/chat-reads';
import { ALL_MARK, mentionIds, resolveMentionPreview, type NameOf } from '@/lib/chat/mentions';
import { pendingSoonestFirst, type ReminderRow } from '@/lib/chat/reminders';
import { soonestFirst, type ScheduledRow } from '@/lib/chat/scheduled';
import {
  BELL_CHAT_ENTITY,
  BELL_PLAN_EVENT_TYPES,
  BELL_TASK_EVENT_TYPES,
  isBellPlanEvent,
  isBellTaskEvent,
  onlyBellEntries,
  type BellEventType,
  type BellOnlyEventType,
  INBOX_SNOOZE_OPTIONS,
  type InboxSnoozeKind,
} from '@/lib/inbox/bell-types';
import { planEventLine } from '@/components/pages/activity/data';
import { formatCivilDayHeader } from '@/lib/plan-week';
import type { ViewerSide } from '@/lib/chat/viewer-role';

type Functions = Database['public']['Functions'];
type InboxEntryRow = Database['public']['Tables']['inbox_entries']['Row'];

/** One page of bell rows. */
export const BELL_PAGE_SIZE = 50;
/** A refetch re-reads at most this many rows (the pages already shown). */
export const BELL_MAX_ROWS = 200;

/** Fired on window to make every bell surface refetch (the poll tick, a ring, a write). */
export const BELL_REFRESH_EVENT = 'sorted:bell-refresh';
/** Fired on window after a reminder is set, moved or cancelled: the ring reloads. */
export const REMINDERS_CHANGED_EVENT = 'sorted:reminders-changed';

/** Ask every mounted bell surface (and the ring) to refetch. */
export function requestBellRefresh(): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(BELL_REFRESH_EVENT));
}

/** Tell the ring the pending reminders changed. */
export function announceRemindersChanged(): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(REMINDERS_CHANGED_EVENT));
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

/** One bell inbox row, mapped. */
export interface BellEntry {
  id: string;
  workspaceId: string;
  createdAt: string;
  readAt: string | null;
  snoozedUntil: string | null;
  eventType: BellEventType;
  channelId: string | null;
  /** The chat message the row points at (mention, reminder, scheduled_sent). */
  messageId: string | null;
  reminderId: string | null;
  scheduledId: string | null;
  /** scheduled_failed: the proc's reason, when the payload carries one. */
  reason: string | null;
  /** mention: who mentioned; a plan row: who acted. */
  actorId: string | null;
  /** Plan rows only (absent elsewhere): what the alert names. */
  plan?: BellPlanFields;
  /** Task rows only (absent elsewhere): the change, from the payload. */
  task?: BellTaskFields;
}

/** A task row's payload (task_changed, task_due), mapped. */
export interface BellTaskFields {
  taskId: string | null;
  number: number | null;
  title: string | null;
  /** The change kind (created, status, ..., due_passed; created_many for a batch add). */
  kind: string | null;
  old: string | null;
  new: string | null;
  /** created_many only: how many tasks the one Save added (absent on other rows). */
  count?: number;
}

/** A plan row's payload, mapped (plan_opened .. plan_comment). */
export interface BellPlanFields {
  planId: string | null;
  /** The item the row names (plan_item entity, or payload.item_id). */
  itemId: string | null;
  /** payload.plan_title (part 2b); null on older rows (the loaded title then). */
  planTitle: string | null;
  /** plan_updated: slot_added / slot_removed / concept_changed / renamed. */
  kind: string | null;
  /** plan_updated slot_removed: the removed item's title, when the payload has it. */
  itemTitle: string | null;
  /** The post the row names (payload.post_id). */
  postId: string | null;
  /** renamed: from / to titles; plan_date_changed: from / to days. */
  from: string | null;
  to: string | null;
  /** plan_date_changed: the post left the plan by date. */
  leftPlan: boolean;
  /** plan_review: side, status, withdrawn, previous (the Activity wording). */
  reviewSide: string | null;
  reviewStatus: string | null;
  reviewWithdrawn: boolean;
  reviewPrevious: string | null;
}

function str(payload: unknown, key: string): string | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const value = (payload as Record<string, unknown>)[key];
  return typeof value === 'string' && value !== '' ? value : null;
}

const BELL_TYPES = new Set<string>([
  'mention',
  'reminder',
  'scheduled_sent',
  'scheduled_failed',
  ...BELL_PLAN_EVENT_TYPES,
  ...BELL_TASK_EVENT_TYPES,
]);

function flag(payload: unknown, key: string): boolean {
  return (
    typeof payload === 'object' &&
    payload !== null &&
    (payload as Record<string, unknown>)[key] === true
  );
}

/** A plan row's fields from its entity and payload. Pure. */
export function planFieldsOf(
  row: Pick<InboxEntryRow, 'entity_type' | 'entity_id' | 'payload'>,
): BellPlanFields {
  const payload: unknown = row.payload as Json;
  return {
    planId: str(payload, 'plan_id') ?? (row.entity_type === 'plan' ? row.entity_id : null),
    itemId: row.entity_type === 'plan_item' ? row.entity_id : str(payload, 'item_id'),
    planTitle: str(payload, 'plan_title'),
    kind: str(payload, 'kind'),
    itemTitle: str(payload, 'title'),
    postId: str(payload, 'post_id'),
    from: str(payload, 'from'),
    to: str(payload, 'to'),
    leftPlan: flag(payload, 'left_plan'),
    reviewSide: str(payload, 'side'),
    reviewStatus: str(payload, 'status'),
    reviewWithdrawn: flag(payload, 'withdrawn'),
    reviewPrevious: str(payload, 'previous'),
  };
}

/** A task row's fields from its payload. Pure. */
export function taskFieldsOf(row: Pick<InboxEntryRow, 'payload'>): BellTaskFields {
  const payload: unknown = row.payload as Json;
  const field = (key: string): unknown =>
    typeof payload === 'object' && payload !== null
      ? (payload as Record<string, unknown>)[key]
      : undefined;
  const number = field('number');
  const count = field('count');
  return {
    taskId: str(payload, 'task_id'),
    number: typeof number === 'number' && Number.isFinite(number) ? number : null,
    title: str(payload, 'title'),
    kind: str(payload, 'kind'),
    old: str(payload, 'old'),
    new: str(payload, 'new'),
    ...(typeof count === 'number' && Number.isFinite(count) ? { count } : {}),
  };
}

/** Map a raw inbox row into a BellEntry; null for a row the bell does not show. Pure. */
export function mapBellEntry(row: InboxEntryRow): BellEntry | null {
  if (!BELL_TYPES.has(row.event_type)) return null;
  if (row.event_type === 'mention' && row.entity_type !== BELL_CHAT_ENTITY) return null;
  const payload: unknown = row.payload as Json;
  return {
    ...(isBellPlanEvent(row.event_type) ? { plan: planFieldsOf(row) } : {}),
    ...(isBellTaskEvent(row.event_type) ? { task: taskFieldsOf(row) } : {}),
    id: row.id,
    workspaceId: row.workspace_id,
    createdAt: row.created_at,
    readAt: row.read_at,
    snoozedUntil: row.snoozed_until,
    eventType: row.event_type as BellEventType,
    channelId: row.entity_type === BELL_CHAT_ENTITY ? row.entity_id : null,
    messageId: str(payload, 'message_id'),
    reminderId: str(payload, 'reminder_id'),
    scheduledId: str(payload, 'scheduled_id'),
    reason: str(payload, 'reason'),
    actorId: row.actor_user_id ?? null,
  };
}

/** A previewed chat message. */
export interface BellMessage {
  id: string;
  channelId: string;
  senderUserId: string | null;
  body: string | null;
  hasAttachments: boolean;
  hasPosts: boolean;
  hasBriefs: boolean;
  /** The message shares a plan (chat_plan_share); absent reads as none. */
  hasPlans?: boolean;
}

/** Everything the bell renders. */
export interface BellData {
  /** Unread bell rows, newest first. */
  entries: BellEntry[];
  /** A full page came back: older rows may exist. */
  hasMore: boolean;
  /** Upcoming: pending reminders, soonest first. */
  reminders: ReminderRow[];
  /** Upcoming: pending scheduled messages, soonest first. */
  scheduled: ScheduledRow[];
  /** Failed scheduled rows behind scheduled_failed entries, by id. */
  failed: Map<string, ScheduledRow>;
  /**
   * Every failed-rows read succeeded: a row missing from `failed` (or no
   * longer 'failed') was really sent, cancelled or edited elsewhere.
   */
  failedReadOk: boolean;
  messages: Map<string, BellMessage>;
  names: Map<string, string>;
  /** Plan rows: plan titles by plan id (rows whose payload has none). */
  planTitles?: Map<string, string>;
  /** Plan rows: item titles by item id (a concept's title, a post slot's post title). */
  itemTitles?: Map<string, string>;
}

export const EMPTY_BELL: BellData = {
  entries: [],
  hasMore: false,
  reminders: [],
  scheduled: [],
  failed: new Map(),
  failedReadOk: false,
  messages: new Map(),
  names: new Map(),
  planTitles: new Map(),
  itemTitles: new Map(),
};

// ---------------------------------------------------------------------------
// Pure views
// ---------------------------------------------------------------------------

/** A row is snoozed while its snoozed_until is in the future. Pure. */
export function isSnoozedAt(entry: Pick<BellEntry, 'snoozedUntil'>, nowMs: number): boolean {
  if (entry.snoozedUntil === null) return false;
  const until = Date.parse(entry.snoozedUntil);
  return !Number.isNaN(until) && until > nowMs;
}

export interface BellSections {
  reminders: BellEntry[];
  mentions: BellEntry[];
  scheduled: BellEntry[];
  /** The plan alerts (plan_opened .. plan_comment). */
  plans: BellEntry[];
  /** The task alerts (task_changed, task_due). */
  tasks: BellEntry[];
}

/**
 * The Now tab: unread, not snoozed rows split into Reminders, Mentions,
 * Scheduled (sent and failed), Plans and Tasks, each newest first. Pure.
 */
export function bellSections(entries: readonly BellEntry[], nowMs: number): BellSections {
  const live = entries.filter((e) => e.readAt === null && !isSnoozedAt(e, nowMs));
  return {
    reminders: live.filter((e) => e.eventType === 'reminder'),
    mentions: live.filter((e) => e.eventType === 'mention'),
    scheduled: live.filter(
      (e) => e.eventType === 'scheduled_sent' || e.eventType === 'scheduled_failed',
    ),
    plans: live.filter((e) => isBellPlanEvent(e.eventType)),
    tasks: live.filter((e) => isBellTaskEvent(e.eventType)),
  };
}

/** The bell's dot: unread items in Now. Pure. */
export function bellUnreadCount(entries: readonly BellEntry[], nowMs: number): number {
  const s = bellSections(entries, nowMs);
  return (
    s.reminders.length + s.mentions.length + s.scheduled.length + s.plans.length + s.tasks.length
  );
}

/** The toast when a plan_deleted row is tapped (it opens nothing). */
export const PLAN_DELETED_BELL_TOAST = 'This plan was deleted';

/** What a plan row's line names, resolved by the caller (actor, plan and item). */
export interface PlanBellNames {
  who: string | null;
  plan: string | null;
  item: string | null;
}

/**
 * A plan row's line ({who} the actor, {plan} payload.plan_title or the loaded
 * title, {item} the item's title):
 *   plan_opened: client "{who} shared {plan} with you", agency "{who} opened
 *   {plan} for client"; plan_deleted "{who} deleted {plan}";
 *   plan_date_changed "{item} moved to {day}" ("{item} left {plan}" when it
 *   left the plan); plan_updated slot_added "{who} added to {plan}",
 *   slot_removed "{who} removed {item} from {plan}", concept_changed "{who}
 *   changed {item}", renamed "{who} renamed {from} to {to}"; plan_review and
 *   plan_comment the Activity wording. Missing names degrade, never blank. Pure.
 */
export function planBellLine(
  entry: Pick<BellEntry, 'eventType'> & { plan?: BellPlanFields | undefined },
  names: PlanBellNames,
  side: ViewerSide,
): string {
  const f = entry.plan;
  const who = names.who ?? 'Someone';
  const plan = names.plan ?? f?.planTitle ?? 'a plan';
  const item = names.item ?? f?.itemTitle ?? null;
  switch (entry.eventType) {
    case 'plan_opened':
      return side === 'client'
        ? `${who} shared ${plan} with you`
        : `${who} opened ${plan} for approvers`;
    case 'plan_deleted':
      return `${who} deleted ${plan}`;
    case 'plan_date_changed': {
      const subject = item ?? 'An item';
      if (f?.leftPlan === true) return `${subject} left ${plan}`;
      const to = f?.to ?? null;
      return `${subject} moved to ${to !== null ? formatCivilDayHeader(to.slice(0, 10)) : 'No date'}`;
    }
    case 'plan_updated':
      switch (f?.kind) {
        case 'slot_added':
          return `${who} added to ${plan}`;
        case 'slot_removed':
          return `${who} removed ${item ?? 'an item'} from ${plan}`;
        case 'concept_changed':
          return `${who} changed ${item ?? 'a concept'}`;
        case 'renamed':
          return `${who} renamed ${f.from ?? 'a plan'} to ${f.to ?? plan}`;
        default:
          return `${who} updated ${plan}`;
      }
    default:
      return (
        planEventLine({
          eventType: entry.eventType,
          actorName: names.who,
          reviewSide: f?.reviewSide ?? null,
          reviewStatus: f?.reviewStatus ?? null,
          reviewWithdrawn: f?.reviewWithdrawn ?? false,
          reviewPrevious: f?.reviewPrevious ?? null,
        }) ?? `${who} updated ${plan}`
      );
  }
}

/** A plan row's plan title: the payload's, else the loaded one. Pure. */
export function planTitleOfEntry(
  entry: Pick<BellEntry, 'plan'>,
  planTitles: ReadonlyMap<string, string> | undefined,
): string | null {
  const f = entry.plan;
  if (f === undefined) return null;
  return f.planTitle ?? (f.planId !== null ? (planTitles?.get(f.planId) ?? null) : null);
}

/** A plan row's item title: the payload's, else the loaded item or its post's. Pure. */
export function itemTitleOfEntry(
  entry: Pick<BellEntry, 'plan'>,
  itemTitles: ReadonlyMap<string, string> | undefined,
): string | null {
  const f = entry.plan;
  if (f === undefined) return null;
  if (f.itemTitle !== null) return f.itemTitle;
  return (
    (f.itemId !== null ? itemTitles?.get(f.itemId) : undefined) ??
    (f.postId !== null ? itemTitles?.get(`post:${f.postId}`) : undefined) ??
    null
  );
}

/** "9+" past nine, else the count. Pure. */
export function bellBadgeText(count: number): string {
  return count > 9 ? '9+' : String(count);
}

/** The first line of a body (mentions as "@Name"), else what the message carries. Pure. */
export function messagePreview(message: BellMessage | undefined, nameOf: NameOf): string {
  if (message === undefined) return 'Message';
  const body = (message.body ?? '').trim();
  if (body !== '') {
    const line = resolveMentionPreview(body, nameOf).replaceAll(ALL_MARK, '');
    const first = line.trim().split('\n')[0]?.trim() ?? '';
    if (first !== '') return first;
  }
  if (message.hasAttachments) return 'Attachment';
  if (message.hasBriefs && !message.hasPosts) return 'Shared brief';
  if (message.hasPosts) return 'Shared post';
  if (message.hasPlans === true) return 'Plan';
  return 'Message';
}

/** A scheduled row's preview (its body, names shown), else what it carries. Pure. */
export function scheduledPreview(row: ScheduledRow | undefined, nameOf: NameOf): string {
  if (row === undefined) return 'Scheduled message';
  return messagePreview(
    {
      id: row.id,
      channelId: row.channel_id,
      senderUserId: row.sender_user_id,
      body: row.body,
      hasAttachments: (row.attachment_asset_ids ?? []).length > 0,
      hasPosts: (row.shared_post_ids ?? []).length > 0,
      hasBriefs: (row.shared_brief_ids ?? []).length > 0,
    },
    nameOf,
  );
}

/** A failed send's reason in plain words (never the raw proc text). Pure. */
export function failureInPlainWords(reason: string | null): string {
  const r = reason ?? '';
  if (/not a member/i.test(r)) return "You're no longer in this chat";
  if (/attachment not available/i.test(r)) return 'An attachment is no longer available';
  if (/exceeds 5000/i.test(r)) return 'The message is too long';
  if (/no body, attachments/i.test(r)) return 'The message was empty';
  if (/reply target/i.test(r)) return 'The message it replied to is gone';
  return 'Something went wrong when sending';
}

/** "<name> mentioned you". Pure. */
export function mentionTitle(name: string | null): string {
  return `${name ?? 'Someone'} mentioned you`;
}

/** "Sent in <chat>". Pure. */
export function sentTitle(chatName: string): string {
  return `Sent in ${chatName}`;
}

/** The time a row shows: "3:05 PM" today, else "Wed 7 Oct". Pure over `now`. */
export function rowTime(iso: string, now: Date): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '';
  const sameDay =
    at.getFullYear() === now.getFullYear() &&
    at.getMonth() === now.getMonth() &&
    at.getDate() === now.getDate();
  const h = at.getHours();
  const clock = `${h % 12 === 0 ? 12 : h % 12}:${String(at.getMinutes()).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
  if (sameDay) return clock;
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const months = [
    'Jan',
    'Feb',
    'Mar',
    'Apr',
    'May',
    'Jun',
    'Jul',
    'Aug',
    'Sep',
    'Oct',
    'Nov',
    'Dec',
  ];
  const base = `${days[at.getDay()]} ${at.getDate()} ${months[at.getMonth()]}`;
  return at.getFullYear() === now.getFullYear() ? base : `${base} ${at.getFullYear()}`;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

const ENTRY_COLS =
  'id, workspace_id, user_id, actor_user_id, event_type, entity_type, entity_id, scope, scope_key, tier, created_at, read_at, snoozed_until, email_sent_at, deleted_at, payload';

function fail<T>(message: string): Result<T> {
  return { ok: false, error: { code: 'unknown', message } };
}

/** The most ids one IN read carries. */
export const IN_CHUNK = 100;

/** Split ids into IN-sized chunks. Pure. */
export function chunked(ids: readonly string[], size: number = IN_CHUNK): string[][] {
  const out: string[][] = [];
  for (let i = 0; i < ids.length; i += size) out.push(ids.slice(i, i + size));
  return out;
}

function unique(values: readonly (string | null)[]): string[] {
  return [...new Set(values.filter((v): v is string => v !== null && v !== ''))];
}

/**
 * One page of the caller's unread bell rows in a workspace, newest first.
 * Pass `before` (the oldest loaded created_at) for the next, older page.
 */
export async function readBellEntries(
  client: Client,
  params: {
    workspaceId: string;
    userId: string;
    before?: string;
    /** Rows to read (default one page); a refetch passes what is already shown. */
    limit?: number;
    signal?: AbortSignal;
  },
): Promise<Result<{ entries: BellEntry[]; hasMore: boolean }>> {
  const limit = Math.min(BELL_MAX_ROWS, Math.max(BELL_PAGE_SIZE, params.limit ?? BELL_PAGE_SIZE));
  try {
    const base = onlyBellEntries(
      client
        .from('inbox_entries')
        .select(ENTRY_COLS)
        .eq('workspace_id', params.workspaceId)
        .eq('user_id', params.userId)
        .is('read_at', null)
        .is('deleted_at', null)
        // Snoozed rows are hidden: never let them fill the page.
        .or(`snoozed_until.is.null,snoozed_until.lte.${new Date().toISOString()}`),
    );
    const paged = params.before !== undefined ? base.lt('created_at', params.before) : base;
    const query = paged.order('created_at', { ascending: false }).limit(limit);
    const { data, error } = await abortable(query, params.signal);
    if (error) return fail(`readBellEntries: ${error.message}`);
    const rows = (data ?? []) as InboxEntryRow[];
    const entries = rows.flatMap((row) => {
      const entry = mapBellEntry(row);
      return entry !== null ? [entry] : [];
    });
    return { ok: true, data: { entries, hasMore: rows.length >= limit } };
  } catch (error) {
    return fail(`readBellEntries: ${String(error)}`);
  }
}

/** The caller's pending scheduled messages in a workspace, soonest first. */
export async function readUpcomingScheduled(
  client: Client,
  params: { workspaceId: string; signal?: AbortSignal },
): Promise<Result<ScheduledRow[]>> {
  try {
    const query = client
      .from('chat_scheduled_messages')
      .select('*')
      .eq('workspace_id', params.workspaceId)
      .eq('status', 'scheduled')
      .order('send_at', { ascending: true });
    const { data, error } = await abortable(query, params.signal);
    if (error) return fail(`readUpcomingScheduled: ${error.message}`);
    return { ok: true, data: soonestFirst((data ?? []) as ScheduledRow[]) };
  } catch (error) {
    return fail(`readUpcomingScheduled: ${String(error)}`);
  }
}

/**
 * The caller's unread 'reminder' rows created after `sinceIso` (the missed
 * count on open), newest first, at most one page.
 */
export async function readUnreadRemindersSince(
  client: Client,
  params: { workspaceId: string; userId: string; sinceIso: string },
): Promise<Result<BellEntry[]>> {
  try {
    const { data, error } = await client
      .from('inbox_entries')
      .select(ENTRY_COLS)
      .eq('workspace_id', params.workspaceId)
      .eq('user_id', params.userId)
      .eq('event_type', 'reminder')
      .is('read_at', null)
      .is('deleted_at', null)
      .gt('created_at', params.sinceIso)
      .order('created_at', { ascending: false })
      .limit(BELL_PAGE_SIZE);
    if (error) return fail(`readUnreadRemindersSince: ${error.message}`);
    return {
      ok: true,
      data: ((data ?? []) as InboxEntryRow[]).flatMap((row) => {
        const entry = mapBellEntry(row);
        return entry !== null ? [entry] : [];
      }),
    };
  } catch (error) {
    return fail(`readUnreadRemindersSince: ${String(error)}`);
  }
}

/** One chat's scheduled and failed rows (the bell's Edit opens them), soonest first. */
export async function readChannelScheduled(
  client: Client,
  params: { channelId: string; signal?: AbortSignal },
): Promise<Result<ScheduledRow[]>> {
  try {
    const query = client
      .from('chat_scheduled_messages')
      .select('*')
      .eq('channel_id', params.channelId)
      .in('status', ['scheduled', 'failed'])
      .order('send_at', { ascending: true });
    const { data, error } = await abortable(query, params.signal);
    if (error) return fail(`readChannelScheduled: ${error.message}`);
    return { ok: true, data: (data ?? []) as ScheduledRow[] };
  } catch (error) {
    return fail(`readChannelScheduled: ${String(error)}`);
  }
}

/** The previewed messages by id, one IN read; empty on failure or no ids. */
export async function readBellMessages(
  client: Client,
  messageIds: readonly string[],
): Promise<Map<string, BellMessage>> {
  const out = new Map<string, BellMessage>();
  if (messageIds.length === 0) return out;
  // IN lists of at most IN_CHUNK ids keep each request URL short; the chunks
  // run in parallel (a fixed number of reads per load, never one per row).
  const results = await Promise.all(
    chunked(messageIds).map((ids) =>
      client
        .from('chat_messages')
        .select(
          'id, channel_id, sender_user_id, body, attachment_asset_ids, shared_post_ids, shared_brief_ids, shared_plan_ids',
        )
        .in('id', ids)
        .is('deleted_at', null),
    ),
  );
  for (const res of results) {
    if (res.error !== null) continue;
    for (const r of res.data ?? []) {
      out.set(r.id, {
        id: r.id,
        channelId: r.channel_id,
        senderUserId: r.sender_user_id,
        body: r.body,
        hasAttachments: (r.attachment_asset_ids ?? []).length > 0,
        hasPosts: (r.shared_post_ids ?? []).length > 0,
        hasBriefs: (r.shared_brief_ids ?? []).length > 0,
        hasPlans: (r.shared_plan_ids ?? []).length > 0,
      });
    }
  }
  return out;
}

/**
 * Load the bell for one workspace: the Now page, the pending reminders and the
 * pending scheduled messages in parallel (any of the three failing fails the
 * load), then one IN read each for the messages and the failed scheduled rows,
 * then one batched profile read for every name shown. Never throws.
 */
export async function loadBell(
  client: Client,
  params: { workspaceId: string; userId: string; before?: string; limit?: number },
): Promise<Result<BellData>> {
  const [entriesRes, remindersRes, scheduledRes] = await Promise.all([
    readBellEntries(client, {
      workspaceId: params.workspaceId,
      userId: params.userId,
      ...(params.before !== undefined ? { before: params.before } : {}),
      ...(params.limit !== undefined ? { limit: params.limit } : {}),
    }),
    client
      .from('chat_message_reminders')
      .select('*')
      .eq('workspace_id', params.workspaceId)
      .is('fired_at', null)
      .is('cancelled_at', null)
      .order('remind_at', { ascending: true })
      .then(
        (r): Result<ReminderRow[]> =>
          r.error !== null
            ? fail(`reminders: ${r.error.message}`)
            : { ok: true, data: pendingSoonestFirst((r.data ?? []) as ReminderRow[]) },
        (e: unknown): Result<ReminderRow[]> => fail(`reminders: ${String(e)}`),
      ),
    readUpcomingScheduled(client, { workspaceId: params.workspaceId }),
  ]);
  if (!entriesRes.ok) return entriesRes;
  if (!remindersRes.ok) return remindersRes;
  if (!scheduledRes.ok) return scheduledRes;
  const entries = entriesRes.data.entries;

  const messageIds = unique([
    ...entries.map((e) =>
      e.eventType === 'scheduled_failed' || isBellTaskEvent(e.eventType) ? null : e.messageId,
    ),
    ...remindersRes.data.map((r) => r.message_id),
  ]);
  const failedIds = unique(
    entries.map((e) => (e.eventType === 'scheduled_failed' ? e.scheduledId : null)),
  );
  const [messages, failedResults] = await Promise.all([
    readBellMessages(client, messageIds),
    Promise.all(
      chunked(failedIds).map((ids) =>
        client.from('chat_scheduled_messages').select('*').in('id', ids),
      ),
    ),
  ]);
  const failed = new Map<string, ScheduledRow>();
  let failedReadOk = true;
  for (const res of failedResults) {
    if (res.error !== null) {
      failedReadOk = false;
      continue;
    }
    for (const r of (res.data ?? []) as ScheduledRow[]) failed.set(r.id, r);
  }

  const bodies = [
    ...[...messages.values()].map((m) => m.body ?? ''),
    ...scheduledRes.data.map((r) => r.body ?? ''),
    ...[...failed.values()].map((r) => r.body ?? ''),
  ];
  const nameIds = unique([
    ...entries.map((e) => e.actorId),
    ...[...messages.values()].map((m) => m.senderUserId),
    ...bodies.flatMap((b) => mentionIds(b)),
  ]);
  const names = new Map<string, string>();
  const [profiles, planTitles] = await Promise.all([
    nameIds.length > 0 ? readProfiles(client, nameIds) : Promise.resolve(null),
    readPlanRowTitles(client, entries),
  ]);
  if (profiles !== null && profiles.ok) {
    for (const p of profiles.data) names.set(p.userId, p.displayName);
  }

  return {
    ok: true,
    data: {
      entries,
      hasMore: entriesRes.data.hasMore,
      reminders: remindersRes.data,
      scheduled: scheduledRes.data,
      failed,
      failedReadOk,
      messages,
      names,
      planTitles: planTitles.plans,
      itemTitles: planTitles.items,
    },
  };
}

/**
 * The plan rows' titles, batched: one plans IN read for the plans whose
 * payload carries no plan_title, one plan_items IN read for the items a line
 * names (date changes, removals without a title, concept changes), then one
 * posts IN read for the post slots' titles (keyed `post:{id}`). Best-effort:
 * a failed read leaves its titles out. Never throws.
 */
export async function readPlanRowTitles(
  client: Client,
  entries: readonly BellEntry[],
): Promise<{ plans: Map<string, string>; items: Map<string, string> }> {
  const plans = new Map<string, string>();
  const items = new Map<string, string>();
  const rows = entries.flatMap((e) => (e.plan !== undefined ? [e.plan] : []));
  if (rows.length === 0) return { plans, items };
  const planIds = unique(rows.map((f) => (f.planTitle === null ? f.planId : null)));
  const wantsItem = (f: BellPlanFields): boolean => f.itemTitle === null;
  const itemIds = unique(rows.map((f) => (wantsItem(f) ? f.itemId : null)));
  const inChunks = async <T>(
    table: 'plans' | 'plan_items' | 'posts',
    columns: string,
    ids: string[],
  ): Promise<T[]> => {
    if (ids.length === 0) return [];
    const results = await Promise.all(
      chunked(ids).map((chunk) =>
        (
          client.from(table) as unknown as {
            select: (c: string) => {
              in: (col: string, v: string[]) => PromiseLike<{ data: unknown; error: unknown }>;
            };
          }
        )
          .select(columns)
          .in('id', chunk),
      ),
    );
    return results.flatMap((r) => (r.error === null ? ((r.data ?? []) as T[]) : []));
  };
  try {
    const [planRows, itemRows] = await Promise.all([
      inChunks<{ id: string; title: string }>('plans', 'id, title', planIds),
      inChunks<{ id: string; title: string | null; post_id: string | null }>(
        'plan_items',
        'id, title, post_id',
        itemIds,
      ),
    ]);
    for (const r of planRows) plans.set(r.id, r.title);
    const postOfItem = new Map<string, string>();
    for (const r of itemRows) {
      if (r.title !== null && r.title !== '') items.set(r.id, r.title);
      else if (r.post_id !== null) postOfItem.set(r.id, r.post_id);
    }
    const postIds = unique([
      ...postOfItem.values(),
      ...rows.map((f) => (wantsItem(f) ? f.postId : null)),
    ]);
    const postRows = await inChunks<{ id: string; title: string | null }>(
      'posts',
      'id, title',
      postIds,
    );
    const postTitle = new Map(postRows.flatMap((r) => (r.title ? [[r.id, r.title] as const] : [])));
    for (const [itemId, postId] of postOfItem) {
      const title = postTitle.get(postId);
      if (title !== undefined) items.set(itemId, title);
    }
    for (const [postId, title] of postTitle) items.set(`post:${postId}`, title);
  } catch {
    // Best-effort: the lines read without the missing titles.
  }
  return { plans, items };
}

/** Append an older page to loaded data (ids already held are kept once). Pure. */
export function mergeOlder(current: BellData, older: BellData): BellData {
  const seen = new Set(current.entries.map((e) => e.id));
  return {
    ...current,
    entries: [...current.entries, ...older.entries.filter((e) => !seen.has(e.id))],
    hasMore: older.hasMore,
    failed: new Map([...current.failed, ...older.failed]),
    failedReadOk: current.failedReadOk && older.failedReadOk,
    messages: new Map([...current.messages, ...older.messages]),
    names: new Map([...current.names, ...older.names]),
    planTitles: new Map([...(current.planTitles ?? []), ...(older.planTitles ?? [])]),
    itemTitles: new Map([...(current.itemTitles ?? []), ...(older.itemTitles ?? [])]),
  };
}

// ---------------------------------------------------------------------------
// Writes (each carries an explicit p_trace_id)
// ---------------------------------------------------------------------------

/** inbox_snooze kinds the bell offers, in menu order. */
export type BellSnoozeKind = InboxSnoozeKind;

/** The shared snooze labels (Activity shows the same set). */
export const BELL_SNOOZE_OPTIONS = INBOX_SNOOZE_OPTIONS;

/** Mark one bell row read via inbox_mark_read. */
export function markBellRead(
  client: Client,
  entry: Pick<BellEntry, 'id' | 'workspaceId' | 'createdAt'>,
  traceId: string,
): Promise<Result<undefined>> {
  return inboxMarkRead(client, {
    p_entry_id: entry.id,
    p_workspace_id: entry.workspaceId,
    p_created_at: entry.createdAt,
    p_trace_id: traceId,
  });
}

/** Snooze one reminder row via inbox_snooze. */
export function snoozeBellEntry(
  client: Client,
  entry: Pick<BellEntry, 'id' | 'workspaceId' | 'createdAt'>,
  kind: BellSnoozeKind,
  traceId: string,
): Promise<Result<undefined>> {
  return inboxSnooze(client, {
    p_entry_id: entry.id,
    p_workspace_id: entry.workspaceId,
    p_created_at: entry.createdAt,
    p_kind: kind,
    p_trace_id: traceId,
  });
}

/** Mark every unread bell row of these types read via inbox_mark_read_events ("Clear sent"). */
export async function markBellEventsRead(
  client: Client,
  params: { workspaceId: string; eventTypes: readonly BellOnlyEventType[]; traceId: string },
): Promise<Result<undefined>> {
  const args: Functions['inbox_mark_read_events']['Args'] = {
    p_workspace_id: params.workspaceId,
    p_event_types: [...params.eventTypes],
    p_trace_id: params.traceId,
  };
  try {
    const { error } = await client.rpc('inbox_mark_read_events', args);
    if (error) return fail(error.message);
    return { ok: true, data: undefined };
  } catch (error) {
    return fail(String(error));
  }
}
