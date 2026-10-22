// Pure logic for the always-on inbox (Activity) live layer. Nothing here touches
// the network or React: the provider (InboxStoreProvider) wires these functions
// to PostgREST, the toast surface and the nav. Mirrors the chat-store split, so
// every decision the live layer makes is unit-tested in isolation here.

import type { Database } from '@srtdio/schemas';
import { BELL_MENTION_EVENT, chatMessageHref, isBellRow } from '@/lib/inbox/bell-types';
import { resolveMentionText, splitMentions } from '@/lib/chat/mentions';

/** The raw inbox_entries row, reused from the generated schema (never redefined). */
export type InboxRow = Database['public']['Tables']['inbox_entries']['Row'];

/** The result of diffing a fresh page of rows against the high-water mark. */
export interface NewSummary {
  /** Rows whose created_at is strictly newer than the high-water mark. */
  newRows: InboxRow[];
  /** The high-water mark to carry forward: max(sinceMs, newest created_at). */
  nextHighWaterMs: number;
}

/** The enriched lead (newest new row) the toast renders from. */
interface EnrichedLead {
  eventType: string;
  actorName: string | null;
  actorAvatarUrl: string | null;
  /** The raw comment body: mention tokens are still `@[uuid]` here. */
  body: string | null;
  title: string | null;
  /**
   * Full labels ("@username", or "@Former member") for the ids mentioned in
   * `body`, from the same batched read as the actor. Null when that read failed or timed out: the toast then shows no
   * line 2 at all, never a raw token.
   */
  mentionNames: ReadonlyMap<string, string> | null;
  /** stage_change only: the stage the post moved to (payload.to), when the reader carries it. */
  toStage?: string | null;
  /** plan_review only: a withdrawal (payload.withdrawn), when the reader carries it. */
  reviewWithdrawn?: boolean;
  /** plan_review withdrawal only: the status withdrawn (payload.previous). */
  reviewPrevious?: string | null;
  /** The event's existing verb ("commented", "approved"); null when it has none. */
  verb?: string | null;
}

/** One new update, reduced to what the toast groups on. */
export interface ToastUpdate {
  /** The acting person's id; null when the row names none. */
  actorId: string | null;
  /** The entity the update is on ("post:<id>"); null for an entity-less row. */
  entityKey: string | null;
  /** The action: event type plus its outcome (a stage or a review status). */
  action: string;
}

/** A batch of new rows reduced to a count plus its enriched lead. */
export interface EnrichedNew {
  /** The exact number of new Activity updates (never capped by the read's page size). */
  count: number;
  lead: EnrichedLead | null;
  /** The new updates the read returned, newest first, for the grouped wording. */
  updates?: readonly ToastUpdate[];
}

/** The verb-bearing slice of an Activity item. */
export interface VerbSource {
  eventType: string;
  toStage?: string | null;
  reviewStatus?: string | null;
  reviewWithdrawn?: boolean;
  reviewPrevious?: string | null;
}

/**
 * The event's existing verb, as its Activity line already says it: "commented",
 * "approved", "resolved a thread". Null for an event whose line has no actor
 * verb (the ready ping, the welcome row, anything unknown). Pure.
 */
export function eventVerb(item: VerbSource): string | null {
  switch (item.eventType) {
    case 'comment':
    case 'plan_comment':
      return 'commented';
    case 'mention':
      return 'mentioned you';
    case 'comment_resolved':
      return 'resolved a thread';
    case 'checkpoints_added':
      return 'sent points';
    case 'checkpoint_asked':
      return 'asked a question';
    case 'checkpoint_reopened':
      return 'reopened a point';
    case 'post_ready':
      return REVIEW_VERB;
    case 'stage_change':
      switch (item.toStage) {
        case 'approved':
          return 'approved';
        case 'rejected':
          return 'rejected';
        case 'parked':
          return 'parked';
        case 'review':
          return REVIEW_VERB;
        default:
          return 'moved';
      }
    case 'post_deleted':
    case 'assets_deleted':
      return 'deleted';
    case 'brief_created':
      return 'created';
    case 'brief_closed':
      return 'closed';
    case 'asset_uploaded':
      return 'uploaded an asset';
    case 'asset_version_added':
      return 'added an asset version';
    case 'invite':
      return 'invited a new member';
    case 'plan_review':
      if (item.reviewWithdrawn === true) {
        return item.reviewPrevious === 'changes'
          ? 'withdrew their changes request'
          : 'withdrew slot approval';
      }
      return item.reviewStatus === 'approved'
        ? 'approved'
        : item.reviewStatus === 'changes'
          ? 'asked changes'
          : 'reviewed';
    default:
      return null;
  }
}

