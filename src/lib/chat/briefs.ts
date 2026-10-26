// Briefs shared into chat. The picker and the bubble cards read public.briefs
// through plain RLS-scoped SELECTs scoped to the open workspace (the
// @srtdio/briefs listBriefs read is not workspace-scoped and also resolves
// thumbnails, which the chat picker does not need). A bubble's brief ids resolve
// in ONE IN read; an id the viewer's RLS hides comes back absent and renders as
// an "unavailable" card, so nothing leaks. Pure helpers are unit-tested with no DOM.

import type { Client, Result } from '@srtdio/rpc';
import { abortable } from '@/lib/chat-reads';

/** The brief fields a picker row, chip and card render. */
export interface BriefCardFields {
  id: string;
  title: string;
  status: string;
  createdAt: string;
}

interface BriefCardRow {
  id: string;
  title: string;
  status: string;
  created_at: string;
}

/** Picker page size (newest first). */
const BRIEF_PICKER_LIMIT = 50;

const BRIEF_COLUMNS = 'id, title, status, created_at';

function fail<T>(message: string): Result<T> {
  return { ok: false, error: { code: 'unknown', message } };
}

function toFields(row: BriefCardRow): BriefCardFields {
  return { id: row.id, title: row.title, status: row.status, createdAt: row.created_at };
}

