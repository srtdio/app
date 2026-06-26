// Pure logic for the always-on inbox (Activity) live layer. Nothing here touches
// the network or React: the provider (InboxStoreProvider) wires these functions
// to PostgREST, the toast surface and the nav. Mirrors the chat-store split, so
// every decision the live layer makes is unit-tested in isolation here.

import type { Database } from '@srtdio/schemas';

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
export interface EnrichedLead {
  eventType: string;
  actorName: string | null;
  actorAvatarUrl: string | null;
  body: string | null;
  title: string | null;
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

/** A neutral, null-safe label for a single event, by type. */
function eventLabel(eventType: string): string {
  switch (eventType) {
    case 'comment':
      return 'New comment';
    case 'mention':
      return 'New mention';
    case 'stage_change':
      return 'Post moved';
    case 'brief_created':
      return 'New brief';
    case 'brief_closed':
      return 'Brief closed';
    case 'comment_resolved':
      return 'Comment resolved';
    case 'asset_uploaded':
    case 'asset_version_added':
      return 'New asset';
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
 * Build the toast content for an enriched batch, or null when there is nothing to
 * show. A single comment with a known actor reads "{name} commented"; any other
 * single event takes its neutral label. The description is the trimmed body, then
 * the resolved title, then nothing. Many new rows coalesce to "N new updates" with
 * no actor. Pure; produces no JSX.
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
  const title =
    lead.eventType === 'comment' && lead.actorName !== null
      ? `${lead.actorName} commented`
      : eventLabel(lead.eventType);
  const snippet = lead.body !== null && lead.body.trim().length > 0 ? trimSnippet(lead.body) : null;
  const description = snippet ?? lead.title ?? undefined;
  const base: ToastSpec = {
    title,
    actorName: lead.actorName,
    actorAvatarUrl: lead.actorAvatarUrl,
  };
  return description !== undefined ? { ...base, description } : base;
}