/** The action key the toast groups on: the event type plus its outcome. Pure. */
export function actionKey(item: VerbSource): string {
  if (item.eventType === 'stage_change') return `stage_change:${item.toStage ?? ''}`;
  if (item.eventType === 'plan_review') {
    return `plan_review:${item.reviewWithdrawn === true ? 'withdrawn' : (item.reviewStatus ?? '')}`;
  }
  return item.eventType;
}

/** The send-for-review verb: it wraps the title ("sent {title} for review"). */
export const REVIEW_VERB = 'sent for review';

/** "{verb} on {title}", or "sent {title} for review"; `times` adds the repeat count. */
function verbOnTitle(verb: string, title: string, times?: number): string {
  const repeat = times !== undefined ? ` ${times} times` : '';
  return verb === REVIEW_VERB
    ? `sent ${title} for review${repeat}`
    : `${verb}${repeat} on ${title}`;
}

/** "1 other" / "N others". */
function othersPhrase(n: number): string {
  return `${n} ${n === 1 ? 'other' : 'others'}`;
}

/**
 * The grouped title for several updates, or null when the wording cannot be
 * built (no name for the newest actor). {Name} is the newest update's actor;
 * {verb} its existing verb; counts are exact:
 *   same post + action, different people: "{Name} and {N} others {verb} on {title}"
 *   same person + post + action, repeated: "{Name} {verb} {N} times on {title}"
 *   (send for review wraps the title: "{Name} sent {title} for review [{N} times]")
 *   same person, different posts or actions: "{Name}: {N} new updates"
 *   different people, different posts or actions: "{Name} and {N} others: {M} new updates"
 */
export function groupedToastTitle(
  updates: readonly ToastUpdate[],
  total: number,
  lead: { actorName: string | null; verb?: string | null; title: string | null },
): string | null {
  const name = lead.actorName;
  if (name === null || updates.length === 0) return null;
  const people = new Set(updates.map((u) => u.actorId ?? ''));
  const others = people.size - 1;
  const first = updates[0];
  const samePost =
    first !== undefined &&
    first.entityKey !== null &&
    updates.every((u) => u.entityKey === first.entityKey);
  const sameAction = first !== undefined && updates.every((u) => u.action === first.action);
  const verb = lead.verb ?? null;
  const title = lead.title !== null && lead.title.trim() !== '' ? lead.title.trim() : null;
  if (samePost && sameAction && verb !== null && title !== null) {
    return others === 0
      ? `${name} ${verbOnTitle(verb, title, total)}`
      : `${name} and ${othersPhrase(others)} ${verbOnTitle(verb, title)}`;
  }
  return others === 0
    ? `${name}: ${total} new updates`
    : `${name} and ${othersPhrase(others)}: ${total} new updates`;
}

/** The toast content derived from an enriched batch, before it is rendered. */
export interface ToastSpec {
  title: string;
  description?: string;
  actorName: string | null;
  actorAvatarUrl: string | null;
}

/**
 * Diff a page of rows against the high-water mark. `newRows` are the rows strictly
 * newer than `sinceMs`; `nextHighWaterMs` advances to the newest created_at seen
 * (never below `sinceMs`). Unparseable timestamps are ignored. Never throws.
 */
export function summarizeNew(rows: readonly InboxRow[], sinceMs: number): NewSummary {
  const newRows: InboxRow[] = [];
  let nextHighWaterMs = sinceMs;
  for (const row of rows) {
    const ms = Date.parse(row.created_at);
    if (Number.isNaN(ms)) continue;
    if (ms > sinceMs) newRows.push(row);
    if (ms > nextHighWaterMs) nextHighWaterMs = ms;
  }
  return { newRows, nextHighWaterMs };
}

/** The newest row by created_at, or null for an empty / all-unparseable list. */
export function pickNewest(rows: readonly InboxRow[]): InboxRow | null {
  let newest: InboxRow | null = null;
  let newestMs = Number.NEGATIVE_INFINITY;
  for (const row of rows) {
    const ms = Date.parse(row.created_at);
    if (Number.isNaN(ms)) continue;
    if (ms > newestMs) {
      newestMs = ms;
      newest = row;
    }
  }
  return newest;
}

/** The stage_change toast label by target stage; any other stage reads "Post moved". */
export function stageChangeLabel(toStage: string | null | undefined): string {
  switch (toStage) {
    case 'approved':
      return 'Post approved';
    case 'rejected':
      return 'Post rejected';
    case 'parked':
      return 'Post parked';
    default:
      return 'Post moved';
  }
}

/**
 * A neutral, null-safe label for a single event, by type. post_deleted and
 * assets_deleted are Activity rows (never bell types): they toast here and
 * count in the Activity badge. A plan_review withdrawal reads "<name> withdrew
 * slot approval" ("withdrew their changes request" after changes); with no
 * resolved name, "Slot approval withdrawn" / "Changes request withdrawn".
 */
