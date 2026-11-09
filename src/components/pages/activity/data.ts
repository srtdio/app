// Notifications (Inbox) read + write data layer. The page reads inbox_entries
// with a plain RLS-scoped select (each member sees only their own rows) and maps
// every row into a render-ready ActivityItem: Activity's rows and the chat,
// plan and task alerts the chat bell used to show (alerts.ts), on one feed.
// The per-user read-state mutations go through the @srtdio/rpc
// wrappers (each carries an explicit p_trace_id). Everything here that does not
// touch the network is a pure, unit-tested function so the page stays thin.

import { mark } from '@/lib/perf-marks';
import type { Client, Result } from '@srtdio/rpc';
import { inboxMarkAllRead, inboxMarkRead } from '@srtdio/rpc';
import type { Database, InboxEventTypeValue, Json } from '@srtdio/schemas';
import { INBOX_EVENT_TYPES } from '@srtdio/schemas';
import { parseMentions } from '@srtdio/comments';
import { entityUrlPath } from '@/lib/entityRef';
import { logger } from '@/lib/logger';
import {
  mentionNamesIn,
  resolveMentionPreview,
  resolvePersonMentionText,
} from '@/lib/chat/mentions';
import { FORMER_MEMBER, personAvatar, personName, resolvePeople } from '@/lib/people-names';
import {
  BELL_CHAT_ENTITY,
  RETIRED_EVENT_LIST,
  chatMessageHref,
  planHref,
  taskLinkToken,
} from '@/lib/inbox/bell-types';
import {
  bankEventInBank,
  bankEventOpens,
  bankFieldsOf,
  isBankEvent,
  type BankEventFields,
  type BankEventType,
} from '@srtdio/inbox';
import { planItemFocusHref } from '@/lib/focus-target';
import {
  BANK_LABEL,
  CHAT_LABEL,
  PLAN_DELETED_TOAST,
  PLAN_LABEL,
  TASK_ALERT_LABEL,
  alertKindOf,
  bankAlertLine,
  isTaskBatch,
  planAlertLine,
  planFieldsOf,
  readChatMessages,
  taskAlertLine,
  taskFieldsOf,
  type AlertKind,
  type ChatMessagePreview,
  type PlanAlertFields,
  type TaskAlertFields,
} from '@/lib/inbox/alerts';
import { TASKS_SHEET_ONLY } from '@/lib/chat/tasks';
import { errorText } from '@/lib/error-copy';
import type { ViewerSide } from '@/lib/chat/viewer-role';
import { isPostPlatform } from '@srtdio/posts';
import { workspaceDisplayName } from '@/lib/workspace-context';
import { civilDay, zonedParts as readZonedParts, type ZonedParts } from '@/lib/time';
import {
  readBoundedForward,
  readBoundedPage,
  upperFromNow,
  type TimeBounds,
} from '@/lib/chat/bounded-window';
import { readInboxOldest } from '@/lib/inbox/inbox-oldest';
import { INBOX_CHANGED_EVENT } from '@/lib/events';
import {
  invalidateReads,
  peekKept,
  peekRead,
  primeRead,
  readKey,
  sharedRead,
} from '@/lib/session-read';
import { generateTraceId } from '@/lib/trace';
import { getFillCount } from '@/lib/use-fill-count';
import type { PrefetchContext } from '@/lib/prefetch-context';
import type { SortOption } from '@/components/ui/SortMenu';

type InboxEntryRow = Database['public']['Tables']['inbox_entries']['Row'];