/** Escape LIKE wildcards so a typed % or _ matches literally. */
function likePattern(query: string): string {
  return `%${query.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/** The picker's status filter: open, closed, or every brief the viewer can see. */
export type BriefFilter = 'open' | 'closed' | 'all';

/** The Briefs tab filter chips, in display order. Open is the default selection. */
export const BRIEF_FILTERS: ReadonlyArray<{ key: BriefFilter; label: string }> = [
  { key: 'open', label: 'Open' },
  { key: 'closed', label: 'Closed' },
  { key: 'all', label: 'All briefs' },
];

/** The default Briefs chip when the picker opens. */
export const DEFAULT_BRIEF_FILTER: BriefFilter = 'open';

/** The status to pass to the read for a filter; "All briefs" passes none. */
export function filterBriefStatus(filter: BriefFilter): 'open' | 'closed' | undefined {
  return filter === 'all' ? undefined : filter;
}

/** One picker row: the card fields plus the preview, dates and live post count. */
export interface BriefPickerRow extends BriefCardFields {
  number: number;
  objective: string;
  formatRequested: string | null;
  /** A DATE column (YYYY-MM-DD), not an instant. */
  targetDate: string | null;
  postCount: number;
}

interface BriefPickerDbRow extends BriefCardRow {
  number: number;
  objective: string;
  format_requested: string | null;
  target_date: string | null;
}

/** The PostgREST aggregate-embed shape: posts(count) comes back as [{ count }]. */
type PostCountEmbed = ReadonlyArray<{ count: number }> | null | undefined;

// PostgREST aggregates (posts(count)) are disabled on the project, so the
// picker reads briefs and then counts their live posts in ONE second query over
// the page's ids. Two queries total, never one per row.
const BRIEF_PICKER_COLUMNS =
  'id, number, title, objective, format_requested, target_date, status, created_at';

/** The post count from an aggregate embed row; 0 when absent. */
export function embedPostCount(embed: PostCountEmbed): number {
  return embed?.[0]?.count ?? 0;
}

/** Post counts per brief from the fallback shape: one { brief_id } per live post. */
export function countPostsByBrief(
  rows: ReadonlyArray<{ brief_id: string | null }>,
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const row of rows) {
    if (row.brief_id !== null) counts.set(row.brief_id, (counts.get(row.brief_id) ?? 0) + 1);
  }
  return counts;
}

/** Map a DB row plus its post count to a picker row. */
export function toPickerRow(row: BriefPickerDbRow, postCount: number): BriefPickerRow {
  return {
    ...toFields(row),
    number: row.number,
    objective: row.objective,
    formatRequested: row.format_requested,
    targetDate: row.target_date,
    postCount,
  };
}

/** The post-count text on a brief row: "No posts yet", "1 post", "{n} posts". */
export function briefPostCountLabel(count: number): string {
  if (count <= 0) return 'No posts yet';
  return count === 1 ? '1 post' : `${count} posts`;
}

/**
 * Briefs for the picker: the workspace's live briefs, newest first, optional
 * status filter and title match, each with its live (non-deleted) post count.
 */
export async function listBriefsForPicker(
  client: Client,
  params: { workspaceId: string; titleQuery: string; status?: 'open' | 'closed' },
): Promise<Result<BriefPickerRow[]>> {
  let query = client
    .from('briefs')
    .select(BRIEF_PICKER_COLUMNS)
    .eq('workspace_id', params.workspaceId)
    .is('deleted_at', null);
  if (params.status !== undefined) query = query.eq('status', params.status);
  const title = params.titleQuery.trim();
  if (title !== '') query = query.ilike('title', likePattern(title));
  const res = await query.order('created_at', { ascending: false }).limit(BRIEF_PICKER_LIMIT);
  if (res.error) return fail(`listBriefsForPicker: ${res.error.message}`);
  const rows = (res.data ?? []) as BriefPickerDbRow[];
  if (rows.length === 0) return { ok: true, data: [] };

  const posts = await client
    .from('posts')
    .select('brief_id')
    .eq('workspace_id', params.workspaceId)
    .in(
      'brief_id',
      rows.map((row) => row.id),
    )
    .is('deleted_at', null);
  if (posts.error) return fail(`listBriefsForPicker: ${posts.error.message}`);
  const counts = countPostsByBrief((posts.data ?? []) as Array<{ brief_id: string | null }>);
  return { ok: true, data: rows.map((row) => toPickerRow(row, counts.get(row.id) ?? 0)) };
}

/** Briefs by id (one IN read); empty in, empty out. */
export async function readBriefsByIds(
  client: Client,
  params: { workspaceId: string; ids: readonly string[]; signal?: AbortSignal },
): Promise<Result<BriefCardFields[]>> {
  if (params.ids.length === 0) return { ok: true, data: [] };
  const res = await abortable(
    client
      .from('briefs')
      .select(BRIEF_COLUMNS)
      .eq('workspace_id', params.workspaceId)
      .in('id', [...params.ids])
      .is('deleted_at', null),
    params.signal,
  );
  if (res.error) return fail(`readBriefsByIds: ${res.error.message}`);
  return { ok: true, data: ((res.data ?? []) as BriefCardRow[]).map(toFields) };
}

/** Brief ids by per-workspace number (pasted /b/ links), one IN read; empty in, empty out. */
export async function readBriefIdsByNumbers(
  client: Client,
  params: { workspaceId: string; numbers: readonly number[] },
): Promise<Result<Array<{ id: string; number: number }>>> {
  if (params.numbers.length === 0) return { ok: true, data: [] };
  const res = await client
    .from('briefs')
    .select('id, number')
    .eq('workspace_id', params.workspaceId)
    .in('number', [...params.numbers])
    .is('deleted_at', null);
  if (res.error) return fail(`readBriefIdsByNumbers: ${res.error.message}`);
  return { ok: true, data: (res.data ?? []) as Array<{ id: string; number: number }> };
}

/** The in-app route a brief card opens. */
export function briefRoute(id: string): string {
  return `/briefs/${id}`;
}

/** Status chip label: Open or Closed. */
export function briefStatusLabel(status: string): string {
  return status === 'closed' ? 'Closed' : 'Open';
}

/** Whether a brief id is in the selection. */
export function isBriefSelected(selected: readonly BriefCardFields[], id: string): boolean {
  return selected.some((brief) => brief.id === id);
}

/** Toggle a brief in the selection (new array, matched by id). */
export function toggleBrief(
  selected: readonly BriefCardFields[],
  brief: BriefCardFields,
): BriefCardFields[] {
  return isBriefSelected(selected, brief.id)
    ? selected.filter((item) => item.id !== brief.id)
    : [...selected, brief];
}

/** The render branch for one shared brief id. */
export type SharedBriefView =
  | { kind: 'brief'; briefId: string; title: string; status: string }
  | { kind: 'unavailable'; briefId: string };

/** One view per id in message order; an id the read did not return is unavailable. */
export function sharedBriefViews(
  ids: readonly string[],
  briefs: readonly BriefCardFields[],
): SharedBriefView[] {
  const byId = new Map(briefs.map((b) => [b.id, b]));
  return ids.map((briefId) => {
    const brief = byId.get(briefId);
    return brief !== undefined
      ? { kind: 'brief', briefId, title: brief.title, status: brief.status }
      : { kind: 'unavailable', briefId };
  });
}