export function eventLabel(
  eventType: string,
  toStage: string | null = null,
  review: { withdrawn?: boolean; previous?: string | null; actorName?: string | null } = {},
): string {
  if (eventType === 'plan_review' && review.withdrawn === true) {
    const changes = review.previous === 'changes';
    // The live reader resolves no actor for plan rows: name-free then.
    if (review.actorName === undefined || review.actorName === null) {
      return changes ? 'Changes request withdrawn' : 'Slot approval withdrawn';
    }
    return changes
      ? `${review.actorName} withdrew their changes request`
      : `${review.actorName} withdrew slot approval`;
  }
  switch (eventType) {
    case 'comment':
      return 'New comment';
    case 'mention':
      return 'New mention';
    case 'stage_change':
      return stageChangeLabel(toStage);
    case 'post_deleted':
      return 'Post deleted';
    case 'assets_deleted':
      return 'Assets deleted';
    case 'brief_created':
      return 'New brief';
    case 'brief_closed':
      return 'Brief closed';
    case 'comment_resolved':
      return 'Comment resolved';
    case 'asset_uploaded':
    case 'asset_version_added':
      return 'New asset';
    case 'checkpoints_added':
      return 'Points sent';
    case 'post_ready':
      return 'Ready for review';
    case 'plan_comment':
      return 'New plan comment';
    case 'plan_review':
      return 'Plan item reviewed';
    default:
      return 'New activity';
  }
}

const NUMBER_WORDS: readonly string[] = [
  'Zero',
  'One',
  'Two',
  'Three',
  'Four',
  'Five',
  'Six',
  'Seven',
  'Eight',
  'Nine',
];

/** Spell small counts (Two, Three, ...); fall back to digits for ten and up. */
function spellCount(n: number): string {
  return n >= 2 && n <= 9 ? (NUMBER_WORDS[n] ?? String(n)) : String(n);
}

/** Trim a body to a single legible toast line of at most ~100 characters. */
function trimSnippet(text: string): string {
  const t = text.trim();
  return t.length <= 100 ? t : `${t.slice(0, 100).trimEnd()}…`;
}

/**
 * The toast's line 2 for a comment body: every mention token becomes "@Name"
 * (an unknown id reads as resolveMentionText's "@Former member"), then the text
 * is trimmed, so the cut never lands inside a token. Null for an empty body, or
 * whenever the name read failed or timed out (no raw token is ever shown).
 */
function commentSnippet(
  body: string | null,
  names: ReadonlyMap<string, string> | null,
): string | null {
  if (body === null || body.trim().length === 0) return null;
  // The name read failed or timed out: no body line at all (never a raw token).
  if (names === null) return null;
  // Each value is the whole label ("@username" or "@Former member"); an id the read
  // did not return reads as resolveMentionText's "@Former member".
  const text = splitMentions(body)
    .map((seg) =>
      seg.kind === 'text'
        ? seg.text
        : (names.get(seg.userId) ?? resolveMentionText(`@[${seg.userId}]`, () => undefined)),
    )
    .join('');
  return trimSnippet(text);
}

/**
 * Build the toast content for an enriched batch, or null when there is nothing to
 * show. A single comment with a known actor reads "{name} commented on {title}"
 * (the post's or brief's title), or "{name} commented" when the title is missing;
 * its description is the body with mentions resolved, else nothing. Any other
 * single event takes its neutral label, with the body, then the title, as its
 * description. Many new rows coalesce to "N new updates" with no actor. Pure;
 * produces no JSX.
 */
