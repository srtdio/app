// The Notifications page's chat, plan and task alerts: the rows the chat bell
// used to show beside Activity's (bell-types.ts names them). Reminders,
// scheduled sends (sent and failed), the plan alerts that name a plan
// (plan_opened, plan_deleted, plan_date_changed, plan_updated) and the task
// alerts (task_changed, task_due) map here into the fields their Notifications
// card reads; chat mentions, plan_review and plan_comment keep the Activity
// row they always had.
//
// Pure: the payload mappers and the wording (the bell's lines, unchanged).
// Reads: the chat messages a row previews and the scheduled rows behind failed
// sends, each one IN read per chunk of ids (never one per row). Each read is
// best-effort: a failure leaves its field empty and the row still renders.

import type { Client } from '@srtdio/rpc';
import type { Database, InboxEventTypeValue, Json } from '@srtdio/schemas';
import { ALL_MARK, resolveMentionPreview, type NameOf } from '@/lib/chat/mentions';
import type { ScheduledRow } from '@/lib/chat/scheduled';
import {
  addedLabel,
  editedTasksLabel,
  eventText,
  taskNumberLabel,
  type TaskEventKind,
} from '@/lib/chat/tasks';
import type { ViewerSide } from '@/lib/chat/viewer-role';
import { isBellTaskEvent } from '@/lib/inbox/bell-types';
import { formatCivilDayHeader } from '@/lib/plan-week';

type InboxEntryRow = Database['public']['Tables']['inbox_entries']['Row'];

// ---------------------------------------------------------------------------
// Kinds
// ---------------------------------------------------------------------------

/** The plan alerts that name a plan (entity 'plan'); plan_review / plan_comment are plan-item rows. */
export const PLAN_ALERT_EVENT_TYPES = [
  'plan_opened',
  'plan_deleted',
  'plan_date_changed',
  'plan_updated',
] as const satisfies readonly InboxEventTypeValue[];

const PLAN_ALERT = new Set<string>(PLAN_ALERT_EVENT_TYPES);

/** What an alert row is: the card's icon, its top line and its tap follow from it. */
export type AlertKind = 'reminder' | 'sent' | 'failed' | 'plan' | 'task';

/** The alert kind of an event type; null for every other row. Pure. */
export function alertKindOf(eventType: string): AlertKind | null {
  if (eventType === 'reminder') return 'reminder';
  if (eventType === 'scheduled_sent') return 'sent';
  if (eventType === 'scheduled_failed') return 'failed';
  if (PLAN_ALERT.has(eventType)) return 'plan';
  if (isBellTaskEvent(eventType)) return 'task';
  return null;
}

// ---------------------------------------------------------------------------
// Payloads
// ---------------------------------------------------------------------------

function str(payload: unknown, key: string): string | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const value = (payload as Record<string, unknown>)[key];
  return typeof value === 'string' && value !== '' ? value : null;
}

function flag(payload: unknown, key: string): boolean {
  return (
    typeof payload === 'object' &&
    payload !== null &&
    (payload as Record<string, unknown>)[key] === true
  );
}

/** A plan alert's payload, mapped (plan_opened .. plan_updated). */
export interface PlanAlertFields {
  planId: string | null;
  /** The item the row names (payload.item_id). */
  itemId: string | null;
  /** payload.plan_title; null on older rows (the loaded title then). */
  planTitle: string | null;
  /**
   * plan_updated: edited (one merged card per editor per plan per hour, from
   * 20261026160000); older rows slot_added / slot_removed / concept_changed / renamed.
   */
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
}

/** A plan alert's fields from its entity and payload. Pure. */
export function planFieldsOf(
  row: Pick<InboxEntryRow, 'entity_type' | 'entity_id' | 'payload'>,
): PlanAlertFields {
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
  };
}

