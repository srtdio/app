// The rows the chat bell used to own, in one place. The bell is gone: the
// Notifications page shows every inbox row (decision 89's split, 3 Oct 2026,
// ended with the merge). docs/schema.md "Where inbox entries are shown" lists
// them:
//   - mention with entity_type chat_channel, the plan alerts (plan_opened,
//     plan_deleted, plan_date_changed, plan_updated, plan_review,
//     plan_comment) and the task alerts (task_changed, task_due).
// The retired types (RETIRED_EVENT_TYPES: reminder, scheduled_sent,
// scheduled_failed) stay bell rows so they never toast, and the page never
// lists them.
// The live layer still toasts them apart: a new chat mention gets its own
// "<name> mentioned you" toast, plan comments
// and plan reviews toast as activity (LIVE_PLAN_EVENT_TYPES; rule of 2 Nov
// 2026: a comment or an OK / Not OK alerts everyone who can see the plan), and
// the rest never toast (plan edits never pop up). Also here: the chat, task and plan deep links every surface
// opens. Pure; the query helper only adds
// PostgREST filters.

import type { InboxEventTypeValue } from '@srtdio/schemas';

/** The entity_type of a chat row (entity_id is the channel id). */
export const BELL_CHAT_ENTITY = 'chat_channel';

/** The mention event_type: a chat mention when its entity is a chat. */
export const BELL_MENTION_EVENT: InboxEventTypeValue = 'mention';

/**
 * The plan alerts (entity plan, or plan_item for reviews, comments and the
 * idea bank events): the Plans chip. The five bank_idea_* rows are plan_item
 * rows (scope_key 'bank' while the idea sits in the bank).
 */
export const BELL_PLAN_EVENT_TYPES = [
  'plan_opened',
  'plan_deleted',
  'plan_date_changed',
  'plan_updated',
  'plan_review',
  'plan_comment',
  'bank_idea_added',
  'bank_idea_moved',
  'bank_idea_planned',
  'bank_idea_shown',
  'bank_idea_hidden',
] as const satisfies readonly InboxEventTypeValue[];

type BellPlanEventType = (typeof BELL_PLAN_EVENT_TYPES)[number];

/** The chat task list's alerts: a change by someone else, and a missed due time. */
export const BELL_TASK_EVENT_TYPES = [
  'task_changed',
  'task_due',
] as const satisfies readonly InboxEventTypeValue[];

type BellTaskEventType = (typeof BELL_TASK_EVENT_TYPES)[number];

const BELL_TASK = new Set<string>(BELL_TASK_EVENT_TYPES);

/** Whether an event type is a task alert. Pure. */
export function isBellTaskEvent(eventType: string): eventType is BellTaskEventType {
  return BELL_TASK.has(eventType);
}

/**
 * Event types the app no longer shows (the feature is retired; the DB may
 * still write rows for ones set before): never listed, counted on the page
 * or toasted.
 */
export const RETIRED_EVENT_TYPES = [
  'reminder',
  'scheduled_sent',
  'scheduled_failed',
] as const satisfies readonly InboxEventTypeValue[];

/** The PostgREST `in` list of the retired event types. */
export const RETIRED_EVENT_LIST = `(${RETIRED_EVENT_TYPES.join(',')})`;

/** Event types that were always bell rows, whatever their entity. */
export const BELL_ONLY_EVENT_TYPES = [
  ...RETIRED_EVENT_TYPES,
  ...BELL_PLAN_EVENT_TYPES,
  ...BELL_TASK_EVENT_TYPES,
] as const satisfies readonly InboxEventTypeValue[];

const BELL_PLAN = new Set<string>(BELL_PLAN_EVENT_TYPES);

/**
 * The plan alerts that toast, tone and blink like a post comment: a comment, an
 * OK / Not OK on a plan item, and every idea bank event (tier active; none
 * combine). They stay in the Plans chip. Plan edits
 * (plan_updated, plan_opened, plan_deleted, plan_date_changed) stay silent.
 */
export const LIVE_PLAN_EVENT_TYPES = [
  'plan_comment',
  'plan_review',
  'bank_idea_added',
  'bank_idea_moved',
  'bank_idea_planned',
  'bank_idea_shown',
  'bank_idea_hidden',
] as const satisfies readonly BellPlanEventType[];

const LIVE_PLAN = new Set<string>(LIVE_PLAN_EVENT_TYPES);

/** Bell rows that get no activity toast: every bell-only type but the live plan ones. */
const SILENT_EVENT_TYPES: readonly string[] = BELL_ONLY_EVENT_TYPES.filter(
  (t) => !LIVE_PLAN.has(t),
);

/** Whether an event type is a plan alert. Pure. */
export function isBellPlanEvent(eventType: string): eventType is BellPlanEventType {
  return BELL_PLAN.has(eventType);
}

/**
 * The link a plan opens: /plan/{plan_id} (the Plan tab), with ?item={item_id} when the
 * row names an item. Pure.
 */
export function planHref(planId: string, itemId: string | null): string {
  // The Plan tab's own route: a plan opens in the Plan tab (tab lit, Back to
  // the calendar on a cold open). /plans/:id stays only for older links.
  const base = `/plan/${encodeURIComponent(planId)}`;
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

/**
 * Whether a raw row toasts as activity (toast, tone, tab blink): every row but
 * the bell rows, plus plan comments and plan reviews. A plan mention (mention
 * on a plan_item) is not a bell row, so it toasts too; a chat mention keeps its
 * own toast. Pure.
 */
export function isLiveActivityRow(row: {
  event_type: string;
  entity_type: string | null;
}): boolean {
  return LIVE_PLAN.has(row.event_type) || !isBellRow(row);
}

const SILENT_LIST = `(${SILENT_EVENT_TYPES.join(',')})`;

/**
 * The PostgREST `or` that keeps every non-mention row and every mention that is
 * not on a chat. entity_type is nullable and `neq` never matches null, so null
 * is listed on its own.
 */
export const NOT_CHAT_MENTION_OR = `event_type.neq.${BELL_MENTION_EVENT},entity_type.is.null,entity_type.neq.${BELL_CHAT_ENTITY}`;

/** The two filter methods the helper below adds (a PostgREST filter builder). */
interface BellFilterable<Q> {
  not(column: 'event_type', operator: 'in', value: string): Q;
  or(filters: string): Q;
}

/**
 * Narrow an inbox_entries query to the rows the live layer toasts as activity
 * (isLiveActivityRow): the silent bell types and chat mentions are left out;
 * plan comments and plan reviews stay in.
 */
export function withoutBellEntries<Q extends BellFilterable<Q>>(query: Q): Q {
  return query.not('event_type', 'in', SILENT_LIST).or(NOT_CHAT_MENTION_OR);
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
const TASK_LINK_PREFIX = 'task:';

/** The link token a task alert hands the message link. Pure. */
export function taskLinkToken(taskId: string): string {
  return `${TASK_LINK_PREFIX}${taskId}`;
}
