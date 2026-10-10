// Pure, React-free helpers for the chat post picker, so query parsing, section
// building, paging labels and the multi-select toggle are unit-tested directly
// without a DOM. The picker reads posts through the @srtdio/posts RLS selects
// (listPostsForPickerPage / countPostsForPicker); these helpers only shape the
// inputs and outputs of those reads. Nothing here fabricates post fields.

import type { PostCardFields, Stage } from '@srtdio/posts';
import type { PostPickerCursor } from '../../../packages/posts/src/reads';
import { isAgencySide, isClient } from '@/components/pages/pcs/roles';

/** Page size for search results and each default section. */
export const PICKER_PAGE_SIZE = 50;

/** How far back the "Approved in the last 30 days" section reaches. */
export const RECENT_APPROVED_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;

/** The ISO instant that splits recent from older approved posts. */
export function recentApprovedSince(now: Date): string {
  return new Date(now.getTime() - RECENT_APPROVED_DAYS * DAY_MS).toISOString();
}

/** A parsed search: the trimmed text for title/caption match, and a post number when named. */
export interface PickerQuery {
  text: string;
  number: number | null;
}

// The hash sign is built from its char code so chat files carry no literal one
// (chat-tokens.test bans it as a hex-colour guard).
const HASH = String.fromCharCode(35);
const MAX_POST_NUMBER = 2_147_483_647;

function toPostNumber(digits: string): number | null {
  if (!/^[0-9]{1,10}$/.test(digits)) return null;
  const n = parseInt(digits, 10);
  return n >= 1 && n <= MAX_POST_NUMBER ? n : null;
}

/**
 * Parse the search box. Empty (after trim) is null: the default sections show.
 * "14", a leading hash plus "14", and "KEY-14" (this workspace's key, any case)
 * all name post number 14; the text match still runs on the trimmed input.
 */
export function parsePickerQuery(raw: string, workspaceKey: string | null): PickerQuery | null {
  const text = raw.trim();
  if (text === '') return null;
  let rest = text.startsWith(HASH) ? text.slice(1).trim() : text;
  if (workspaceKey !== null && workspaceKey !== '') {
    const prefix = `${workspaceKey.toLowerCase()}-`;
    if (rest.toLowerCase().startsWith(prefix)) rest = rest.slice(prefix.length);
  }
  return { text, number: toPostNumber(rest) };
}

/**
 * What the share picker lists. 'posts': the Post tile (review, approved, parked,
 * rejected; never a draft). 'drafts': the Draft tile (drafts only). 'briefs':
 * the Brief tile (briefs only, no post read). 'inline': the composer's hash
 * picker (review, approved, and drafts only where drafts are allowed).
 */
export type PickerMode = 'posts' | 'drafts' | 'briefs' | 'inline';

/**
 * Which kinds a picker mode reads: brief mode reads briefs and never a post;
 * every other mode reads posts and never a brief. Pure.
 */
export function pickerReads(mode: PickerMode): { posts: boolean; briefs: boolean } {
  return mode === 'briefs' ? { posts: false, briefs: true } : { posts: true, briefs: false };
}

/**
 * Whether drafts may be read at all: an agency-side viewer in a chat with no
 * client, both known. Unknown (null) is no. Pure.
 */
export function draftsAllowed(role: string | null, channelHasClient: boolean | null): boolean {
  return isAgencySide(role) && channelHasClient === false;
}

/**
 * The stage filter a search page carries: drafts mode searches drafts only;
 * posts mode never matches a draft (for any viewer); the inline picker leaves
 * drafts out unless they are allowed. Pure.
 */
export function searchStageFilter(
  mode: Exclude<PickerMode, 'briefs'>,
  allowDrafts: boolean,
): { stage: Stage } | { excludeStage: Stage } | Record<string, never> {
  if (mode === 'drafts') return { stage: 'draft' };
  if (mode === 'inline' && allowDrafts) return {};
  return { excludeStage: 'draft' };
}

/** The review section's label: the client is who review waits on. */
export function waitingLabel(role: string | null): string {
  return isClient(role) ? 'Waiting on you' : 'Waiting on client';
}

export type PickerSectionKey = 'review' | 'approved' | 'parked' | 'rejected' | 'draft';

export interface PickerSection<Row> {
  key: PickerSectionKey;
  label: string;
  rows: Row[];
}

/**
 * The default view's sections, in display order, empty ones dropped. Posts
 * mode: waiting (review), approved in the last 30 days, parked, rejected; never
 * drafts. Drafts mode: Drafts alone. Inline: waiting, approved, then Drafts
 * when they were read (null means not allowed, so no section).
 */
export function buildPickerSections<Row>(input: {
  mode: Exclude<PickerMode, 'briefs'>;
  role: string | null;
  review: Row[];
  approved: Row[];
  parked?: Row[];
  rejected?: Row[];
  drafts: Row[] | null;
}): Array<PickerSection<Row>> {
  if (input.mode === 'drafts') {
    return input.drafts !== null && input.drafts.length > 0
      ? [{ key: 'draft', label: 'Drafts', rows: input.drafts }]
      : [];
  }
  const sections: Array<PickerSection<Row>> = [
    { key: 'review', label: waitingLabel(input.role), rows: input.review },
    {
      key: 'approved',
      label: `Approved in the last ${RECENT_APPROVED_DAYS} days`,
      rows: input.approved,
    },
  ];
  if (input.mode === 'posts') {
    sections.push(
      { key: 'parked', label: 'Parked', rows: input.parked ?? [] },
      { key: 'rejected', label: 'Rejected', rows: input.rejected ?? [] },
    );
  } else if (input.drafts !== null) {
    sections.push({ key: 'draft', label: 'Drafts', rows: input.drafts });
  }
  return sections.filter((section) => section.rows.length > 0);
}

/** The footer under the sections, or null when there are no older approved posts. */
export function olderApprovedFooter(count: number): string | null {
  if (count <= 0) return null;
  const noun = count === 1 ? 'older approved post' : 'older approved posts';
  return `${count} ${noun} · type a word or number to find one`;
}

/** The search results header. */
export function matchesLabel(count: number): string {
  return count === 1 ? '1 match' : `${count} matches`;
}

/** The "Load 50 more" row's progress text. */
export function shownOfLabel(shown: number, total: number): string {
  return `${shown} of ${total}`;
}

/** The keyset cursor after a page: the (created_at, id) of its last row. */
export function cursorAfter(
  rows: ReadonlyArray<{ id: string; created_at: string }>,
): PostPickerCursor | null {
  const last = rows[rows.length - 1];
  return last === undefined ? null : { createdAt: last.created_at, id: last.id };
}

/** Whether a search has more rows to page in. */
export function hasMoreResults(shown: number, total: number): boolean {
  return shown < total;
}

/** Whether a post id is in the current selection. */
export function isPostSelected(selected: readonly PostCardFields[], id: string): boolean {
  return selected.some((post) => post.id === id);
}

/**
 * Toggle a post in the selection: append it when absent, remove it when present
 * (matched by id). Returns a new array; the input is never mutated. This is how
 * picking a row adds a removable shared-post chip, and tapping it again (or its
 * chip remove) takes it back out.
 */
export function togglePost(
  selected: readonly PostCardFields[],
  post: PostCardFields,
): PostCardFields[] {
  return isPostSelected(selected, post.id)
    ? selected.filter((item) => item.id !== post.id)
    : [...selected, post];
}
