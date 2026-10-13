// The chat bell's inbox entries, in one place (decision 89, 3 Oct 2026: Activity
// is posts only; chat notifications live in the chat bell). docs/schema.md
// "Where inbox entries are shown":
//   - Chat bell only, never Activity: mention with entity_type chat_channel,
//     reminder, scheduled_sent, scheduled_failed, the plan alerts
//     (plan_opened, plan_deleted, plan_date_changed, plan_updated, plan_review,
//     plan_comment) and the task alerts (task_changed, task_due).
//   - Activity: everything else, including mentions on posts and briefs.
// Every reader that splits the inbox between the two surfaces uses this file:
// the Activity feed, its unread badge and Mentions count, the live toast layer
// and the bell itself. Pure; the query helpers only add PostgREST filters.

import type { InboxEventTypeValue } from '@srtdio/schemas';

/** The entity_type of a chat row (entity_id is the channel id). */
export const BELL_CHAT_ENTITY = 'chat_channel';

/** The mention event_type: a bell row only when its entity is a chat. */
export const BELL_MENTION_EVENT: InboxEventTypeValue = 'mention';

/** The plan alerts: bell rows (entity plan, or plan_item for reviews and comments). */
export const BELL_PLAN_EVENT_TYPES = [
  'plan_opened',
  'plan_deleted',
  'plan_date_changed',
  'plan_updated',
  'plan_review',
  'plan_comment',
] as const satisfies readonly InboxEventTypeValue[];

export type BellPlanEventType = (typeof BELL_PLAN_EVENT_TYPES)[number];

/** The chat task list's alerts: a change by someone else, and a missed due time. */
export const BELL_TASK_EVENT_TYPES = [
  'task_changed',
  'task_due',
] as const satisfies readonly InboxEventTypeValue[];

export type BellTaskEventType = (typeof BELL_TASK_EVENT_TYPES)[number];

const BELL_TASK = new Set<string>(BELL_TASK_EVENT_TYPES);

/** Whether an event type is a task alert (a bell row). Pure. */
export function isBellTaskEvent(eventType: string): eventType is BellTaskEventType {
  return BELL_TASK.has(eventType);
}

/** Event types that are always bell rows, whatever their entity. */
export const BELL_ONLY_EVENT_TYPES = [
  'reminder',
  'scheduled_sent',
  'scheduled_failed',
  ...BELL_PLAN_EVENT_TYPES,
  ...BELL_TASK_EVENT_TYPES,
] as const satisfies readonly InboxEventTypeValue[];

const BELL_PLAN = new Set<string>(BELL_PLAN_EVENT_TYPES);

/** Whether an event type is a plan alert (a bell row). Pure. */
export function isBellPlanEvent(eventType: string): eventType is BellPlanEventType {
  return BELL_PLAN.has(eventType);
}

/**
 * The link a plan alert opens: /plans/{plan_id}, with ?item={item_id} when the
 * row names an item. Pure.
 */
export function planHref(planId: string, itemId: string | null): string {
  const base = `/plans/${encodeURIComponent(planId)}`;
  return itemId !== null && itemId !== '' ? `${base}?item=${encodeURIComponent(itemId)}` : base;
}

export type BellOnlyEventType = (typeof BELL_ONLY_EVENT_TYPES)[number];

/** Every event_type the bell shows (mention only on a chat). */
export type BellEventType = BellOnlyEventType | 'mention';

const BELL_ONLY = new Set<string>(BELL_ONLY_EVENT_TYPES);

/** Whether an inbox row belongs to the chat bell (and never to Activity). Pure. */
export function isBellEntry(row: { eventType: string; entityType: string | null }): boolean {
  if (BELL_ONLY.has(row.eventType)) return true;
  return row.eventType === BELL_MENTION_EVENT && row.entityType === BELL_CHAT_ENTITY;
}

/** isBellEntry over a raw inbox_entries row (snake_case columns). Pure. */
export function isBellRow(row: { event_type: string; entity_type: string | null }): boolean {
  return isBellEntry({ eventType: row.event_type, entityType: row.entity_type });
}

const BELL_ONLY_LIST = `(${BELL_ONLY_EVENT_TYPES.join(',')})`;

/**
 * The PostgREST `or` that keeps every non-mention row and every mention that is
 * not on a chat. entity_type is nullable and `neq` never matches null, so null
 * is listed on its own.
 */
export const NOT_CHAT_MENTION_OR = `event_type.neq.${BELL_MENTION_EVENT},entity_type.is.null,entity_type.neq.${BELL_CHAT_ENTITY}`;

/** The PostgREST `or` that keeps exactly the bell rows. */
export const ONLY_BELL_OR = `event_type.in.${BELL_ONLY_LIST},and(event_type.eq.${BELL_MENTION_EVENT},entity_type.eq.${BELL_CHAT_ENTITY})`;

/** The two filter methods the helpers below add (a PostgREST filter builder). */
export interface BellFilterable<Q> {
  not(column: 'event_type', operator: 'in', value: string): Q;
  or(filters: string): Q;
}

/** Narrow an inbox_entries query to rows Activity shows (no bell rows). */
export function withoutBellEntries<Q extends BellFilterable<Q>>(query: Q): Q {
  return query.not('event_type', 'in', BELL_ONLY_LIST).or(NOT_CHAT_MENTION_OR);
}

/** Narrow an inbox_entries query to the bell's rows only. */
export function onlyBellEntries<Q extends Pick<BellFilterable<Q>, 'or'>>(query: Q): Q {
  return query.or(ONLY_BELL_OR);
}

/**
 * The chat deep link that opens a chat at one message: the same link the
 * Activity chat-mention rows have always opened (ChatConnected consumes
 * `channel` and `message`). Without a message id it opens the chat; a task link token
 * (taskLinkToken) opens its task sheet on that item instead. Pure.
 */
export function chatMessageHref(channelId: string, messageId: string | null): string {
  if (messageId !== null && messageId.startsWith(TASK_LINK_PREFIX)) {
    return chatTaskHref(channelId, messageId.slice(TASK_LINK_PREFIX.length));
  }
  const channel = `/chat?channel=${encodeURIComponent(channelId)}`;
  return messageId !== null && messageId !== ''
    ? `${channel}&message=${encodeURIComponent(messageId)}`
    : channel;
}

/**
 * The chat deep link that opens a chat with its task sheet up and one item
 * expanded (ChatConnected consumes `channel` and `task`). Pure.
 */
export function chatTaskHref(channelId: string, taskId: string): string {
  return `/chat?channel=${encodeURIComponent(channelId)}&task=${encodeURIComponent(taskId)}`;
}

/**
 * A bell task row opens through the bell's message link: its "message id" is
 * this prefix plus the task id, which chatMessageHref turns into `&task=`.
 */
export const TASK_LINK_PREFIX = 'task:';

/** The link token a task row hands the bell's open path. Pure. */
export function taskLinkToken(taskId: string): string {
  return `${TASK_LINK_PREFIX}${taskId}`;
}

/** The link that opens the chat home with the bell open (the missed-reminders toast). */
export const BELL_OPEN_HREF = '/chat?bell=1';

/** The search param BELL_OPEN_HREF carries. */
export const BELL_OPEN_PARAM = 'bell';