/** Same token shape the comment thread resolves: the literal `@[<uuid>]`. */
const MENTION_TOKEN = /@\[([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\]/gi;

/**
 * Resolve every `@[<uuid>]` mention token in a comment body to a plain `@handle`
 * label, exactly as the comment thread does. An id `nameOf` does not resolve
 * reads "@Former member" only when `isFormer` says a successful read confirmed
 * they are not a current member; otherwise (not loaded yet, or a failed read)
 * it renders nothing extra. All surrounding text is returned verbatim. Plain
 * text only: no React nodes, no JSX, no styling.
 */
export function resolveBodyMentions(
  body: string,
  nameOf: (id: string) => string | null,
  isFormer: (id: string) => boolean = () => false,
): string {
  return body.replace(MENTION_TOKEN, (_match, raw: string) => {
    const id = raw.toLowerCase();
    const name = nameOf(id);
    if (name !== null) return `@${name}`;
    return isFormer(id) ? `@${FORMER_MEMBER}` : '';
  });
}

/**
 * Read one string field from an `unknown` jsonb payload. Returns null for a
 * missing key or a non-string value, so a malformed payload never crashes the
 * row and never prints "undefined"/"null". Used for EVERY payload field; the
 * payload is deliberately typed `unknown` and is never cast to `any`.
 */
export function payloadStr(p: unknown, key: string): string | null {
  if (typeof p !== 'object' || p === null) return null;
  const val = (p as Record<string, unknown>)[key];
  return typeof val === 'string' ? val : null;
}

/**
 * Read one finite-number field from an `unknown` jsonb payload. Returns null for
 * a missing key or a non-number value, so a malformed payload never crashes the
 * row. Used for the ledger counts (checkpoints_added.count, post_ready.checkpoints).
 */
export function payloadNum(p: unknown, key: string): number | null {
  if (typeof p !== 'object' || p === null) return null;
  const val = (p as Record<string, unknown>)[key];
  return typeof val === 'number' && Number.isFinite(val) ? val : null;
}

/**
 * The display event type of a brief reopen. brief_reopen writes event_type
 * 'system' with payload.kind 'brief_reopened' (no constraint change); mapEntry
 * lifts it to this type so it reads, groups and links like brief_closed.
 */
export const BRIEF_REOPENED_EVENT = 'brief_reopened';

/**
 * The display event type of a thread's first reply on a card root.
 * chat_message_send writes event_type 'system' with payload.kind
 * 'thread_started' (card_kind, card_id, thread_root_id, message_id); mapEntry
 * lifts it to this type, as with BRIEF_REOPENED_EVENT.
 */
export const THREAD_STARTED_EVENT = 'thread_started';

/** The card kinds a thread_started row names (payload.card_kind). */
export type ThreadCardKind = 'post' | 'brief' | 'plan' | 'item';

function threadCardKindOf(p: unknown): ThreadCardKind | null {
  const kind = payloadStr(p, 'card_kind');
  return kind === 'post' || kind === 'brief' || kind === 'plan' || kind === 'item' ? kind : null;
}

/**
 * The event_type values the app knows (the canonical DB list). A row whose
 * event_type is outside this set still renders a generic line (never blank), but
 * we log it loudly once so app<->DB drift is visible instead of silent. This is
 * the runtime companion to the DB<->app parity test.
 */
const KNOWN_EVENT_TYPES = new Set<string>([
  ...INBOX_EVENT_TYPES,
  BRIEF_REOPENED_EVENT,
  THREAD_STARTED_EVENT,
]);
const warnedUnknownEventTypes = new Set<string>();

/** Log (once per value) any event_type the canonical app list does not know. */
export function warnUnknownEventType(eventType: string): void {
  if (KNOWN_EVENT_TYPES.has(eventType) || warnedUnknownEventTypes.has(eventType)) return;
  warnedUnknownEventTypes.add(eventType);
  logger.warn('activity: unknown inbox event_type (app/DB drift)', { eventType });
}

/**
 * The single inbox event_type the Mentions chip filters on. Typed against the
 * canonical union so it tracks INBOX_EVENT_TYPES (the one source of truth) rather
 * than being a free-floating literal; the Mentions server filter and the unread
 * mention count both reference this constant.
 */
export const MENTION_EVENT_TYPE: InboxEventTypeValue = 'mention';

/**
 * The chips (single-select): which slice of the inbox is shown. Brief and
 * plan rows have no chip of their own: All and Unread show them. 'snoozed'
 * is kept by the reads only (no chip).
 */
export type ActivityState = 'all' | 'unread' | 'mentions' | 'snoozed';

/**
 * The display event type of a row: a 'system' brief reopen is
 * BRIEF_REOPENED_EVENT, a 'system' thread start is THREAD_STARTED_EVENT.
 */
function displayEventType(row: InboxEntryRow, payload: unknown): string {
  if (row.event_type !== 'system') return row.event_type;
  const kind = payloadStr(payload, 'kind');
  if (kind === BRIEF_REOPENED_EVENT) return BRIEF_REOPENED_EVENT;
  if (kind === THREAD_STARTED_EVENT) return THREAD_STARTED_EVENT;
  return row.event_type;
}

/** The inbox scope every brief event is written with (brief comments, mentions,
 *  brief created / closed, posts created from a brief). */
export const BRIEFS_SCOPE = 'briefs';

/** The list order: the top bar's sort (Newest first, the default, or Oldest first). */
export type ActivityDirection = 'newest' | 'oldest';

export const ACTIVITY_SORT_DEFAULT: ActivityDirection = 'newest';

/** The top bar's sort menu, in menu order. Every label says its direction. */
export const ACTIVITY_SORT_OPTIONS: SortOption<ActivityDirection>[] = [
  { value: 'newest', label: 'Newest first' },
  { value: 'oldest', label: 'Oldest first' },
];

/** The useSort page key Activity's order persists under (src/lib/use-sort.ts). */
export const ACTIVITY_SORT_PAGE = 'activity';

/**
 * Where useSort keeps Activity's order on the device ('sorted:sort:' + the page
 * key, src/lib/use-sort.ts), read by the bell press's prefetch so it starts
 * the page one the page will ask for.
 */
export const ACTIVITY_SORT_STORAGE_KEY = `sorted:sort:${ACTIVITY_SORT_PAGE}`;

/** A stored sort value as a direction: anything stale or unknown reads as Newest first. Pure. */
export function activitySort(value: string | null): ActivityDirection {
  return value === 'oldest' ? 'oldest' : ACTIVITY_SORT_DEFAULT;
}

/** The order stored on this device (Newest first when storage is empty or unavailable). */
export function storedActivitySort(): ActivityDirection {
  try {
    return activitySort(window.localStorage.getItem(ACTIVITY_SORT_STORAGE_KEY));
  } catch {
    return ACTIVITY_SORT_DEFAULT;
  }
}

/** One inbox entry, mapped to the fields the row renders. */
export interface ActivityItem {
  id: string;
  workspaceId: string;
  eventType: string;
  entityType: string | null;
  entityId: string | null;
  scope: string;
  tier: string;
  createdAt: string;
  readAt: string | null;
  snoozedUntil: string | null;
  // Derived from the payload via payloadStr (never cast to any).
  commentId: string | null;
  /** The asset id, asset events only (asset_uploaded / asset_version_added); null otherwise. */
  assetId: string | null;
  toStage: string | null;
  fromStage: string | null;
  /** The entity title, when the writer recorded one (briefs). */
  title: string | null;
  /** The acting user id (created_by / invited_by), when present. */
  actorId: string | null;
  /** Resolved display name for actorId, filled in after a profile read. */
  actorName: string | null;
  /** Resolved avatar image url for the actor, filled in after a profile read. */
  actorAvatarUrl: string | null;
  /** The comment text, resolved by the comments join (comment events only). */
  body: string | null;
  /** The post format (text/single_image/carousel/video/link), posts only. */
  format: string | null;
  /** The post caption, posts only (null otherwise). Feeds the thumbnail fallback body. */
  caption: string | null;
  /** The post's first-image asset_version_id, posts only; null for a text/imageless post. */
  thumbnailAssetVersionId: string | null;
  /** The entity's per-workspace number (post/brief), resolved by the batched join;
   *  null until resolved, so pretty links degrade to the classic id route. */
  number: number | null;
  /** Points sent in a checkpoints_added batch (payload.count); null otherwise. */
  pointsAdded: number | null;
  /** Total checkpoints on a post_ready ping (payload.checkpoints); null otherwise. */
  checkpointTotal: number | null;
  /** The feedback-point batch id (checkpoints_added only, payload.batch_id); links
   *  to comments.ledger_batch_id so the batch author + first point resolve by join. */
  batchId: string | null;
  /** The chat message a chat mention points at (payload.message_id); null otherwise. */
  messageId: string | null;
  /** A chat mention's chat kind, resolved by the chat_channels join; null otherwise. */
  channelType: 'group' | 'dm' | null;
  /** The actor's workspace role at the time (payload.actor_role); null or absent on old rows. */
  actorRole?: string | null;
  /** assets_deleted only: how many assets went (payload.count); null otherwise. */
  assetCount?: number | null;
  /** assets_deleted only: up to 3 of the deleted filenames (payload.files, else payload.filenames). */
  filenames?: string[];
  /** assets_deleted only: up to 3 deleted files with their version and type (payload.files); empty on old rows. */
  deletedFiles?: DeletedFile[];
  /**
   * Plan events (plan_comment / plan_review / plan mentions) and idea bank
   * alerts: the plan (payload.plan_id); null for a bank idea and on every
   * other row.
   */
  planId?: string | null;
  /** The row's scope_key: 'bank' for a plan-item row on a bank idea. */
  scopeKey?: string | null;
  /** Plan events only: the plan's title, resolved by the batched plans read. */
  planTitle?: string | null;
  /** plan_review only: which side reviewed (payload.side, 'team' | 'client'). */
  reviewSide?: string | null;
  /** plan_review only: the review outcome (payload.status, 'approved' | 'changes' | 'waiting'). */
  reviewStatus?: string | null;
  /** plan_review only: a withdrawal (payload.withdrawn true, status 'waiting'). */
  reviewWithdrawn?: boolean;
  /** plan_review withdrawal only: the status withdrawn (payload.previous). */
  reviewPrevious?: string | null;
  /** A 'system' welcome row only (payload.kind 'welcome'): the workspace it opens. */
  welcome?: WelcomeInfo | null;
  /** stage_change approvals only: the client approved for (payload.on_behalf_of). */
  onBehalfOfId?: string | null;
  /** The resolved full name for onBehalfOfId ("Former member" once a read confirms they left). */
  onBehalfOfName?: string | null;
  /** The viewer's own action (the already-read row written for the actor): reads "You". */
  own?: boolean;
  /** brief_post_created only: the brief the post was created from (payload.brief_title). */
  fromBriefTitle?: string | null;
  /** A chat, plan or task alert's own fields (alerts.ts); null or absent on every other row. */
  alert?: AlertInfo | null;
  /** A chat mention in a thread, or a thread start: the thread's root (payload.thread_root_id). */
  threadRootId?: string | null;
  /** thread_started only: the root card's kind and id (payload.card_kind, payload.card_id). */
  cardKind?: ThreadCardKind | null;
  cardId?: string | null;
  /** Chat rows: the group chat's name by join; null for a DM or before the read. */
  chatName?: string | null;
}

/**
 * The fields a plan, task or idea bank alert card reads: the plan alerts that
 * name a plan, the task alerts and the idea bank alerts.
 */
export interface AlertInfo {
  kind: AlertKind;
  /** Chat rows (task): the chat (entity_id). */
  channelId: string | null;
  /** The chat's name for a group; null for a direct chat or an unread one (reads "Chat"). */
  chatName: string | null;
  /** plan: the payload's fields, and the plan and item titles the loader resolved. */
  plan?: PlanAlertFields;
  planTitle: string | null;
  itemTitle: string | null;
  /** task: the payload's fields. */
  task?: TaskAlertFields;
  /** bank: the payload's fields (title, plan_title, from_plan_title, target_date). */
  bank?: BankEventFields;
}

/** An alert's fields from its row: everything the loader does not resolve. Pure. */
function alertOf(row: InboxEntryRow, payload: unknown): AlertInfo | null {
  const kind = alertKindOf(row.event_type);
  if (kind === null) return null;
  return {
    kind,
    channelId: row.entity_type === BELL_CHAT_ENTITY ? row.entity_id : null,
    chatName: null,
    ...(kind === 'plan' ? { plan: planFieldsOf(row) } : {}),
    planTitle: null,
    itemTitle: null,
    ...(kind === 'task' ? { task: taskFieldsOf(row) } : {}),
    ...(kind === 'bank' ? { bank: bankFieldsOf(payload) } : {}),
  };
}

/** One deleted file an assets_deleted row names (payload.files[]). */
export interface DeletedFile {
  assetVersionId: string | null;
  filename: string;
  mimeType: string | null;
}

/** payload.files[] of an assets_deleted row; entries without a filename are dropped. Pure. */
export function deletedFilesOf(payload: unknown): DeletedFile[] {
  if (typeof payload !== 'object' || payload === null) return [];
  const files = (payload as Record<string, unknown>).files;
  if (!Array.isArray(files)) return [];
  return files.flatMap((entry: unknown) => {
    const filename = payloadStr(entry, 'filename');
    if (filename === null) return [];
    return [
      {
        assetVersionId: payloadStr(entry, 'asset_version_id'),
        filename,
        mimeType: payloadStr(entry, 'mime_type'),
      },
    ];
  });
}

/** The workspace a welcome row names: payload.workspace_name and payload.platform. */
export interface WelcomeInfo {
  workspaceName: string;
  platform: string;
}

/** The welcome row's second sentence, shown as its body. */
export const WELCOME_BODY = 'Comments, approvals and briefs land here.';

function welcomeOf(eventType: string, payload: unknown): WelcomeInfo | null {
  if (eventType !== 'system' || payloadStr(payload, 'kind') !== 'welcome') return null;
  const workspaceName = payloadStr(payload, 'workspace_name');
  if (workspaceName === null) return null;
  return { workspaceName, platform: payloadStr(payload, 'platform') ?? '' };
}

/** Whether a row is the welcome workspace_create / member_accept writes. */
export function isWelcome(item: Pick<ActivityItem, 'welcome'>): boolean {
  return item.welcome != null;
}

/**
 * The welcome row's title: "<Brand> - <Platform> is ready." through the one
 * workspace display formatter; the brand alone when the platform is unknown.
 */
export function welcomeTitle(item: Pick<ActivityItem, 'welcome'>): string {
  const info = item.welcome;
  if (info == null) return '';
  const label = isPostPlatform(info.platform)
    ? workspaceDisplayName({ name: info.workspaceName, platform: info.platform })
    : info.workspaceName;
  return `${label} is ready.`;
}

/**
 * Event types whose actor is the row's own actor_user_id (the person who
 * approved, rejected, parked, sent for review, or deleted).
 */
export const ACTOR_ROW_EVENTS: ReadonlySet<string> = new Set([
  'stage_change',
  'post_deleted',
  'assets_deleted',
]);

/**
 * Event types whose actor is the row's actor_user_id, which the writer stamps:
 * the resolver, the asker, the reopener, the ready ping's sender, the uploader,
 * the brief's creator and the brief's closer.
 */
const ROW_ACTOR_EVENTS: ReadonlySet<string> = new Set([
  'comment_resolved',
  'checkpoint_asked',
  'checkpoint_reopened',
  'post_ready',
  'asset_uploaded',
  'asset_version_added',
  'brief_post_created',
  'brief_created',
  'brief_closed',
  BRIEF_REOPENED_EVENT,
  THREAD_STARTED_EVENT,
]);

/** The actor id a row names: actor_user_id where the writer stamps it, else the payload's. */
function rowActorId(row: InboxEntryRow, payload: unknown): string | null {
  const own = row.actor_user_id ?? null;
  if (
    isChatMention({ eventType: row.event_type, entityType: row.entity_type }) ||
    ACTOR_ROW_EVENTS.has(row.event_type) ||
    PLAN_EVENTS.has(row.event_type)
  ) {
    return own;
  }
  // A brief_closed or reopen row never falls back to payload.created_by: that is the creator.
  const display = displayEventType(row, payload);
  if (display === 'brief_closed' || display === BRIEF_REOPENED_EVENT) return own;
  if (ROW_ACTOR_EVENTS.has(row.event_type)) return own ?? payloadStr(payload, 'created_by');
  return own ?? payloadStr(payload, 'created_by') ?? payloadStr(payload, 'invited_by');
}

/** The plan event types: entity_type 'plan_item', entity_id the item, payload.plan_id the plan. */
const PLAN_EVENTS: ReadonlySet<string> = new Set(['plan_comment', 'plan_review']);

/** The entity_type of a plan event row (entity_id is the plan item id). */
export const PLAN_ITEM_ENTITY = 'plan_item';

/**
 * Whether a row is an @mention in a plan item comment: event_type 'mention',
 * entity_type 'plan_item' (entity_id the item, payload plan_id and comment_id).
 */
export function isPlanMention(item: Pick<ActivityItem, 'eventType' | 'entityType'>): boolean {
  return item.eventType === MENTION_EVENT_TYPE && item.entityType === PLAN_ITEM_ENTITY;
}

/** Whether a row is a plan comment, plan review or plan mention. */
function isPlanEvent(item: Pick<ActivityItem, 'eventType' | 'entityType'>): boolean {
  return PLAN_EVENTS.has(item.eventType) || isPlanMention(item);
}

/** Whether a plan row points at one plan comment (a comment or a mention in one). */
function isPlanCommentRow(item: Pick<ActivityItem, 'eventType' | 'entityType'>): boolean {
  return item.eventType === 'plan_comment' || isPlanMention(item);
}

/** The name an actor-row line uses when the actor's name did not resolve. */
export const UNKNOWN_ACTOR = 'Someone';

/** The actor name on the viewer's own rows ("You approved ..."). */
export const SELF_ACTOR = 'You';

/** Read a string array field from an `unknown` jsonb payload; non-strings are dropped. */
function payloadStrings(p: unknown, key: string): string[] {
  if (typeof p !== 'object' || p === null) return [];
  const val = (p as Record<string, unknown>)[key];
  return Array.isArray(val) ? val.filter((v): v is string => typeof v === 'string') : [];
}

/** The entity_type of a chat mention row (entity_id is the channel id). */
const CHAT_CHANNEL_ENTITY = 'chat_channel';

/** An @mention in a chat message (not a comment): its own line, link and preview. */
export function isChatMention(item: Pick<ActivityItem, 'eventType' | 'entityType'>): boolean {
  return item.eventType === MENTION_EVENT_TYPE && item.entityType === CHAT_CHANNEL_ENTITY;
}

/** A thread's first reply on a card (system/thread_started on a chat). */
export function isThreadStarted(item: Pick<ActivityItem, 'eventType'>): boolean {
  return item.eventType === THREAD_STARTED_EVENT;
}

/** A chat row the chat reads fill: a chat mention or a thread start. */
export function isChatRow(item: Pick<ActivityItem, 'eventType' | 'entityType'>): boolean {
  return isChatMention(item) || isThreadStarted(item);
}

/** What a thread_started card is, in words: "a post", "a brief", "a plan", "an idea". Pure. */
export function threadCardNoun(kind: ThreadCardKind | null | undefined): string {
  switch (kind) {
    case 'brief':
      return 'a brief';
    case 'plan':
      return 'a plan';
    case 'item':
      return 'an idea';
    default:
      return 'a post';
  }
}

/** The first line of a chat message, mentions resolved; null when it has no text. */
export function chatMentionPreview(
  body: string | null,
  nameOf: (id: string) => string | undefined,
): string | null {
  if (body === null) return null;
  const first = resolveMentionPreview(body, nameOf).trim().split('\n')[0]?.trim() ?? '';
  return first !== '' ? first : null;
}

/** Whether a jsonb payload's `key` is literally true. Pure. */
function payloadFlag(p: unknown, key: string): boolean {
  return typeof p === 'object' && p !== null && (p as Record<string, unknown>)[key] === true;
}

/**
 * A plan_review withdrawal's phrase: "withdrew their changes request" when the
 * withdrawn status was changes, else "withdrew slot approval". Null when the
 * row is not a withdrawal. Pure.
 */
function planWithdrawalPhrase(
  withdrawn: boolean | null | undefined,
  previous: string | null | undefined,
): string | null {
  if (withdrawn !== true) return null;
  return previous === 'changes' ? 'withdrew their changes request' : 'withdrew slot approval';
}

/** Map a raw inbox_entries row into an ActivityItem. Pure; actorName stays null. */
export function mapEntry(row: InboxEntryRow): ActivityItem {
  const payload: unknown = row.payload as Json;
  const plan =
    PLAN_EVENTS.has(row.event_type) ||
    (row.event_type === MENTION_EVENT_TYPE && row.entity_type === PLAN_ITEM_ENTITY);
  const review = row.event_type === 'plan_review';
  const onBehalfOfId =
    row.event_type === 'stage_change' ? payloadStr(payload, 'on_behalf_of') : null;
  const deleted = row.event_type === 'assets_deleted';
  const deletedFiles = deleted ? deletedFilesOf(payload) : [];
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    eventType: displayEventType(row, payload),
    entityType: row.entity_type,
    entityId: row.entity_id,
    scope: row.scope,
    tier: row.tier,
    createdAt: row.created_at,
    readAt: row.read_at,
    snoozedUntil: row.snoozed_until,
    commentId: payloadStr(payload, 'comment_id'),
    assetId: payloadStr(payload, 'asset_id'),
    toStage: payloadStr(payload, 'to_stage') ?? payloadStr(payload, 'to'),
    fromStage: payloadStr(payload, 'from_stage') ?? payloadStr(payload, 'from'),
    title:
      payloadStr(payload, 'title') ??
      (row.event_type === 'brief_post_created' ? payloadStr(payload, 'post_title') : null),
    actorId: rowActorId(row, payload),
    actorName: null,
    actorAvatarUrl: null,
    body: null,
    format: null,
    caption: null,
    thumbnailAssetVersionId: null,
    number: row.event_type === 'post_deleted' ? payloadNum(payload, 'number') : null,
    pointsAdded: payloadNum(payload, 'count'),
    checkpointTotal: payloadNum(payload, 'checkpoints'),
    batchId: row.event_type === 'checkpoints_added' ? payloadStr(payload, 'batch_id') : null,
    own: row.actor_user_id !== null && row.actor_user_id === row.user_id,
    fromBriefTitle:
      row.event_type === 'brief_post_created' ? payloadStr(payload, 'brief_title') : null,
    messageId: payloadStr(payload, 'message_id'),
    channelType: null,
    actorRole: payloadStr(payload, 'actor_role'),
    assetCount: row.event_type === 'assets_deleted' ? payloadNum(payload, 'count') : null,
    filenames: !deleted
      ? []
      : deletedFiles.length > 0
        ? deletedFiles.map((file) => file.filename)
        : payloadStrings(payload, 'filenames'),
    deletedFiles,
    planId: plan || isBankEvent(row.event_type) ? payloadStr(payload, 'plan_id') : null,
    scopeKey: row.scope_key,
    planTitle: null,
    reviewSide: review ? payloadStr(payload, 'side') : null,
    reviewStatus: review ? payloadStr(payload, 'status') : null,
    reviewWithdrawn: review && payloadFlag(payload, 'withdrawn'),
    reviewPrevious: review ? payloadStr(payload, 'previous') : null,
    welcome: welcomeOf(row.event_type, payload),
    onBehalfOfId,
    onBehalfOfName: null,
    alert: alertOf(row, payload),
    threadRootId: payloadStr(payload, 'thread_root_id'),
    cardKind: threadCardKindOf(payload),
    cardId: payloadStr(payload, 'card_id'),
    chatName: null,
  };
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

/** The non-null actor display names in source order, distinct. */
export function bucketActorNames(items: readonly ActivityItem[]): string[] {
  const names: string[] = [];
  for (const item of items) {
    if (item.actorName !== null) names.push(item.actorName);
  }
  return unique(names);
}

/** One distinct actor of a bucket, for its avatar stack's person cards. */
export interface BucketActor {
  name: string;
  userId: string | null;
  avatarUrl: string | null;
}

/**
 * The bucket's distinct actors in bucketActorNames' order (one per name, the
 * first entry's id and photo), so each stack avatar can open its person card. Pure.
 */
export function bucketActors(items: readonly ActivityItem[]): BucketActor[] {
  const seen = new Map<string, BucketActor>();
  for (const item of items) {
    if (item.actorName === null || seen.has(item.actorName)) continue;
    seen.set(item.actorName, {
      name: item.actorName,
      userId: item.actorId,
      avatarUrl: item.actorAvatarUrl,
    });
  }
  return [...seen.values()];
}

/** A post / brief target label that never renders "undefined"/"null". */
function entityTarget(item: ActivityItem): string {
  if (item.title !== null) return item.title;
  if (item.entityType === 'post') return 'a post';
  if (item.entityType === 'brief') return 'a brief';
  return 'Activity';
}

/** "1 point" / "N points". UI vocabulary: the DB stores these as checkpoints. */
function pointsLabel(n: number): string {
  return `${n} ${n === 1 ? 'point' : 'points'}`;
}

/**
 * A chat mention's line: "<actor> mentioned you in <group>" in a group, "<actor>
 * mentioned you" in a DM. A missing actor or group name degrades, never blank.
 */
function chatMentionLine(item: ActivityItem): string {
  const who = item.actorName;
  const inGroup = item.channelType === 'group' && item.title !== null ? ` in ${item.title}` : '';
  if (item.threadRootId != null) {
    return who !== null
      ? `${who} mentioned you in a thread${inGroup}`
      : `New mention in a thread${inGroup}`;
  }
  return who !== null ? `${who} mentioned you${inGroup}` : `New mention${inGroup}`;
}

/**
 * A thread start's line: "<Actor> started a thread on <card title>", else
 * "<Actor> started a thread in <chat name>" while the card title is unknown.
 */
function threadStartedLine(item: ActivityItem): string {
  const who = item.actorName ?? UNKNOWN_ACTOR;
  if (item.title !== null && item.title !== '') return `${who} started a thread on ${item.title}`;
  return `${who} started a thread in ${item.chatName ?? CHAT_LABEL}`;
}

/**
 * A plan event's line: "<actor> commented on a plan item", "<actor> approved a
 * plan item" / "<actor> asked changes on a plan item". A team-side review adds
 * "(team review)"; the client side reads plain. A missing actor degrades to a
 * name-free phrase. Null for any other event type.
 */
function planEventLine(
  item: Pick<
    ActivityItem,
    | 'eventType'
    | 'entityType'
    | 'actorName'
    | 'reviewSide'
    | 'reviewStatus'
    | 'reviewWithdrawn'
    | 'reviewPrevious'
  >,
): string | null {
  const who = item.actorName;
  if (isPlanMention(item)) {
    return who !== null ? `${who} mentioned you in a plan item` : 'New mention in a plan item';
  }
  if (item.eventType === 'plan_comment') {
    return who !== null ? `${who} commented on a plan item` : 'New comment on a plan item';
  }
  if (item.eventType !== 'plan_review') return null;
  const team = item.reviewSide === 'team' ? ' (team review)' : '';
  const withdrew = planWithdrawalPhrase(item.reviewWithdrawn, item.reviewPrevious);
  if (withdrew !== null) {
    return `${who ?? UNKNOWN_ACTOR} ${withdrew}${team}`;
  }
  switch (item.reviewStatus) {
    case 'approved':
      return who !== null
        ? `${who} approved a plan item${team}`
        : `A plan item was approved${team}`;
    case 'changes':
      return who !== null
        ? `${who} asked changes on a plan item${team}`
        : `Changes asked on a plan item${team}`;
    default:
      return who !== null
        ? `${who} reviewed a plan item${team}`
        : `A plan item was reviewed${team}`;
  }
}

/** A post row's title for its line, else "a post" (never a KEY-N code). */
function postRef(item: ActivityItem): string {
  return item.title !== null && item.title !== '' ? item.title : 'a post';
}

/** The stage verb phrase: "approved <title>", "sent <title> for review". */
function stagePhrase(toStage: string | null, ref: string | null): string {
  const at = ref !== null ? ` ${ref}` : '';
  switch (toStage) {
    case 'approved':
      return `approved${at}`;
    case 'rejected':
      return `rejected${at}`;
    case 'parked':
      return `parked${at}`;
    case 'review':
      return `sent${at} for review`;
    default:
      return toStage !== null
        ? `moved${at} to ${toStage.charAt(0).toUpperCase()}${toStage.slice(1)}`
        : `moved${at}`;
  }
}

/**
 * What an actor-row line carries: `title` false inside a card, whose header
 * already shows the post title; `name` false in an expanded row, whose author
 * line already shows the name.
 */
interface ActorLineParts {
  title?: boolean;
  name?: boolean;
}

/**
 * The who-did-what line for an actor row (stage_change, post_deleted,
 * assets_deleted): "<Name> approved <Title>", "<Name> sent <Title> for review",
 * "<Name> deleted <Title>", "<Name> deleted brief.pdf" / "<Name> deleted 3
 * assets". An approval recorded on behalf of a client reads "<Name> approved for
 * <Client>"; nothing else names a brand or a client (decision 18 Oct 2026). A
 * missing name reads "Someone". Null for any other event type. Never a KEY-N code.
 */
export function actorRowLine(item: ActivityItem, parts: ActorLineParts = {}): string | null {
  if (!ACTOR_ROW_EVENTS.has(item.eventType)) return null;
  const withTitle = parts.title !== false;
  const lead = parts.name !== false ? `${item.actorName ?? UNKNOWN_ACTOR} ` : '';
  if (item.eventType === 'stage_change') {
    if (item.toStage === 'approved' && item.onBehalfOfName != null) {
      return `${lead}approved for ${item.onBehalfOfName}`;
    }
    return `${lead}${stagePhrase(item.toStage, withTitle ? postRef(item) : null)}`;
  }
  if (item.eventType === 'post_deleted') {
    const title = withTitle && item.title !== null && item.title !== '' ? ` ${item.title}` : '';
    return `${lead}deleted${title}`;
  }
  return `${lead}deleted ${filesPhrase(deletedCount(item))}`;
}

/** How many files an assets_deleted row deleted: payload.count, else the names it lists. Pure. */
export function deletedCount(item: Pick<ActivityItem, 'assetCount' | 'filenames'>): number {
  return item.assetCount ?? (item.filenames ?? []).length;
}

/** "a file" / "N files". Pure. */
export function filesPhrase(count: number): string {
  return count === 1 ? 'a file' : `${count} files`;
}

/**
 * An assets_deleted card's body: the other files it names. "Also A and B",
 * "Also A, B and 1 more"; null for a single file. Pure.
 */
export function deletedFilesBody(
  item: Pick<ActivityItem, 'assetCount' | 'filenames'>,
): string | null {
  const names = item.filenames ?? [];
  const count = Math.max(deletedCount(item), names.length);
  const others = names.slice(1);
  if (count <= 1 || others.length === 0) {
    return count > 1 ? `Also ${count - 1} more` : null;
  }
  const more = count - 1 - others.length;
  if (more > 0) return `Also ${others.join(', ')} and ${more} more`;
  if (others.length === 1) return `Also ${others[0] ?? ''}`;
  return `Also ${others.slice(0, -1).join(', ')} and ${others[others.length - 1] ?? ''}`;
}

const IMAGE_EXTENSIONS = new Set([
  'jpg',
  'jpeg',
  'png',
  'gif',
  'webp',
  'heic',
  'heif',
  'svg',
  'avif',
]);
const VIDEO_EXTENSIONS = new Set(['mp4', 'mov', 'm4v', 'webm', 'avi', 'mkv']);

/** A deleted file's kind for its text tile: PDF, IMAGE, VIDEO or FILE. Pure. */
export function fileKindLabel(file: Pick<DeletedFile, 'filename' | 'mimeType'>): string {
  const mime = (file.mimeType ?? '').toLowerCase();
  const ext = file.filename.includes('.')
    ? (file.filename.split('.').pop() ?? '').toLowerCase()
    : '';
  if (mime === 'application/pdf' || ext === 'pdf') return 'PDF';
  if (mime.startsWith('image/') || IMAGE_EXTENSIONS.has(ext)) return 'IMAGE';
  if (mime.startsWith('video/') || VIDEO_EXTENSIONS.has(ext)) return 'VIDEO';
  return 'FILE';
}

/**
 * The human-readable line for a row. Null-safe: a missing actor name drops the
 * name entirely rather than printing a placeholder (actor rows read "Someone"),
 * and a missing title falls back to "a post" / "a brief" by entity type.
 */
export function activityLine(item: ActivityItem): string {
  const who = item.actorName;
  const target = entityTarget(item);
  if (isChatMention(item)) return chatMentionLine(item);
  if (isThreadStarted(item)) return threadStartedLine(item);
  // An idea bank row reads its own line (the search hit's words too).
  if (item.alert?.kind === 'bank') {
    return bankAlertLine(item.eventType, item.alert.bank, item.actorName, 'unknown');
  }
  if (isWelcome(item)) return `${welcomeTitle(item)} ${WELCOME_BODY}`;
  const actorRow = actorRowLine(item);
  if (actorRow !== null) return actorRow;
  const planLine = planEventLine(item);
  if (planLine !== null) return planLine;
  switch (item.eventType) {
    case 'comment':
      return who !== null ? `${who} commented on ${target}` : `New comment on ${target}`;
    case 'mention':
      return who !== null ? `${who} mentioned you in ${target}` : `New mention in ${target}`;
    case 'comment_resolved':
      return who !== null
        ? `${who} resolved a thread on ${target}`
        : `A comment thread was resolved on ${target}`;
    case 'brief_created':
      return who !== null
        ? `${who} created ${target}`
        : item.title !== null
          ? `New brief: ${item.title}`
          : 'A new brief was created';
    case 'brief_post_created':
      return `${who ?? UNKNOWN_ACTOR} created ${target} from ${item.fromBriefTitle ?? 'a brief'}`;
    case 'brief_closed':
      return who !== null
        ? `${who} closed ${target}`
        : item.title !== null
          ? `Brief ${item.title} closed`
          : 'A brief was closed';
    case BRIEF_REOPENED_EVENT:
      return `${who ?? UNKNOWN_ACTOR} reopened ${target}`;
    case 'asset_uploaded':
      return who !== null ? `${who} uploaded a file` : 'New file uploaded';
    case 'asset_version_added':
      return who !== null ? `${who} added a file version` : 'New file version';
    case 'invite':
      return who !== null ? `${who} invited a new member` : 'New workspace invite';
    case 'checkpoints_added':
      if (item.pointsAdded === null) return `Points sent on ${target}`;
      return who !== null
        ? `${who} sent ${pointsLabel(item.pointsAdded)} on ${target}`
        : `${pointsLabel(item.pointsAdded)} sent on ${target}`;
    case 'post_ready':
      return who !== null ? `${who} sent ${target} for review` : `${target} is ready for review`;
    default:
      return target;
  }
}

/**
 * An Activity search hit's line (the command palette's Activity rows): the
 * feed's own words for the event, from its type, its subject and the subject's
 * title, through the same mapEntry + activityLine the feed cards use (never a
 * second label map). `actorName` is the actor when the palette knows them.
 * Pure.
 */
export function activityHitLine(hit: {
  id: string;
  workspaceId: string;
  eventType: string;
  entityType: string | null;
  title: string;
  actorName: string | null;
}): string {
  const item = mapEntry({
    id: hit.id,
    workspace_id: hit.workspaceId,
    user_id: '',
    event_type: hit.eventType,
    entity_type: hit.entityType,
    entity_id: null,
    scope: '',
    scope_key: null,
    tier: '',
    created_at: '',
    read_at: null,
    snoozed_until: null,
    deleted_at: null,
    email_sent_at: null,
    payload: {},
    actor_user_id: null,
  });
  return activityLine({
    ...item,
    title: hit.title !== '' ? hit.title : null,
    planTitle: hit.title !== '' ? hit.title : null,
    actorName: hit.actorName,
  });
}

/**
 * An Activity line without the actor's name ("Maya sent X for review" ->
 * "Sent X for review"), its first letter raised: the actor is shown beside
 * it. Never empty for a non-empty line. Pure.
 */
export function lineWithoutName(line: string, name: string | null): string {
  const trimmed =
    name !== null && name !== '' && line.startsWith(`${name} `)
      ? line.slice(name.length + 1)
      : line;
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
}

/**
 * One notification's line inside its item card (9 Nov 2026: every
 * notification gets its own line): the actor ("Someone" when unknown) and
 * the Activity line without the name. Unknown types read activityLine's
 * fallback, never dropped. Pure.
 */
export function entryLine(
  item: ActivityItem,
  side: ViewerSide = 'unknown',
): { actor: string; text: string } {
  const actor = item.actorName !== null && item.actorName !== '' ? item.actorName : UNKNOWN_ACTOR;
  let line: string;
  try {
    // An alert reads in the bell's words (side-aware); every other row its Activity line.
    line = item.alert != null ? alertTitle(item, item.alert, side) : activityLine(item);
  } catch {
    line = 'Updated this';
  }
  // A plan item row names its item (as the card title does) in place of "a plan item".
  if (item.entityType === PLAN_ITEM_ENTITY && item.title !== null && item.title !== '') {
    line = line.replace('a plan item', item.title);
  }
  return { actor, text: lineWithoutName(line, actor) || 'Updated this' };
}

/**
 * The card header title: the entity title when known, a generic entity label for
 * a post/brief without a resolved title, and the full activity line otherwise (so
 * a non-entity entry, e.g. an invite, still reads as a sentence). Null-safe.
 */
export function cardTitle(item: ActivityItem): string {
  if (isWelcome(item)) return welcomeTitle(item);
  if (item.title !== null) return item.title;
  if (item.entityType === 'post') return 'Untitled post';
  if (item.entityType === 'brief') return 'Untitled brief';
  if (item.entityType === PLAN_ITEM_ENTITY) return item.planTitle ?? 'Plan item';
  return activityLine(item);
}

/**
 * The short event line for inside a card: the event WITHOUT the entity title or
 * actor (the title is the card header, the actor is the avatar). Used for the lead
 * line and every threaded event line so the title is never repeated. Actor rows
 * (approve, reject, park, review, deletes) are the exception: who did it IS the
 * event, so they read the full who-did-what line.
 */
export function shortLine(item: ActivityItem, parts: { name?: boolean } = {}): string {
  if (isWelcome(item)) return WELCOME_BODY;
  // Inside a card the header already carries the post title: never repeat it.
  const actorRow = actorRowLine(item, { title: false, name: parts.name !== false });
  if (actorRow !== null) return actorRow;
  const planLine = planEventLine(item);
  if (planLine !== null) return planLine;
  switch (item.eventType) {
    case 'comment':
      return 'New comment';
    case 'mention':
      return 'New mention';
    case 'comment_resolved':
      return 'Thread resolved';
    case 'brief_created':
      return 'Brief created';
    case 'brief_closed':
      return 'Brief closed';
    case BRIEF_REOPENED_EVENT:
      return 'Brief reopened';
    case THREAD_STARTED_EVENT:
      return threadStartedLine(item);
    case 'brief_post_created':
      return item.fromBriefTitle !== null && item.fromBriefTitle !== undefined
        ? `Created from ${item.fromBriefTitle}`
        : 'Created from a brief';
    case 'asset_uploaded':
      return 'New file';
    case 'asset_version_added':
      return 'New file version';
    case 'invite':
      return 'New member invited';
    case 'checkpoints_added':
      return item.pointsAdded !== null ? `${pointsLabel(item.pointsAdded)} sent` : 'Points sent';
    case 'post_ready':
      return 'Ready for review';
    case 'checkpoint_asked':
      return 'Question asked';
    case 'checkpoint_reopened':
      return 'Point reopened';
    default:
      return 'Activity';
  }
}

/** Trim a comment body to a single legible line of at most ~140 characters. */
function trimBody(text: string): string {
  const t = text.trim();
  return t.length <= 140 ? t : `${t.slice(0, 140).trimEnd()}…`;
}

/**
 * The body line shown inside a card. For a comment event it is the real comment
 * text, trimmed to ~140 chars; for every other event type (and for a comment with
 * an empty/missing body) it falls back to the existing generic short line. Never
 * throws and never renders an empty string for a comment that has text.
 */
export function cardBodyLine(item: ActivityItem, parts: { name?: boolean } = {}): string {
  const showsBody =
    item.eventType === 'comment' ||
    item.eventType === 'checkpoints_added' ||
    item.eventType === 'plan_comment';
  if (showsBody && item.body !== null && item.body.trim().length > 0) {
    return trimBody(item.body);
  }
  return shortLine(item, parts);
}

/** An alert row's chat name: the group's, else "Chat". Pure. */
function alertChat(alert: AlertInfo): string {
  return alert.chatName ?? CHAT_LABEL;
}

/**
 * An alert card's top line, beside the actor's photo: the actor's name (a
 * plan or task change's author), else the alert's label ("Plan", "Tasks",
 * "Idea bank"). Pure.
 */
export function alertTopLine(item: Pick<ActivityItem, 'actorName'>, alert: AlertInfo): string {
  if (item.actorName !== null) return item.actorName;
  switch (alert.kind) {
    case 'plan':
      return PLAN_LABEL;
    case 'task':
      return TASK_ALERT_LABEL;
    case 'bank':
      return BANK_LABEL;
  }
}

/**
 * An alert card's title, in the bell's words: the plan alert's line
 * (side-aware for plan_opened); the task alert's line; the idea bank's line.
 * Pure.
 */
export function alertTitle(
  item: Pick<ActivityItem, 'eventType' | 'actorName'>,
  alert: AlertInfo,
  side: ViewerSide,
): string {
  switch (alert.kind) {
    case 'plan':
      return planAlertLine(
        item.eventType,
        alert.plan,
        { who: item.actorName, plan: alert.planTitle, item: alert.itemTitle },
        side,
      );
    case 'task':
      return taskAlertLine(item.eventType, alert.task, item.actorName);
    case 'bank':
      return bankAlertLine(item.eventType, alert.bank, item.actorName, side);
  }
}

/**
 * An alert card's second line: the chat for a task alert, the item a plan
 * alert names (never the plan twice), or null when there is none. Pure.
 */
export function alertBody(alert: AlertInfo): string | null {
  switch (alert.kind) {
    case 'task':
      return alertChat(alert);
    case 'plan':
      return alert.itemTitle ?? alert.plan?.itemTitle ?? null;
    case 'bank':
      // The line already names the idea (and the plan): no second line.
      return null;
  }
}

/**
 * The link an alert opens, or null (a deleted plan, a row without its chat,
 * a moved idea read by a client). Pure.
 */
function alertHref(item: ActivityItem, alert: AlertInfo, side: ViewerSide): string | null {
  switch (alert.kind) {
    case 'plan': {
      const plan = alert.plan;
      if (item.eventType === 'plan_deleted' || plan?.planId == null) return null;
      return planHref(plan.planId, plan.leftPlan ? null : plan.itemId);
    }
    case 'bank': {
      if (!isBankEvent(item.eventType) || item.entityId === null) return null;
      if (!bankOpensFor(item.eventType, side)) return null;
      // A planned idea now sits in its plan; every other bank row opens the idea in the bank.
      return planItemFocusHref({
        planId: bankEventInBank(item.eventType) ? null : (item.planId ?? null),
        scopeKey: bankEventInBank(item.eventType) ? 'bank' : (item.scopeKey ?? null),
        itemId: item.entityId,
      });
    }
    case 'task': {
      if (alert.channelId === null) return null;
      // A batch opens the sheet with no row expanded; one task opens on that row.
      const taskId = isTaskBatch(item.eventType, alert.task)
        ? TASKS_SHEET_ONLY
        : (alert.task?.taskId ?? null);
      return chatMessageHref(
        alert.channelId,
        taskId !== null ? taskLinkToken(taskId) : item.messageId,
      );
    }
  }
}

/**
 * Whether a bank row opens for this side. Only the agency side is sure to see
 * the bank: an unknown side (the shell's live toast, a side still loading)
 * follows the client rule, so a moved idea never sends a client to a bank
 * they cannot open (the toast then opens Activity). Pure.
 */
function bankOpensFor(eventType: BankEventType, side: ViewerSide): boolean {
  return bankEventOpens(eventType, side === 'agency' ? 'team' : 'client');
}

/** What a tap on a row does. */
interface OpenAction {
  /** Where it goes; null opens nothing. */
  href: string | null;
  /** Whether the tap marks the row read. */
  markRead: boolean;
  /** A toast the tap shows (a deleted plan's); null for none. */
  toast: string | null;
}

/**
 * The tap on a row, in the bell's rules for the alerts: a deleted plan (or one with no
 * id) marks read, opens nothing and toasts "This plan was deleted"; every
 * other row marks read, then opens its link (entityHref). Pure.
 */
export function openAction(
  item: ActivityItem,
  workspaceKey: string | null = null,
  side: ViewerSide = 'unknown',
): OpenAction {
  const href = entityHref(item, workspaceKey, side);
  if (item.alert?.kind === 'plan' && href === null) {
    return { href: null, markRead: true, toast: PLAN_DELETED_TOAST };
  }
  return { href, markRead: true, toast: null };
}

/**
 * Rows with nowhere to open, whose card is not tappable: a deleted post and
 * an idea moved to the bank read by a client (the agency's bank is not theirs
 * to open). Pure.
 */
export function opensNothing(
  item: Pick<ActivityItem, 'eventType'>,
  side: ViewerSide = 'unknown',
): boolean {
  if (isBankEvent(item.eventType) && !bankOpensFor(item.eventType, side)) return true;
  return item.eventType === 'post_deleted';
}

/**
 * Route to open when a row is clicked, or null when it has no detail surface.
 * An alert opens its chat, plan or task sheet (alertHref). Asset events have no post/brief entity: they deep-link to the asset lightbox via
 * the existing `?asset=` param. Post/brief comment events deep-link to the exact
 * comment via the existing `?comment=` param (consumed by PostDetailPage /
 * BriefDetailPage / AssetsPage already); a non-comment entry lands on the entity.
 */
export function entityHref(
  item: ActivityItem,
  workspaceKey: string | null = null,
  side: ViewerSide = 'unknown',
): string | null {
  if (item.alert != null) return alertHref(item, item.alert, side);
  if (isChatRow(item)) {
    // A reply in a thread opens its thread at that reply (the chat's jump).
    if (item.entityId === null) return null;
    return chatMessageHref(item.entityId, item.messageId);
  }
  if (item.eventType === 'asset_uploaded' || item.eventType === 'asset_version_added') {
    return item.assetId !== null ? `/assets?asset=${item.assetId}` : null;
  }
  // The assets are gone: open Assets itself. A deleted post has nowhere to go.
  if (item.eventType === 'assets_deleted') return '/assets';
  if (item.eventType === 'post_deleted') return null;
  if (isPlanEvent(item)) {
    // The plan in the Plan tab with the item open; a comment also scrolls to
    // it. A bank idea (no plan, scope_key 'bank') opens on the bank's route.
    if (item.entityId === null) return null;
    return planItemFocusHref({
      planId: item.planId ?? null,
      scopeKey: item.scopeKey ?? null,
      itemId: item.entityId,
      commentId: isPlanCommentRow(item) ? item.commentId : null,
    });
  }
  if (item.entityId === null) return null;
  if (item.entityType === 'post') {
    // Prefer the pretty link (/p/KEY-N) when the number and key are known; the
    // classic /posts/:id route stays a working fallback otherwise. The ?comment=
    // deep link is preserved on both forms (PostDetailPage reads it either way).
    const base =
      workspaceKey !== null && item.number !== null
        ? entityUrlPath('post', workspaceKey, item.number)
        : `/posts/${item.entityId}`;
    return item.commentId !== null ? `${base}?comment=${item.commentId}` : base;
  }
  if (item.entityType === 'brief') {
    const base =
      workspaceKey !== null && item.number !== null
        ? entityUrlPath('brief', workspaceKey, item.number)
        : `/briefs/${item.entityId}`;
    return item.commentId !== null ? `${base}?comment=${item.commentId}` : base;
  }
  return null;
}

/** Whether a row's link lands on a comment (?comment= / &comment=). Pure. */
export function hasCommentTarget(item: ActivityItem): boolean {
  return /[?&]comment=/.test(entityHref(item) ?? '');
}

/**
 * The entry a grouped card's head opens: the newest entry that links to a
 * comment (so a stage change on top never swallows the comment under it), else
 * the lead entry as before. Sub-row taps open their own entry. Pure.
 */
export function groupOpenEntry(group: readonly ActivityItem[]): ActivityItem | undefined {
  let target: ActivityItem | undefined;
  let targetMs = Number.NEGATIVE_INFINITY;
  for (const entry of group) {
    if (!hasCommentTarget(entry)) continue;
    const ms = Date.parse(entry.createdAt);
    const at = Number.isNaN(ms) ? Number.NEGATIVE_INFINITY : ms;
    if (target === undefined || at > targetMs) {
      target = entry;
      targetMs = at;
    }
  }
  return target ?? group[0];
}

/** A row is snoozed when its snoozed_until is in the future. */
export function isSnoozed(item: ActivityItem, nowMs: number): boolean {
  if (item.snoozedUntil === null) return false;
  const until = Date.parse(item.snoozedUntil);
  return !Number.isNaN(until) && until > nowMs;
}

/**
 * Apply the chip: All hides snoozed; Unread is unread + not snoozed;
 * Mentions is every mention (post, brief and chat; read AND unread) that is
 * not snoozed; Snoozed is only snoozed. Brief, plan, task and idea bank rows
 * have no chip of their own (All and Unread show them). Input order is
 * preserved, so a page stays in its sort order through the filter.
 */
export function filterByState(
  items: readonly ActivityItem[],
  state: ActivityState,
  nowMs: number,
): ActivityItem[] {
  switch (state) {
    case 'snoozed':
      return items.filter((item) => isSnoozed(item, nowMs));
    case 'unread':
      return items.filter((item) => item.readAt === null && !isSnoozed(item, nowMs));
    case 'mentions':
      return items.filter(
        (item) => item.eventType === MENTION_EVENT_TYPE && !isSnoozed(item, nowMs),
      );
    case 'all':
    default:
      return items.filter((item) => !isSnoozed(item, nowMs));
  }
}

/** The "Mark all read" action label; its failure toast derives from it. No success toast. */
export const MARKED_READ_LABEL = 'Marked as read';

/** A refresh that failed with rows already on screen (they stay). */
export const REFRESH_FAILED = errorText('refresh', null);

/** The loading line under the chips. */
export const LOADING_NOTIFICATIONS = 'Loading activity';

/** A bucket header's count: "1 update" / "N updates". Pure. */
export function updatesLabel(n: number): string {
  return `${n} ${n === 1 ? 'update' : 'updates'}`;
}

/** The one positive line each chip's empty state shows (All keeps its own). */
export const EMPTY_LINES = {
  unread: 'New updates show up here.',
  mentions: 'Mentions of you show up here.',
} as const;

/** The load error: plain copy, never the raw error. */
export const ACTIVITY_LOAD_FAILED = errorText('load activity', null);

/**
 * Whether a chip's Mark all read is the one workspace-wide inbox_mark_all_read
 * call: All, and Unread (which shows exactly what All marks). Pure.
 */
export function marksWholeInbox(state: ActivityState): boolean {
  return state === 'all' || state === 'unread';
}

/**
 * The entries "Mark all read" clears: the unread items the active chip shows
 * whose snooze is unset or has run out (snoozed_until <= now, as the server
 * marks them). Pure.
 */
export function markAllTargets(
  items: readonly ActivityItem[],
  state: ActivityState,
  nowMs: number,
): ActivityItem[] {
  return filterByState(items, state, nowMs).filter(
    (item) => item.readAt === null && !isSnoozed(item, nowMs),
  );
}

/** One segment of a mention preview: the current user's own @name (self) is set
 *  apart so the card can accent just that run and leave every other name plain. */
interface MentionSegment {
  text: string;
  self: boolean;
}

const NAME_CHAR = /[\p{L}\p{N}]/u;

/**
 * Split a resolved comment body into runs, marking the current user's own
 * `@<selfName>` occurrences so only those get accented. Pure string work on the
 * already-resolved body (no `@[uuid]` tokens remain): a match counts only at a
 * name boundary (the char before `@` and the char after the name are not
 * name characters), so `@Al` never lights up inside `@Alex`. A null/empty
 * selfName, or no match, yields a single non-self segment.
 */
export function segmentSelfMentions(body: string, selfName: string | null): MentionSegment[] {
  if (selfName === null || selfName.length === 0) return [{ text: body, self: false }];
  const token = `@${selfName}`;
  const segments: MentionSegment[] = [];
  let last = 0;
  let idx = body.indexOf(token);
  while (idx !== -1) {
    const beforeOk = idx === 0 || !NAME_CHAR.test(body[idx - 1] ?? '');
    const afterIdx = idx + token.length;
    const afterOk = afterIdx >= body.length || !NAME_CHAR.test(body[afterIdx] ?? '');
    if (beforeOk && afterOk) {
      if (idx > last) segments.push({ text: body.slice(last, idx), self: false });
      segments.push({ text: token, self: true });
      last = afterIdx;
      idx = body.indexOf(token, afterIdx);
    } else {
      idx = body.indexOf(token, idx + 1);
    }
  }
  if (last < body.length) segments.push({ text: body.slice(last), self: false });
  return segments.length > 0 ? segments : [{ text: body, self: false }];
}

/** Count of currently-unread, non-snoozed rows (drives the chip badge / button). */
export function unreadCount(items: readonly ActivityItem[], nowMs: number): number {
  return items.reduce(
    (n, item) => (item.readAt === null && !isSnoozed(item, nowMs) ? n + 1 : n),
    0,
  );
}

interface DigestBucket {
  key: 'today' | 'yesterday' | 'earlier';
  label: string;
  /** Threaded groups: a 1-entry group renders solo, a multi-entry group threads. */
  groups: ActivityItem[][];
}

/** The clock the digest groups by: now, and the workspace timezone (IANA; null uses the device's). */
interface DigestClock {
  nowMs: number;
  tz: string | null;
}

/** Calendar parts of an instant in a timezone; an unknown zone falls back to the device's. */
function zonedParts(ms: number, tz: string | null): ZonedParts {
  return readZonedParts(new Date(ms), tz);
}

/** The calendar day of an instant in a timezone, as a sortable "YYYY-MM-DD". Pure. */
export function zonedDayKey(ms: number, tz: string | null): string {
  return civilDay(ms, tz ?? undefined);
}

function dayKeyOf(utcMidnightMs: number): string {
  return new Date(utcMidnightMs).toISOString().slice(0, 10);
}

/** The day before a "YYYY-MM-DD" key. Pure. */
function previousDayKey(key: string): string {
  return dayKeyOf(Date.parse(`${key}T00:00:00Z`) - 86_400_000);
}

/** Milliseconds from `nowMs` to the next midnight in the timezone (at least one second). Pure. */
export function msUntilZonedMidnight(nowMs: number, tz: string | null): number {
  const p = zonedParts(nowMs, tz);
  const elapsed = (p.hour * 3600 + p.minute * 60 + p.second) * 1000;
  return Math.max(1000, 86_400_000 - elapsed - (nowMs % 1000));
}

/**
 * The threading key for an entry. Post/brief entries that share an entity collapse
 * into one thread; everything else (and any entry without an entity) stays solo so
 * it never threads with an unrelated row.
 */
export function entityKey(item: ActivityItem): string {
  // Idea bank alerts never combine: each is its own card.
  if (item.alert?.kind === 'bank') return `solo:${item.id}`;
  if (
    (item.entityType === 'post' ||
      item.entityType === 'brief' ||
      item.entityType === PLAN_ITEM_ENTITY) &&
    item.entityId !== null
  ) {
    return `${item.entityType}:${item.entityId}`;
  }
  return `solo:${item.id}`;
}

const newestFirst = (a: ActivityItem, b: ActivityItem): number =>
  Date.parse(b.createdAt) - Date.parse(a.createdAt);

/**
 * Thread one bucket's entries into per-entity groups, ordering both the entries
 * within each group and the groups themselves by `direction` (groups keyed on the
 * lead entry's timestamp). 'newest' leads with the newest entry/group.
 */
function threadGroups(bucket: ActivityItem[], direction: ActivityDirection): ActivityItem[][] {
  const byKey = new Map<string, ActivityItem[]>();
  for (const item of bucket) {
    const key = entityKey(item);
    const existing = byKey.get(key);
    if (existing) existing.push(item);
    else byKey.set(key, [item]);
  }
  const groups = [...byKey.values()].map((entries) => {
    const sorted = [...entries].sort(newestFirst);
    return direction === 'oldest' ? sorted.reverse() : sorted;
  });
  const leadMs = (group: ActivityItem[]): number => {
    const lead = group[0];
    return lead !== undefined ? Date.parse(lead.createdAt) : 0;
  };
  groups.sort((a, b) => leadMs(b) - leadMs(a));
  return direction === 'oldest' ? groups.reverse() : groups;
}

/**
 * Bucket items into Today / Yesterday / Earlier by the calendar day in the
 * workspace timezone (clock.tz) as of clock.nowMs, then thread each bucket into
 * per-entity groups. Buckets, groups and entries all follow `direction`.
 * 'newest' = Today -> Yesterday -> Earlier, newest first; 'oldest' reverses.
 * Empty dropped. Pure: it never reads the device clock.
 */
export function groupDigest(
  items: readonly ActivityItem[],
  direction: ActivityDirection,
  clock: DigestClock,
): DigestBucket[] {
  const todayKey = zonedDayKey(clock.nowMs, clock.tz);
  const yesterdayKey = previousDayKey(todayKey);

  const today: ActivityItem[] = [];
  const yesterday: ActivityItem[] = [];
  const earlier: ActivityItem[] = [];
  for (const item of items) {
    const t = Date.parse(item.createdAt);
    const key = Number.isNaN(t) ? null : zonedDayKey(t, clock.tz);
    if (key !== null && key >= todayKey) today.push(item);
    else if (key === yesterdayKey) yesterday.push(item);
    else earlier.push(item);
  }

  const buckets: DigestBucket[] = [
    { key: 'today', label: 'Today', groups: threadGroups(today, direction) },
    { key: 'yesterday', label: 'Yesterday', groups: threadGroups(yesterday, direction) },
    { key: 'earlier', label: 'Earlier', groups: threadGroups(earlier, direction) },
  ];
  const ordered = direction === 'oldest' ? buckets.reverse() : buckets;
  return ordered.filter((bucket) => bucket.groups.length > 0);
}

// --- network -----------------------------------------------------------------

/** A keyset position: the last loaded row's (created_at, id). */
export interface ActivityCursor {
  createdAt: string;
  id: string;
}

/** One page request: the chip, the sort direction, and the cursor for a next page. */
interface ActivityPageInput {
  state?: ActivityState;
  direction?: ActivityDirection;
  cursor?: ActivityCursor;
  /** The snooze cut-off; defaults to now. */
  nowIso?: string;
  /**
   * Rows per page; defaults to ACTIVITY_PAGE_SIZE. The Activity screen (and
   * the bell's prefetch of its page one) pass the screen's fill count
   * (getFillCount, sync), so page one and every Load more fill one screen.
   */
  pageSize?: number;
}

/** The cursor after a page: its last row's (created_at, id); undefined for an empty list. Pure. */
export function cursorAfter(items: readonly ActivityItem[]): ActivityCursor | undefined {
  const last = items[items.length - 1];
  return last !== undefined ? { createdAt: last.createdAt, id: last.id } : undefined;
}

/**
 * The PostgREST .or() filter for the rows after `cursor` in the sort order:
 * (created_at, id) strictly below it newest-first, strictly above it oldest-first,
 * so rows sharing a timestamp are never skipped. Values are quoted. Pure.
 */
export function keysetFilter(cursor: ActivityCursor, ascending: boolean): string {
  const op = ascending ? 'gt' : 'lt';
  const at = `"${cursor.createdAt}"`;
  return `created_at.${op}.${at},and(created_at.eq.${at},id.${op}.${cursor.id})`;
}

/** Append a page to the loaded rows, dropping any id already loaded. Pure. */
export function appendUnique(
  items: readonly ActivityItem[],
  page: readonly ActivityItem[],
): ActivityItem[] {
  const seen = new Set(items.map((item) => item.id));
  return [...items, ...page.filter((item) => !seen.has(item.id))];
}

/**
 * Merge a fresh page one into the loaded rows: a fresh copy replaces the row
 * with its id, new ids join, and the whole list is re-sorted by (created_at, id)
 * in `direction`. No duplicates. Pure.
 */
export function mergeFresh(
  items: readonly ActivityItem[],
  fresh: readonly ActivityItem[],
  direction: ActivityDirection,
): ActivityItem[] {
  const byId = new Map(items.map((item) => [item.id, item]));
  for (const item of fresh) byId.set(item.id, item);
  const sign = direction === 'oldest' ? 1 : -1;
  return [...byId.values()].sort((a, b) => {
    const diff = Date.parse(a.createdAt) - Date.parse(b.createdAt);
    if (diff !== 0) return sign * diff;
    return sign * (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  });
}

export type LoadResult = { ok: true; data: ActivityItem[] } | { ok: false; error: string };

/** One page of inbox rows when the caller names no pageSize (the screen passes
 * its fill count). The live writer emits minimal payloads, so author and
 * title are resolved by join (see fetchActivityEntries), never read from payload. */
export const ACTIVITY_PAGE_SIZE = 50;

/** Event types whose actor is the comment author, resolved via the comments join.
 *  comment_resolved is intentionally absent: its actor is the resolver (not the
 *  comment author) and is not carried in the minimal payload, so it renders
 *  actor-less. The comment deep-link still works off the payload comment_id. */
const COMMENT_EVENTS = ['comment', 'mention'];

const SELECT_COLS =
  'id, workspace_id, user_id, event_type, entity_type, entity_id, scope, tier, created_at, read_at, snoozed_until, payload, actor_user_id';

// One row of the batched first-image lookup, mirroring the Pipeline loader's
// firstImageByPost (packages/posts/src/reads.ts): an asset_attachments row with
// its pinned version's mime_type embedded via an inner join (so only image-backed
// attachments survive). The aliased select is wider than the generated row type
// can express, so the result is cast through `unknown`.
interface FirstImageRow {
  entity_id: string;
  asset_version_id: string;
  asset_versions: { mime_type: string | null } | null;
}

/** A chat row's chat: its kind, and the Sorted group id for a group. */
interface ChatRowChannel {
  /** 'dm' also for the Personal notes chat. */
  type: 'group' | 'dm';
  groupId: string | null;
}

/**
 * The chats and messages behind a page's chat rows (mentions, task alerts):
 * one chat_channels IN read and the chat_messages IN read (RLS: members
 * only), in parallel. Each is best-effort; a failure leaves its map empty (the
 * row degrades, never fails).
 */
async function readChatSources(
  client: Client,
  ids: { channelIds: string[]; messageIds: string[] },
): Promise<{
  channels: Map<string, ChatRowChannel>;
  messages: Map<string, ChatMessagePreview>;
}> {
  const [channelsRes, messages] = await Promise.all([
    ids.channelIds.length > 0
      ? client
          .from('chat_channels')
          .select('channel_id, channel_type, entity_id')
          .in('channel_id', ids.channelIds)
      : Promise.resolve(null),
    readChatMessages(client, ids.messageIds),
  ]);
  const channels = new Map<string, ChatRowChannel>();
  if (channelsRes !== null && channelsRes.error === null) {
    for (const r of channelsRes.data ?? []) {
      const type = r.channel_type === 'group' ? 'group' : 'dm';
      channels.set(r.channel_id, { type, groupId: type === 'group' ? r.entity_id : null });
    }
  }
  return { channels, messages };
}

/** One plan item as the Activity card needs it. */
interface PlanItemInfo {
  /** Null for an idea in the workspace's idea bank. */
  planId: string | null;
  kind: string;
  title: string | null;
  postId: string | null;
}

/**
 * The plan items, plan titles and plan comment bodies behind a page's plan
 * events: one plan_items IN read, one plans IN read and one plan_item_comments
 * IN read (RLS hides what the viewer may not see), in parallel. Comment bodies
 * come only from plan_item_comments, never from comments. Each is best-effort;
 * a failure leaves its map empty (the row degrades, never fails).
 */
async function readPlanSources(
  client: Client,
  ids: { itemIds: string[]; planIds: string[]; commentIds: string[] },
): Promise<{
  items: Map<string, PlanItemInfo>;
  planTitles: Map<string, string>;
  comments: Map<string, { authorId: string | null; body: string }>;
}> {
  const [itemsRes, plansRes, commentsRes] = await Promise.all([
    ids.itemIds.length > 0
      ? client
          .from('plan_items')
          .select('id, plan_id, kind, title, post_id')
          .in('id', ids.itemIds)
          .is('deleted_at', null)
      : Promise.resolve(null),
    ids.planIds.length > 0
      ? client.from('plans').select('id, title').in('id', ids.planIds).is('deleted_at', null)
      : Promise.resolve(null),
    ids.commentIds.length > 0
      ? client
          .from('plan_item_comments')
          .select('id, author_user_id, body')
          .in('id', ids.commentIds)
          .is('deleted_at', null)
      : Promise.resolve(null),
  ]);
  const items = new Map<string, PlanItemInfo>();
  if (itemsRes !== null && itemsRes.error === null) {
    for (const r of itemsRes.data ?? []) {
      items.set(r.id, { planId: r.plan_id, kind: r.kind, title: r.title, postId: r.post_id });
    }
  }
  const planTitles = new Map<string, string>();
  if (plansRes !== null && plansRes.error === null) {
    for (const r of plansRes.data ?? []) planTitles.set(r.id, r.title);
  }
  const comments = new Map<string, { authorId: string | null; body: string }>();
  if (commentsRes !== null && commentsRes.error === null) {
    for (const r of commentsRes.data ?? []) {
      if (typeof r.body === 'string')
        comments.set(r.id, { authorId: r.author_user_id, body: r.body });
    }
  }
  return { items, planTitles, comments };
}

/** A thread start's card title from the batched reads; null while unknown (the line falls back to the chat). */
function threadCardTitle(
  item: Pick<ActivityItem, 'cardKind' | 'cardId'>,
  from: {
    postTitles: ReadonlyMap<string, string>;
    briefTitles: ReadonlyMap<string, string>;
    planTitles: ReadonlyMap<string, string>;
    planItems: ReadonlyMap<string, PlanItemInfo>;
  },
): string | null {
  const id = item.cardId ?? null;
  if (id === null) return null;
  switch (item.cardKind) {
    case 'post':
      return from.postTitles.get(id) ?? null;
    case 'brief':
      return from.briefTitles.get(id) ?? null;
    case 'plan':
      return from.planTitles.get(id) ?? null;
    case 'item': {
      const info = from.planItems.get(id);
      if (info === undefined) return null;
      if (info.kind === 'post')
        return info.postId !== null ? (from.postTitles.get(info.postId) ?? null) : null;
      return info.title !== null && info.title !== '' ? info.title : null;
    }
    default:
      return null;
  }
}

/** Group names by id, one IN read; empty on failure or no ids. */
async function readGroupNames(client: Client, groupIds: string[]): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  if (groupIds.length === 0) return names;
  const res = await client.from('groups').select('id, name').in('id', groupIds);
  if (res.error === null) for (const r of res.data ?? []) names.set(r.id, r.name);
  return names;
}

/** What the loader's batched reads resolved, for filling an alert's fields. */
interface AlertSources {
  channels: ReadonlyMap<string, ChatRowChannel>;
  groupNames: ReadonlyMap<string, string>;
  planItems: ReadonlyMap<string, PlanItemInfo>;
  planTitles: ReadonlyMap<string, string>;
  postTitles: ReadonlyMap<string, string>;
}

/**
 * Fill an alert's resolved fields from the batched reads: its group chat's
 * name, a plan alert's plan and item titles. A field whose read failed stays
 * empty and the row still renders.
 */
function stitchAlert(alert: AlertInfo, from: AlertSources): void {
  const channel = alert.channelId !== null ? from.channels.get(alert.channelId) : undefined;
  alert.chatName = channel?.groupId != null ? (from.groupNames.get(channel.groupId) ?? null) : null;
  if (alert.plan !== undefined) {
    const f = alert.plan;
    alert.planTitle =
      f.planTitle ?? (f.planId !== null ? (from.planTitles.get(f.planId) ?? null) : null);
    const info = f.itemId !== null ? from.planItems.get(f.itemId) : undefined;
    const postId = info?.postId ?? f.postId;
    alert.itemTitle =
      f.itemTitle ??
      (info !== undefined && info.kind !== 'post' && info.title !== null && info.title !== ''
        ? info.title
        : null) ??
      (postId !== null ? (from.postTitles.get(postId) ?? null) : null);
  }
}

/**
 * One page of inbox rows in `ascending` order through partition-bounded
 * windows: newest-first walks back from the cursor (or now) to the inbox's
 * oldest entry; oldest-first walks forward from the cursor (or the oldest
 * entry) to now. Either way every entry is reachable. The oldest entry is
 * read at most once per page, and only when a window comes back short (or
 * an oldest-first page has no cursor).
 */
async function readInboxPage(
  client: Client,
  workspaceId: string,
  opts: {
    ascending: boolean;
    cursor: ActivityCursor | undefined;
    pageSize: number;
    readWindow: (bounds: TimeBounds, limit: number) => Promise<Result<InboxEntryRow[]>>;
  },
): Promise<Result<InboxEntryRow[]>> {
  const { ascending, cursor, pageSize, readWindow } = opts;
  if (!ascending) {
    return readBoundedPage<InboxEntryRow>({
      pageSize,
      upper: cursor !== undefined ? cursor.createdAt : upperFromNow(),
      upperInclusive: cursor !== undefined,
      openEnded: cursor === undefined,
      oldest: () => readInboxOldest(client, workspaceId),
      read: readWindow,
    });
  }
  let lower = cursor?.createdAt;
  if (lower === undefined) {
    const oldest = await readInboxOldest(client, workspaceId);
    if (!oldest.ok) return oldest;
    if (oldest.data === null) return { ok: true, data: [] };
    lower = oldest.data;
  }
  return readBoundedForward<InboxEntryRow>({
    pageSize,
    lower,
    read: readWindow,
  });
}

/**
 * Read one page of the caller's inbox for a workspace and enrich each row with the
 * data the live (minimal) payloads omit: the actor's display name and the entity
 * title, both resolved by batched joins (no N+1). One RLS-scoped select, then wave
 * one (comments / posts / briefs by id) and wave two (users by id). Every join is
 * best-effort: a failed sub-query leaves its field null rather than failing the
 * feed. Soft-deleted rows are excluded; the inbox is a permanent surface. Every
 * row shows, the plan, task and idea bank alerts included (their chats and
 * plan titles join in the same batched waves). Rows are
 * ordered by (created_at, id) in `direction` (newest first by default) on the
 * server; pass `cursor` (the last loaded row's pair, cursorAfter) to fetch the
 * next page in that same direction. Pass `state` to filter server-side to the
 * active chip (Unread, Mentions, Snoozed; All has no filter),
 * so older matches are never hidden behind the page cap. `nowIso` is
 * the snooze cut-off (defaults to now). The page is read through
 * partition-bounded windows (readInboxPage), so only recent months are opened.
 */
export async function fetchActivityEntries(
  client: Client,
  workspaceId: string,
  input: ActivityPageInput = {},
): Promise<LoadResult> {
  const nowIso = input.nowIso ?? new Date().toISOString();
  const ascending = input.direction === 'oldest';
  const cursor = input.cursor;
  // One partition-bounded window of the page (see bounded-window.ts).
  const readWindow = async (
    bounds: TimeBounds,
    limit: number,
  ): Promise<Result<InboxEntryRow[]>> => {
    mark('activity:inbox-window');
    const base = client
      .from('inbox_entries')
      .select(SELECT_COLS)
      .eq('workspace_id', workspaceId)
      .is('deleted_at', null)
      .not('event_type', 'in', RETIRED_EVENT_LIST)
      .gte('created_at', bounds.from);
    const capped =
      bounds.to === null
        ? base
        : bounds.toInclusive
          ? base.lte('created_at', bounds.to)
          : base.lt('created_at', bounds.to);
    const typed =
      input.state === 'mentions'
        ? capped.eq('event_type', MENTION_EVENT_TYPE)
        : input.state === 'unread'
          ? capped.is('read_at', null).or(`snoozed_until.is.null,snoozed_until.lte.${nowIso}`)
          : input.state === 'snoozed'
            ? capped.gt('snoozed_until', nowIso)
            : capped;
    const scoped = cursor !== undefined ? typed.or(keysetFilter(cursor, ascending)) : typed;
    const res = await scoped
      .order('created_at', { ascending })
      .order('id', { ascending })
      .limit(limit);
    if (res.error) return { ok: false, error: { code: 'unknown', message: res.error.message } };
    return { ok: true, data: (res.data ?? []).map((row) => row as InboxEntryRow) };
  };
  const pageSize = Math.max(1, Math.floor(input.pageSize ?? ACTIVITY_PAGE_SIZE));
  const read = await readInboxPage(client, workspaceId, {
    ascending,
    cursor,
    pageSize,
    readWindow,
  });
  if (!read.ok) return { ok: false, error: read.error.message };
  return enrichInboxRows(client, workspaceId, read.data);
}

/**
 * One entry by id, mapped and enriched like a page row: catch up opened by a
 * link to an entry the screen does not hold (a refresh, a deep link). One
 * RLS-scoped select by id, then the page's batched waves. ok with null when it
 * is gone or not the caller's.
 */
export async function fetchActivityEntry(
  client: Client,
  workspaceId: string,
  entryId: string,
): Promise<{ ok: true; data: ActivityItem | null } | { ok: false; error: string }> {
  const res = await client
    .from('inbox_entries')
    .select(SELECT_COLS)
    .eq('workspace_id', workspaceId)
    .eq('id', entryId)
    .is('deleted_at', null)
    .limit(1);
  if (res.error) return { ok: false, error: res.error.message };
  const rows = (res.data ?? []).map((row) => row as InboxEntryRow);
  if (rows.length === 0) return { ok: true, data: null };
  const enriched = await enrichInboxRows(client, workspaceId, rows);
  if (!enriched.ok) return enriched;
  return { ok: true, data: enriched.data[0] ?? null };
}

/**
 * The feed's one mapping path: map inbox rows (mapEntry) and resolve what the
 * minimal payloads omit (actor names, titles, previews, thumbnails) in batched
 * waves, never one read per row.
 */
async function enrichInboxRows(
  client: Client,
  workspaceId: string,
  rows: readonly InboxEntryRow[],
): Promise<LoadResult> {
  const items = rows.map(mapEntry);
  // Loudly surface any event_type the app does not know (never blank-renders it).
  for (const et of unique(items.map((item) => item.eventType))) warnUnknownEventType(et);

  const commentIds = unique(
    items.flatMap((item) =>
      COMMENT_EVENTS.includes(item.eventType) && !isPlanMention(item) && item.commentId !== null
        ? [item.commentId]
        : [],
    ),
  );
  const postIds = unique(
    items.flatMap((item) =>
      item.entityType === 'post' && item.entityId !== null ? [item.entityId] : [],
    ),
  );
  // Thread starts name their card: its title joins the posts, briefs and plan reads below.
  const threadStarts = items.filter(isThreadStarted);
  const threadCardIds = (kind: ThreadCardKind): string[] =>
    threadStarts.flatMap((i) => (i.cardKind === kind && i.cardId != null ? [i.cardId] : []));
  const briefIds = unique([
    ...items.flatMap((item) =>
      item.entityType === 'brief' && item.entityId !== null ? [item.entityId] : [],
    ),
    ...threadCardIds('brief'),
  ]);
  // The distinct feedback-point batch ids on the page. Every point in one batch
  // shares a single author, so one IN query (below) resolves author + preview for
  // all of them (no per-batch fetch).
  const batchIds = unique(
    items.flatMap((item) =>
      item.eventType === 'checkpoints_added' && item.batchId !== null ? [item.batchId] : [],
    ),
  );
  // Chat rows (mentions and the chat alerts): the chats (kind + group), one IN
  // read; the messages a mention previews, one IN read.
  const chatMentions = items.filter(isChatMention);
  const alerts = items.flatMap((i) => (i.alert != null ? [i.alert] : []));
  const channelIds = unique([
    ...items.filter(isChatRow).flatMap((i) => (i.entityId !== null ? [i.entityId] : [])),
    ...alerts.flatMap((alert) => (alert.channelId !== null ? [alert.channelId] : [])),
  ]);
  const messageIds = unique(
    chatMentions.flatMap((i) => (i.messageId !== null ? [i.messageId] : [])),
  );
  // Plan events and plan alerts: the items, the plans and the plan comments,
  // one IN read each, alongside the chat reads (the posts read below needs the
  // post items' ids). An alert reads only the titles its payload lacks.
  const planEvents = items.filter(isPlanEvent);
  const planAlerts = alerts.flatMap((alert) => (alert.plan !== undefined ? [alert.plan] : []));
  // Every join starts at once: the chat and plan reads alongside
  // the comments, briefs, first-image and batch reads (none needs another's
  // answer). Only the posts read waits, for the plan reads alone: a post item
  // names its post there, and the one posts read covers both.
  const chatSources = readChatSources(client, { channelIds, messageIds });
  const planSources = readPlanSources(client, {
    itemIds: unique([
      ...planEvents.flatMap((i) => (i.entityId !== null ? [i.entityId] : [])),
      ...planAlerts.flatMap((f) => (f.itemTitle === null && f.itemId !== null ? [f.itemId] : [])),
      ...threadCardIds('item'),
    ]),
    planIds: unique([
      ...planEvents.flatMap((i) => (i.planId != null ? [i.planId] : [])),
      ...planAlerts.flatMap((f) => (f.planTitle === null && f.planId !== null ? [f.planId] : [])),
      ...threadCardIds('plan'),
    ]),
    commentIds: unique(
      planEvents.flatMap((i) => (isPlanCommentRow(i) && i.commentId !== null ? [i.commentId] : [])),
    ),
  });
  // A post item's title is its post's (and a plan alert may name its post
  // directly): folded into the one posts read.
  const postsRead = planSources.then(async (planRes) => {
    const planPostIds = unique([
      ...[...planRes.items.values()].flatMap((info) =>
        info.kind === 'post' && info.postId !== null ? [info.postId] : [],
      ),
      ...planAlerts.flatMap((f) => (f.itemTitle === null && f.postId !== null ? [f.postId] : [])),
    ]);
    const postReadIds = unique([...postIds, ...planPostIds, ...threadCardIds('post')]);
    if (postReadIds.length === 0) return null;
    return await client
      .from('posts')
      .select('id, title, format, caption, number')
      .in('id', postReadIds);
  });

  // WAVE 1: resolve comment authors and entity titles. Each sub-query is fired
  // only when it has ids; a failed one yields an empty map (never fails the feed).
  // The first-image read mirrors the Pipeline loader's firstImageByPost exactly
  // (asset_attachments, image-mime inner join, position then attached_at order),
  // run once over the distinct post ids on the page (no N+1); a failure degrades
  // every thumbnailAssetVersionId to null rather than failing the feed.
  const [chatRes, planRes, commentsRes, postsRes, briefsRes, firstImagesRes, batchCommentsRes] =
    await Promise.all([
      chatSources,
      planSources,
      commentIds.length > 0
        ? client.from('comments').select('id, author_user_id, body').in('id', commentIds)
        : Promise.resolve(null),
      postsRead,
      briefIds.length > 0
        ? client.from('briefs').select('id, title, number').in('id', briefIds)
        : Promise.resolve(null),
      postIds.length > 0
        ? client
            .from('asset_attachments')
            .select('entity_id, asset_version_id, asset_versions!inner(mime_type)')
            .eq('entity_type', 'post')
            .in('entity_id', postIds)
            .is('deleted_at', null)
            .like('asset_versions.mime_type', 'image/%')
            .order('entity_id', { ascending: true })
            .order('position', { ascending: true })
            .order('attached_at', { ascending: true })
        : Promise.resolve(null),
      batchIds.length > 0
        ? client
            .from('comments')
            .select('author_user_id, body, ledger_seq, ledger_batch_id')
            .in('ledger_batch_id', batchIds)
            .order('ledger_seq', { ascending: true })
        : Promise.resolve(null),
    ]);
  mark('activity:wave1');

  const commentAuthors = new Map<string, string>();
  const commentBodies = new Map<string, string>();
  if (commentsRes !== null && commentsRes.error === null) {
    for (const r of commentsRes.data ?? []) {
      commentAuthors.set(r.id, r.author_user_id);
      if (typeof r.body === 'string') commentBodies.set(r.id, r.body);
    }
  }
  const postTitles = new Map<string, string>();
  const postFormats = new Map<string, string>();
  const postCaptions = new Map<string, string>();
  const postNumbers = new Map<string, number>();
  if (postsRes !== null && postsRes.error === null) {
    for (const r of postsRes.data ?? []) {
      postTitles.set(r.id, r.title);
      if (typeof r.format === 'string') postFormats.set(r.id, r.format);
      if (typeof r.caption === 'string') postCaptions.set(r.id, r.caption);
      if (typeof r.number === 'number') postNumbers.set(r.id, r.number);
    }
  }
  // The first-image asset_version_id per post: the lowest-position image-mime
  // attachment, the first row seen per entity_id (rows arrive grouped + ordered).
  const postThumbnails = new Map<string, string>();
  if (firstImagesRes !== null && firstImagesRes.error === null) {
    const imageRows = (firstImagesRes.data ?? []) as unknown as FirstImageRow[];
    for (const r of imageRows) {
      if (!postThumbnails.has(r.entity_id)) postThumbnails.set(r.entity_id, r.asset_version_id);
    }
  }
  const briefTitles = new Map<string, string>();
  const briefNumbers = new Map<string, number>();
  if (briefsRes !== null && briefsRes.error === null) {
    for (const r of briefsRes.data ?? []) {
      briefTitles.set(r.id, r.title);
      if (typeof r.number === 'number') briefNumbers.set(r.id, r.number);
    }
  }
  // The author and preview body of each feedback-point batch: the first (lowest
  // ledger_seq) comment in the batch. Rows arrive ordered by ledger_seq, so the
  // first row seen per batch id wins. A batch with no readable rows (RLS-hidden or
  // missing) simply never enters the maps and degrades to actor-less / bodyless.
  const batchAuthors = new Map<string, string>();
  const batchBodies = new Map<string, string>();
  if (batchCommentsRes !== null && batchCommentsRes.error === null) {
    for (const r of batchCommentsRes.data ?? []) {
      if (r.ledger_batch_id === null || batchAuthors.has(r.ledger_batch_id)) continue;
      batchAuthors.set(r.ledger_batch_id, r.author_user_id);
      if (typeof r.body === 'string') batchBodies.set(r.ledger_batch_id, r.body);
    }
  }

  // WAVE 2: resolve every person the page names (comment authors, actorId,
  // on-behalf clients and every mentioned id) in one batched read through the
  // shared name registry: users + workspace_members, one .in() each. A person a
  // successful read found without a current membership reads "Former member";
  // anyone not resolved (a failed read) names nobody, never "Former member".
  const userIds = unique([
    ...items
      .flatMap((item) =>
        COMMENT_EVENTS.includes(item.eventType) && !isPlanMention(item) && item.commentId !== null
          ? [commentAuthors.get(item.commentId)]
          : [],
      )
      .filter((id): id is string => typeof id === 'string'),
    ...items.flatMap((item) => (item.actorId !== null ? [item.actorId] : [])),
    ...items.flatMap((item) => (item.onBehalfOfId != null ? [item.onBehalfOfId] : [])),
    ...[...commentBodies.values()].flatMap((body) => parseMentions(body)),
    ...batchAuthors.values(),
    ...[...batchBodies.values()].flatMap((body) => parseMentions(body)),
    ...[...chatRes.messages.values()].flatMap((m) => parseMentions(m.body ?? '')),
    ...[...planRes.comments.values()].flatMap((c) =>
      c.authorId !== null ? [c.authorId, ...parseMentions(c.body)] : parseMentions(c.body),
    ),
  ]);
  const groupIds = unique(
    [...chatRes.channels.values()].flatMap((c) => (c.groupId !== null ? [c.groupId] : [])),
  );
  const [, groupNames] = await Promise.all([
    resolvePeople(client, workspaceId, userIds),
    readGroupNames(client, groupIds),
  ]);
  mark('activity:wave2');
  const nameOf = (id: string): string | null => personName(workspaceId, id) ?? null;
  // What a mention inside a body reads as: "@username", or "Former member".
  const mentionOf = (body: string): string => resolvePersonMentionText(body, workspaceId);
  // A chat message's mentions, as the chat names them.
  const chatNames = mentionNamesIn(workspaceId);

  // STITCH: fill actorName and the resolved entity title from the joins above.
  items.forEach((item, idx) => {
    const payload: unknown = rows[idx]?.payload as Json | undefined;

    // Resolve the actor id for this event, then map it to a name + avatar in one
    // place so both stay in sync. Comment events take the comment author; brief and
    // invite events take their payload-supplied id; everything else has no actor.
    let actorUserId: string | null = null;
    if (isChatMention(item)) {
      // The sender, carried on the row; the chat's kind and group name by join.
      actorUserId = item.actorId;
      const channel = item.entityId !== null ? chatRes.channels.get(item.entityId) : undefined;
      item.channelType = channel?.type ?? null;
      item.title = channel?.groupId != null ? (groupNames.get(channel.groupId) ?? null) : null;
      item.chatName = item.title;
      const body =
        item.messageId !== null ? (chatRes.messages.get(item.messageId)?.body ?? null) : null;
      item.body = chatMentionPreview(body, chatNames);
    } else if (isThreadStarted(item)) {
      // The replier, carried on the row; the chat by join; the card title from
      // the posts, briefs and plan reads (no read of its own).
      actorUserId = item.actorId;
      const channel = item.entityId !== null ? chatRes.channels.get(item.entityId) : undefined;
      item.channelType = channel?.type ?? null;
      item.chatName = channel?.groupId != null ? (groupNames.get(channel.groupId) ?? null) : null;
    } else if (item.alert != null) {
      // Every alert names its own actor.
      actorUserId = item.actorId;
    } else if (COMMENT_EVENTS.includes(item.eventType) && !isPlanMention(item)) {
      actorUserId =
        (item.commentId !== null ? (commentAuthors.get(item.commentId) ?? null) : null) ??
        item.actorId;
    } else if (ROW_ACTOR_EVENTS.has(item.eventType) || item.eventType === 'invite') {
      // The row's actor_user_id (brief_created / invite fall back to the payload id).
      actorUserId = item.actorId;
    } else if (item.eventType === 'checkpoints_added') {
      // Every point in a batch shares one author; take it from the batch join.
      actorUserId =
        (item.batchId !== null ? (batchAuthors.get(item.batchId) ?? null) : null) ?? item.actorId;
    } else if (ACTOR_ROW_EVENTS.has(item.eventType)) {
      // Approve / reject / park / review and the deletes: the row's own actor.
      actorUserId = item.actorId;
    } else if (isPlanEvent(item)) {
      // The row's own actor; a plan comment (or mention) falls back to its author.
      const comment =
        isPlanCommentRow(item) && item.commentId !== null
          ? planRes.comments.get(item.commentId)
          : undefined;
      actorUserId = item.actorId ?? comment?.authorId ?? null;
    }
    item.actorId = actorUserId;
    item.actorName =
      item.own === true ? SELF_ACTOR : actorUserId !== null ? nameOf(actorUserId) : null;
    item.actorAvatarUrl = actorUserId !== null ? personAvatar(workspaceId, actorUserId) : null;
    item.onBehalfOfName = item.onBehalfOfId != null ? nameOf(item.onBehalfOfId) : null;
    if (isChatMention(item)) return;
    if (isThreadStarted(item)) {
      item.title = threadCardTitle(item, {
        postTitles,
        briefTitles,
        planTitles: planRes.planTitles,
        planItems: planRes.items,
      });
      item.body = null;
      item.format = null;
      item.caption = null;
      item.thumbnailAssetVersionId = null;
      item.number = null;
      return;
    }

    if (item.alert != null) {
      stitchAlert(item.alert, {
        channels: chatRes.channels,
        groupNames,
        planItems: planRes.items,
        planTitles: planRes.planTitles,
        postTitles,
      });
      item.title = null;
      item.format = null;
      item.caption = null;
      item.thumbnailAssetVersionId = null;
      item.number = null;
      return;
    }

    if (isPlanEvent(item)) {
      // Card title: the item's title (a concept's own, a post item's post title).
      const info = item.entityId !== null ? planRes.items.get(item.entityId) : undefined;
      item.title =
        info === undefined
          ? null
          : info.kind === 'post'
            ? info.postId !== null
              ? (postTitles.get(info.postId) ?? null)
              : null
            : info.title !== ''
              ? info.title
              : null;
      item.planTitle = item.planId != null ? (planRes.planTitles.get(item.planId) ?? null) : null;
      const comment =
        isPlanCommentRow(item) && item.commentId !== null
          ? planRes.comments.get(item.commentId)
          : undefined;
      item.body = comment !== undefined ? mentionOf(comment.body) : null;
      item.format = null;
      item.caption = null;
      item.thumbnailAssetVersionId = null;
      item.number = null;
      return;
    }

    // The preview body: a comment OR mention event shows its comment text (the
    // mention's comment_id is already joined via COMMENT_EVENTS, so this adds no
    // fetch); a checkpoints_added event shows the first point in the batch. Mention
    // tokens resolve to @Name here so the card never prints a raw @[uuid]; the same
    // resolution the thread applies.
    const rawBody =
      (item.eventType === 'comment' || item.eventType === MENTION_EVENT_TYPE) &&
      item.commentId !== null
        ? (commentBodies.get(item.commentId) ?? null)
        : item.eventType === 'checkpoints_added' && item.batchId !== null
          ? (batchBodies.get(item.batchId) ?? null)
          : null;
    item.body = rawBody !== null ? mentionOf(rawBody) : null;

    if (item.entityType === 'post') {
      // A deleted post is gone from the posts read: its payload carries the
      // number and title the writer captured.
      const deleted = item.eventType === 'post_deleted';
      item.title =
        (item.entityId !== null ? (postTitles.get(item.entityId) ?? null) : null) ??
        (deleted ? payloadStr(payload, 'title') : null);
      item.format = item.entityId !== null ? (postFormats.get(item.entityId) ?? null) : null;
      item.caption = item.entityId !== null ? (postCaptions.get(item.entityId) ?? null) : null;
      item.thumbnailAssetVersionId =
        item.entityId !== null ? (postThumbnails.get(item.entityId) ?? null) : null;
      item.number =
        (item.entityId !== null ? (postNumbers.get(item.entityId) ?? null) : null) ??
        (deleted ? payloadNum(payload, 'number') : null);
    } else if (item.entityType === 'brief') {
      const fromJoin = item.entityId !== null ? briefTitles.get(item.entityId) : undefined;
      item.title = fromJoin ?? payloadStr(payload, 'title') ?? null;
      item.format = null;
      item.caption = null;
      item.thumbnailAssetVersionId = null;
      item.number = item.entityId !== null ? (briefNumbers.get(item.entityId) ?? null) : null;
    } else if (item.eventType === 'asset_uploaded') {
      item.title = payloadStr(payload, 'filename');
      item.format = null;
      item.caption = null;
      item.thumbnailAssetVersionId = null;
      item.number = null;
    } else {
      item.title = null;
      item.format = null;
      item.caption = null;
      item.thumbnailAssetVersionId = null;
      item.number = null;
    }
  });

  return { ok: true, data: items };
}

/** Clear read_at on one entry (the caller's own, within its month partition). */
export function markEntryRead(
  client: Client,
  item: ActivityItem,
  workspaceId: string,
  traceId: string,
): Promise<Result<undefined>> {
  return inboxMarkRead(client, {
    p_entry_id: item.id,
    p_workspace_id: workspaceId,
    p_created_at: item.createdAt,
    p_trace_id: traceId,
  });
}

/** Mark every unread, non-snoozed entry read (workspace-wide). */
export function markAllEntriesRead(
  client: Client,
  workspaceId: string,
  traceId: string,
): Promise<Result<undefined>> {
  return inboxMarkAllRead(client, { p_workspace_id: workspaceId, p_trace_id: traceId });
}

/** The most ids one inbox_mark_read_ids call takes (the proc rejects more). */
export const MARK_READ_BATCH = 500;

/** A chip whose Mark all read covers every matching row on the server, loaded or not. */
type ChipMarkState = 'mentions';

/** Whether a chip's Mark all read pages through the server (Mentions). Pure. */
export function marksChipOnServer(state: ActivityState): state is ChipMarkState {
  return state === 'mentions';
}

/** One page (up to 500) of a chip's unread, unsnoozed ids, in id order after `after`. */
async function readChipUnreadIds(
  client: Client,
  input: { workspaceId: string; state: ChipMarkState; nowIso: string },
  after: string | null,
): Promise<Result<string[]>> {
  const base = client
    .from('inbox_entries')
    .select('id')
    .eq('workspace_id', input.workspaceId)
    .is('read_at', null)
    .is('deleted_at', null)
    .or(`snoozed_until.is.null,snoozed_until.lte.${input.nowIso}`);
  const typed = base.eq('event_type', MENTION_EVENT_TYPE);
  const page = after !== null ? typed.gt('id', after) : typed;
  const res = await page.order('id', { ascending: true }).limit(MARK_READ_BATCH);
  if (res.error) return { ok: false, error: { code: 'unknown', message: res.error.message } };
  return { ok: true, data: (res.data ?? []).map((row) => row.id) };
}

/**
 * Mark every unread row a chip matches read, loaded or not: unread, not deleted,
 * and not snoozed (or a snooze that has run out). Reads the matching ids 500 at
 * a time by id (one read per batch) and marks each batch with one
 * inbox_mark_read_ids call carrying the explicit trace id. Stops at the first
 * failure; the batches before it stay saved. Resolves to how many ids it sent.
 */
export async function markChipRead(
  client: Client,
  input: { workspaceId: string; state: ChipMarkState; traceId: string },
): Promise<Result<number>> {
  const read = {
    workspaceId: input.workspaceId,
    state: input.state,
    nowIso: new Date().toISOString(),
  };
  let after: string | null = null;
  let sent = 0;
  for (;;) {
    const page: Result<string[]> = await readChipUnreadIds(client, read, after);
    if (!page.ok) return page;
    const ids = page.data;
    if (ids.length === 0) return { ok: true, data: sent };
    const args: Database['public']['Functions']['inbox_mark_read_ids']['Args'] = {
      p_workspace_id: input.workspaceId,
      p_ids: ids,
      p_trace_id: input.traceId,
    };
    const marked = await client.rpc('inbox_mark_read_ids', args);
    if (marked.error) {
      return { ok: false, error: { code: 'unknown', message: marked.error.message } };
    }
    sent += ids.length;
    if (ids.length < MARK_READ_BATCH) return { ok: true, data: sent };
    after = ids[ids.length - 1] ?? null;
  }
}

// ---------------------------------------------------------------------------
// Session-shared reads: page one per chip, and the Mentions count
// ---------------------------------------------------------------------------
//
// Page one of each inbox chip (and sort) and the unread-mention count are
// shared session reads (src/lib/session-read.ts): in memory only, keyed by
// user and workspace, joined while running and for READ_FRESH_MS after a good
// read. The bell press starts the All page and the count (prefetchActivityData),
// so the page's mount joins them. The last good page of a chip is kept for the
// session: a return to Activity, or to a chip, paints it at once and refreshes
// quietly behind it (no request while it is fresh). The page's own writes (a
// mark read and its revert) edit the kept pages too (editKeptActivityPages). Any
// inbox change (the shell's poll, a mark read, Mark all read:
// INBOX_CHANGED_EVENT) marks them all stale before the page's own listener
// reloads, so a reload never joins an answer the change made old.

/** The keys made this session (the inbox change event marks exactly these stale). */
const activityKeys = new Set<string>();

/** The session read key of a chip's page one in a sort. */
export function activityPageKey(
  userId: string,
  workspaceId: string,
  state: ActivityState,
  direction: ActivityDirection,
): string {
  return readKey(userId, workspaceId, `activity-page:${state}:${direction}`);
}

/** The session read key of the unread-mention count. */
export function mentionCountKey(userId: string, workspaceId: string): string {
  return readKey(userId, workspaceId, 'activity-mention-count');
}

/** Join the page read for `key` while it runs or is fresh, else start `load` (a failure is never kept). */
export function sharedActivityPage(
  key: string,
  load: () => Promise<LoadResult>,
): Promise<LoadResult> {
  activityKeys.add(key);
  return sharedRead(key, load, { isOk: (result) => result.ok });
}

/** Join the count read for `key` while it runs or is fresh, else start `load`. */
export function sharedMentionCount(
  key: string,
  load: () => Promise<Result<number>>,
): Promise<Result<number>> {
  activityKeys.add(key);
  return sharedRead(key, load, { isOk: (result) => result.ok });
}

/** The last good page one for `key` this session, at any age, or undefined (never reads). */
export function peekActivityPage(key: string): ActivityItem[] | undefined {
  const held = peekKept<LoadResult>(key);
  return held !== undefined && held.ok ? held.data : undefined;
}

/** The last good unread-mention count this session, or undefined (never reads). */
export function peekMentionCount(key: string): number | undefined {
  const held = peekKept<Result<number>>(key);
  return held !== undefined && held.ok ? held.data : undefined;
}

/** Mark one shared Activity read (`key`) or all of them (the inbox changed) stale. */
export function invalidateActivityReads(key?: string): void {
  for (const k of key !== undefined ? [key] : activityKeys) invalidateReads(k);
}

/** Every inbox chip with a page one. */
const PAGE_STATES: readonly ActivityState[] = ['all', 'unread', 'mentions', 'snoozed'];
const PAGE_DIRECTIONS: readonly ActivityDirection[] = ['newest', 'oldest'];

/**
 * Apply one of the page's own writes (a mark read, its revert) to
 * every kept chip page of this user and workspace, so a return paints it:
 * the pages read this session and the ones the device saved (seeded at boot,
 * not read yet). A page that was stale stays stale (the next read still goes
 * to the server).
 */
export function editKeptActivityPages(
  userId: string,
  workspaceId: string,
  edit: (items: ActivityItem[]) => ActivityItem[],
): void {
  const prefix = readKey(userId, workspaceId, 'activity-page:');
  const keys = new Set(activityKeys);
  for (const state of PAGE_STATES) {
    for (const direction of PAGE_DIRECTIONS) {
      keys.add(activityPageKey(userId, workspaceId, state, direction));
    }
  }
  for (const key of keys) {
    const kept = key.startsWith(prefix) ? peekKept<LoadResult>(key) : undefined;
    if (kept === undefined || !kept.ok) continue;
    const fresh = peekRead<LoadResult>(key) !== undefined;
    primeRead(key, { ok: true, data: edit(kept.data) } satisfies LoadResult);
    if (!fresh) invalidateReads(key);
  }
}

if (typeof window !== 'undefined') {
  window.addEventListener(INBOX_CHANGED_EVENT, () => invalidateActivityReads());
}

/**
 * The bell press: start Activity's first reads (page one of All, in the order
 * stored on this device, and the unread-mention count) through the keys the
 * page's mount joins. Cheap, never throws, paints nothing; a failure is the page's to
 * retry. The client and the count read load with import() (the client is the
 * shell's; the count's module imports this one).
 */
export function prefetchActivityData(ctx: PrefetchContext): void {
  try {
    mark('activity:prefetch');
    const direction = storedActivitySort();
    void Promise.all([import('@/lib/supabase'), import('@/lib/inbox/inbox-reads')])
      .then(([{ supabase }, reads]) => {
        void sharedActivityPage(
          activityPageKey(ctx.userId, ctx.workspaceId, 'all', direction),
          () =>
            fetchActivityEntries(supabase, ctx.workspaceId, {
              state: 'all',
              direction,
              // The page's own read size, so the page joins this read as page one.
              pageSize: getFillCount(),
            }),
        ).catch(() => undefined);
        void sharedMentionCount(mentionCountKey(ctx.userId, ctx.workspaceId), async () => {
          // Joins the shell's fresh badge read when there is one (one rpc gives both counts).
          const badge = await reads.readActivityBadge(supabase, {
            userId: ctx.userId,
            workspaceId: ctx.workspaceId,
            traceId: generateTraceId(),
            refresh: false,
          });
          return badge.ok ? { ok: true as const, data: badge.data.mentions } : badge;
        }).catch(() => undefined);
      })
      .catch((err: unknown) => {
        logger.warn('activity prefetch failed', { error: String(err) });
      });
  } catch (err: unknown) {
    logger.warn('activity prefetch failed', { error: String(err) });
  }
}
