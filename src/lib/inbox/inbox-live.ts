// Pure logic for the always-on inbox (Activity) live layer. Nothing here touches
// the network or React: the provider (InboxStoreProvider) wires these functions
// to PostgREST, the toast surface and the nav. Mirrors the chat-store split, so
// every decision the live layer makes is unit-tested in isolation here.

import type { Database } from '@srtdio/schemas';
import {
  BELL_MENTION_EVENT,
  BELL_OPEN_HREF,
  chatMessageHref,
  isBellRow,
} from '@/lib/inbox/bell-types';
import { resolveMentionText } from '@/lib/chat/mentions';

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
   * Display names for the ids mentioned in `body`, from the same batched read as
   * the actor. Null when that read failed or timed out: the toast then shows no
   * line 2 at all, never a raw token.
   */
  mentionNames: ReadonlyMap<string, string> | null;
  /** stage_change only: the stage the post moved to (payload.to), when the reader carries it. */
  toStage?: string | null;
}

/** A batch of new rows reduced to a count plus its enriched lead. */
export interface EnrichedNew {
  count: number;
  lead: EnrichedLead | null;
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
 * count in the Activity badge.
 */
export function eventLabel(eventType: string, toStage: string | null = null): string {
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
 * (an unknown id reads as resolveMentionText's "@Unknown member"), then the text
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
  return trimSnippet(resolveMentionText(body, (id) => names.get(id)));
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
      : eventLabel(lead.eventType, lead.toStage ?? null);
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

/** A batch of new rows split between the two surfaces. */
export interface NewRowsSplit {
  /** Rows Activity shows (and toasts for). */
  activity: InboxRow[];
  /** New chat mentions: the bell's toast, never Activity's. */
  chatMentions: InboxRow[];
}

/**
 * Split new rows: Activity's own, and the chat mentions the bell toasts for.
 * Reminders and scheduled outcomes get no live toast here (the ring and the
 * bell own them). Pure.
 */
export function splitNewRows(rows: readonly InboxRow[]): NewRowsSplit {
  return {
    activity: rows.filter((row) => !isBellRow(row)),
    chatMentions: rows.filter((row) => isBellRow(row) && row.event_type === BELL_MENTION_EVENT),
  };
}

/** The bell's live toast for new chat mentions. */
export interface MentionToastSpec {
  title: string;
  description: string;
  /** Where Open goes: the message for one mention, the bell for several. */
  href: string;
  actorId: string | null;
}

/** Copy on the mention toast's open affordance. */
export const MENTION_TOAST_ACTION = 'Open';

/**
 * "<name> mentioned you" (Open goes to the message) for one new chat mention;
 * "N new mentions" (Open goes to the bell) for several. Null for none. Pure.
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
      href: BELL_OPEN_HREF,
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
        : BELL_OPEN_HREF,
    actorId,
  };
}