/** A task alert's payload (task_changed; task_due on older rows), mapped. */
export interface TaskAlertFields {
  taskId: string | null;
  number: number | null;
  title: string | null;
  /** The change kind: 'batch' for one Save (chat_task_save_batch); older rows: created_many, edited, .... */
  kind: string | null;
  old: string | null;
  new: string | null;
  /** created_many only: how many tasks the one Save added (absent on other rows). */
  count?: number;
  /** batch only: the Save's batch id, how many it added and changed. */
  batchId?: string;
  created?: number;
  changed?: number;
}

/** A task alert's fields from its payload. Pure. */
export function taskFieldsOf(row: Pick<InboxEntryRow, 'payload'>): TaskAlertFields {
  const payload: unknown = row.payload as Json;
  const field = (key: string): unknown =>
    typeof payload === 'object' && payload !== null
      ? (payload as Record<string, unknown>)[key]
      : undefined;
  const number = field('number');
  const count = field('count');
  const created = field('created');
  const changed = field('changed');
  const batchId = str(payload, 'batch_id');
  return {
    taskId: str(payload, 'task_id'),
    number: typeof number === 'number' && Number.isFinite(number) ? number : null,
    title: str(payload, 'title'),
    kind: str(payload, 'kind'),
    old: str(payload, 'old'),
    new: str(payload, 'new'),
    ...(typeof count === 'number' && Number.isFinite(count) ? { count } : {}),
    ...(batchId !== null ? { batchId } : {}),
    ...(typeof created === 'number' && Number.isFinite(created) ? { created } : {}),
    ...(typeof changed === 'number' && Number.isFinite(changed) ? { changed } : {}),
  };
}

// ---------------------------------------------------------------------------
// Wording
// ---------------------------------------------------------------------------

/** The toast when a plan_deleted row is tapped (it opens nothing). */
export const PLAN_DELETED_TOAST = 'This plan was deleted';

/** What a plan alert's line names, resolved by the caller (actor, plan and item). */
interface PlanAlertNames {
  who: string | null;
  plan: string | null;
  item: string | null;
}

/**
 * A plan alert's line ({who} the actor, {plan} payload.plan_title or the loaded
 * title, {item} the item's title):
 *   plan_opened: client "{who} shared {plan} with you", agency "{who} opened
 *   {plan} for approvers"; plan_deleted "{who} deleted {plan}";
 *   plan_date_changed "{item} moved to {day}" ("{item} left {plan}" when it
 *   left the plan); plan_updated edited "{who} updated {plan}" (the merged
 *   card); older rows slot_added "{who} added to {plan}",
 *   slot_removed "{who} removed {item} from {plan}", concept_changed "{who}
 *   changed {item}", renamed "{who} renamed {from} to {to}". Missing names
 *   degrade, never blank. Pure.
 */
export function planAlertLine(
  eventType: string,
  f: PlanAlertFields | undefined,
  names: PlanAlertNames,
  side: ViewerSide,
): string {
  const who = names.who ?? 'Someone';
  const plan = names.plan ?? f?.planTitle ?? 'a plan';
  const item = names.item ?? f?.itemTitle ?? null;
  switch (eventType) {
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
        case 'edited':
          return `${who} updated ${plan}`;
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
      return `${who} updated ${plan}`;
  }
}

/** A task alert's label: the card's top line when no actor resolved. */
export const TASK_ALERT_LABEL = 'Tasks';

const TASK_KINDS = new Set<string>([
  'created',
  'status',
  'priority',
  'title',
  'note',
  'edited',
  'deleted',
]);

/**
 * A one-Save alert (payload kind 'batch', or an older batch add
 * 'created_many'): it opens the sheet, not one row. Pure.
 */
export function isTaskBatch(eventType: string, task: TaskAlertFields | undefined): boolean {
  return eventType === 'task_changed' && (task?.kind === 'batch' || task?.kind === 'created_many');
}

/**
 * A task alert's line: a Save "<Name> edited tasks"; an older batch add
 * "<Name> added N tasks"; an older single change "<Name> · <change>"; an
 * older missed due time, numbered title. Pure.
 */
