// The rows the chat bell used to own, in one place. The bell is gone: the
// Notifications page shows every inbox row (decision 89's split, 3 Oct 2026,
// ended with the merge). docs/schema.md "Where inbox entries are shown" lists
// them:
//   - mention with entity_type chat_channel, reminder, scheduled_sent,
//     scheduled_failed, the plan alerts (plan_opened, plan_deleted,
//     plan_date_changed, plan_updated, plan_review, plan_comment) and the task
//     alerts (task_changed, task_due).
// The live layer still toasts them apart: a new chat mention gets its own
// "<name> mentioned you" toast, reminders ring (ReminderRing), and the rest
// never toast. Also here: the chat, task and plan deep links every surface
// opens, and the shared snooze labels. Pure; the query helper only adds
// PostgREST filters.

import type { InboxEventTypeValue } from '@srtdio/schemas';

/** The entity_type of a chat row (entity_id is the channel id). */
export const BELL_CHAT_ENTITY = 'chat_channel';

/** The mention event_type: a chat mention when its entity is a chat. */
export const BELL_MENTION_EVENT: InboxEventTypeValue = 'mention';

/** The plan alerts (entity plan, or plan_item for reviews and comments): the Plans chip. */
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

/** Whether an event type is a task alert. Pure. */
export function isBellTaskEvent(eventType: string): eventType is BellTaskEventType {
  return BELL_TASK.has(eventType);
}

/** Event types that were always bell rows, whatever their entity. */
export const BELL_ONLY_EVENT_TYPES = [
  'reminder',
  'scheduled_sent',
  'scheduled_failed',
  ...BELL_PLAN_EVENT_TYPES,
  ...BELL_TASK_EVENT_TYPES,
] as const satisfies readonly InboxEventTypeValue[];

const BELL_PLAN = new Set<string>(BELL_PLAN_EVENT_TYPES);

/** Whether an event type is a plan alert. Pure. */
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

const BELL_ONLY = new Set<string>(BELL_ONLY_EVENT_TYPES);

/** Whether an inbox row is one the chat bell used to own (toasted apart). Pure. */
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

/** The two filter methods the helper below adds (a PostgREST filter builder). */
export interface BellFilterable<Q> {
  not(column: 'event_type', operator: 'in', value: string): Q;
  or(filters: string): Q;
}

/** Narrow an inbox_entries query to the rows the live layer toasts as activity. */
export function withoutBellEntries<Q extends BellFilterable<Q>>(query: Q): Q {
  return query.not('event_type', 'in', BELL_ONLY_LIST).or(NOT_CHAT_MENTION_OR);
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
 * A task alert opens through the chat's message link: its "message id" is
 * this prefix plus the task id, which chatMessageHref turns into `&task=`.
 */
export const TASK_LINK_PREFIX = 'task:';

/** The link token a task alert hands the message link. Pure. */
export function taskLinkToken(taskId: string): string {
  return `${TASK_LINK_PREFIX}${taskId}`;
}

/** inbox_snooze kinds offered in the Notifications row menu, in menu order. */
type InboxSnoozeKind = '1h' | '4h' | 'tomorrow_9' | 'next_week';

/** The one set of snooze labels the Notifications row menu shows. */
export const INBOX_SNOOZE_OPTIONS: readonly { kind: InboxSnoozeKind; label: string }[] = [
  { kind: '1h', label: '1 hour' },
  { kind: '4h', label: '4 hours' },
  { kind: 'tomorrow_9', label: 'Tomorrow 9 AM' },
  { kind: 'next_week', label: 'Next week' },
];