export function toastFromEnriched(enriched: EnrichedNew): ToastSpec | null {
  if (enriched.count === 0) return null;
  if (enriched.count > 1) {
    const lead = enriched.lead;
    const grouped =
      lead !== null && enriched.updates !== undefined
        ? groupedToastTitle(enriched.updates, enriched.count, lead)
        : null;
    if (lead !== null && grouped !== null) {
      return { title: grouped, actorName: lead.actorName, actorAvatarUrl: lead.actorAvatarUrl };
    }
    return {
      title: `${spellCount(enriched.count)} new updates`,
      actorName: null,
      actorAvatarUrl: null,
    };
  }
  const lead = enriched.lead;
  if (lead === null) {
    return { title: 'New activity', actorName: null, actorAvatarUrl: null };
  }
  const snippet = commentSnippet(lead.body, lead.mentionNames);
  const isComment = lead.eventType === 'comment';
  const leadVerb = lead.verb ?? null;
  // Any other named event with a verb: "{Name} {verb} on {title}" ("{Name} {verb}" with no title).
  if (!isComment && lead.actorName !== null && leadVerb !== null) {
    const leadTitle =
      lead.title !== null && lead.title.trim().length > 0 ? lead.title.trim() : null;
    return {
      title: `${lead.actorName} ${leadTitle !== null ? verbOnTitle(leadVerb, leadTitle) : leadVerb}`,
      actorName: lead.actorName,
      actorAvatarUrl: lead.actorAvatarUrl,
    };
  }
  const named = isComment && lead.actorName !== null;
  // The name read failed or timed out: the actor is unknown and no body shows.
  const namesFailed = isComment && lead.mentionNames === null;
  const leadTitle = lead.title !== null && lead.title.trim().length > 0 ? lead.title.trim() : null;
  const title = named
    ? leadTitle !== null
      ? `${lead.actorName} commented on ${leadTitle}`
      : `${lead.actorName} commented`
    : namesFailed && leadTitle !== null
      ? `New comment on ${leadTitle}`
      : eventLabel(lead.eventType, lead.toStage ?? null, {
          ...(lead.reviewWithdrawn !== undefined ? { withdrawn: lead.reviewWithdrawn } : {}),
          previous: lead.reviewPrevious ?? null,
          actorName: lead.actorName,
        });
  // A named comment, or a failed name read, already carries the title on line 1
  // (or has no line 2 at all); do not repeat it.
  const description = snippet ?? (named || namesFailed ? null : leadTitle);
  const base: ToastSpec = {
    title,
    actorName: lead.actorName,
    actorAvatarUrl: lead.actorAvatarUrl,
  };
  return description !== null ? { ...base, description } : base;
}

/** A batch of new rows split between the two live toasts. */
export interface NewRowsSplit {
  /** Rows the activity toast words (and the tone plays for). */
  activity: InboxRow[];
  /** New chat mentions: their own "<name> mentioned you" toast. */
  chatMentions: InboxRow[];
}

/**
 * Rows written by someone else. The actor's own already-read row (inbox_self_entry,
 * 20261018140000) is history, not news: it never toasts or plays the tone.
 */
export function othersRows<T extends { actor_user_id: string | null }>(
  rows: readonly T[],
  selfId: string,
): T[] {
  return rows.filter((row) => row.actor_user_id !== selfId);
}

/** The Notifications route prefix: new rows never tone while it is on screen. */
export const ACTIVITY_PATH = '/notifications';

/**
 * Whether new Activity rows play the shared notification tone: only when at least
 * one is someone else's and the Activity screen is not in front of the viewer (a
 * background tab counts as not in front, even on Activity; the same rule as a
 * chat that is already open). Throttling is shared with chat (notify-sound.ts).
 */
export function activityToneWanted(
  newOthersCount: number,
  pathname: string,
  tabHidden = false,
): boolean {
  return newOthersCount > 0 && (tabHidden || !pathname.startsWith(ACTIVITY_PATH));
}

/**
 * Split new rows: the activity toast's own, and the chat mentions that toast
 * on their own. Reminders, scheduled outcomes and the plan and task alerts get
 * no live toast here (the ring owns reminders); they show on Notifications. Pure.
 */
export function splitNewRows(rows: readonly InboxRow[]): NewRowsSplit {
  return {
    activity: rows.filter((row) => !isBellRow(row)),
    chatMentions: rows.filter((row) => isBellRow(row) && row.event_type === BELL_MENTION_EVENT),
  };
}

/** The live toast for new chat mentions. */
export interface MentionToastSpec {
  title: string;
  description: string;
  /** Where Open goes: the message for one mention, Notifications for several. */
  href: string;
  actorId: string | null;
}

/** Copy on the mention toast's open affordance. */
export const MENTION_TOAST_ACTION = 'Open';

/**
 * "<name> mentioned you" (Open goes to the message) for one new chat mention;
 * "N new mentions" (Open goes to Notifications) for several. Null for none. Pure.
 */
export function mentionToastFrom(
  rows: readonly InboxRow[],
  nameOf: (userId: string) => string | null,
): MentionToastSpec | null {
  if (rows.length === 0) return null;
  if (rows.length > 1) {
    return {
      title: `${spellCount(rows.length)} new mentions`,
      description: MENTION_TOAST_ACTION,
      href: ACTIVITY_PATH,
      actorId: null,
    };
  }
  const row = rows[0];
  if (row === undefined) return null;
  const actorId = row.actor_user_id ?? null;
  const name = actorId !== null ? nameOf(actorId) : null;
  const payload: unknown = row.payload;
  const messageId =
    typeof payload === 'object' && payload !== null
      ? (payload as Record<string, unknown>).message_id
      : null;
  return {
    title: `${name ?? 'Someone'} mentioned you`,
    description: MENTION_TOAST_ACTION,
    href:
      row.entity_id !== null
        ? chatMessageHref(row.entity_id, typeof messageId === 'string' ? messageId : null)
        : ACTIVITY_PATH,
    actorId,
  };
}