export function taskAlertLine(
  eventType: string,
  f: TaskAlertFields | undefined,
  actor: string | null,
): string {
  const who = actor ?? 'Someone';
  if (eventType === 'task_changed' && f?.kind === 'batch') return editedTasksLabel(who);
  if (isTaskBatch(eventType, f)) return addedLabel(who, f?.count ?? 1);
  const ref = { number: f?.number ?? null, title: f?.title ?? 'Item', priority: null };
  if (eventType === 'task_due') return `${taskNumberLabel(ref.number)} ${ref.title}`;
  const kind: TaskEventKind =
    f?.kind != null && TASK_KINDS.has(f.kind) ? (f.kind as TaskEventKind) : 'note';
  return `${who} · ${eventText({ kind, oldValue: f?.old ?? null, newValue: f?.new ?? null }, ref)}`;
}

/** A reminder row's top line when its message's sender did not resolve. */
export const REMINDER_LABEL = 'Reminder';

/** A scheduled send's top line (sent or failed). */
export const SCHEDULED_LABEL = 'Scheduled';

/** A failed send's line, before its reason. */
export const NOT_SENT_LABEL = 'Not sent';

/** A plan alert's top line when no actor resolved. */
export const PLAN_LABEL = 'Plan';

/** A chat row's chat when its name did not resolve (a direct chat, or a failed read). */
export const CHAT_LABEL = 'Chat';

/** "Sent in <chat>". Pure. */
export function sentTitle(chatName: string): string {
  return `Sent in ${chatName}`;
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

/** A previewed chat message. */
export interface ChatMessagePreview {
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

/** A message preview when the message did not load (deleted, or a failed read). */
export const MESSAGE_LABEL = 'Message';

/** The first line of a body (mentions as "@Name"), else what the message carries. Pure. */
export function messagePreview(message: ChatMessagePreview | undefined, nameOf: NameOf): string {
  if (message === undefined) return MESSAGE_LABEL;
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
  return MESSAGE_LABEL;
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

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/** The most ids one IN read carries. */
const IN_CHUNK = 100;

/** Split ids into IN-sized chunks. Pure. */
export function chunked(ids: readonly string[], size: number = IN_CHUNK): string[][] {
  const out: string[][] = [];
  for (let i = 0; i < ids.length; i += size) out.push(ids.slice(i, i + size));
  return out;
}

/** The previewed messages by id, one IN read per chunk; empty on failure or no ids. */
export async function readChatMessages(
  client: Client,
  messageIds: readonly string[],
): Promise<Map<string, ChatMessagePreview>> {
  const out = new Map<string, ChatMessagePreview>();
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

/** The scheduled rows behind failed sends, by id. */
export interface ScheduledRead {
  rows: Map<string, ScheduledRow>;
  /**
   * Every chunk read succeeded: a row missing from `rows` (or no longer
   * 'failed') was really sent, cancelled or edited elsewhere.
   */
  ok: boolean;
}

/** The scheduled rows by id, one IN read per chunk (RLS: own rows only). Never throws. */
export async function readScheduledRows(
  client: Client,
  ids: readonly string[],
): Promise<ScheduledRead> {
  const rows = new Map<string, ScheduledRow>();
  if (ids.length === 0) return { rows, ok: true };
  const results = await Promise.all(
    chunked(ids).map((chunk) => client.from('chat_scheduled_messages').select('*').in('id', chunk)),
  );
  let ok = true;
  for (const res of results) {
    if (res.error !== null) {
      ok = false;
      continue;
    }
    for (const r of (res.data ?? []) as ScheduledRow[]) rows.set(r.id, r);
  }
  return { rows, ok };
}

/**
 * Whether a failed send's row was resolved elsewhere (sent, cancelled or
 * edited): only when the read succeeded and the row is gone or no longer
 * 'failed'. A failed read is never stale. Pure.
 */
export function isStaleFailed(read: ScheduledRead, scheduledId: string | null): boolean {
  if (scheduledId === null || !read.ok) return false;
  return read.rows.get(scheduledId)?.status !== 'failed';
}
