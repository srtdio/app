// The share picker Sheet, opened from the composer tray in one of three modes,
// plus the composer's inline hash picker. No tabs: each mode lists one kind.
//
// Post mode (the Post tile), empty search: "Waiting on you" / "Waiting on
// client" (review), "Approved in the last 30 days", Parked and Rejected, each
// one RLS-scoped read on the (workspace_id, stage, created_at) index, plus one
// head-only count of older approved posts for the footer. Never a draft, for
// any viewer. All section reads run together and render once every one has
// landed, so the first paint is final.
//
// Draft mode (the Draft tile): one Drafts section and search over drafts only.
// It reads only for an agency-side viewer in a chat with no client (both
// known); otherwise nothing is read and the list is empty. The tray already
// disables the tile then; this is the second gate.
//
// Search (post and draft modes): one keyset-paged read over the workspace
// (title or caption ILIKE, plus an exact number match for "14" / "KEY-14"),
// newest first, 50 a page, with count:'exact' on the first page for the
// header. Post mode leaves drafts out; draft mode keeps drafts only. Input is
// debounced 200 ms and a response whose text no longer matches the box is
// dropped. Selection is controlled by the composer.
//
// Brief mode (the Brief tile): the workspace's briefs (title, objective,
// Open/Closed, target and raised dates, live post count) through
// listBriefsForPicker, filtered by status chips; no post is ever read.
//
// Inline mode (the composer's hash picker): no sheet and no search box; the
// posts list alone, in a panel the composer anchors, with the search text
// controlled by the composer (the text after the hash). Waiting, approved and,
// only where drafts are allowed, Drafts; search leaves drafts out otherwise.

import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { Button } from '@/components/ui/Button';
import { Chip } from '@/components/ui/Chip';
import { PressableRow } from '@/components/ui/PressableRow';
import { EmptyState } from '@/components/ui/EmptyState';
import { NoResults, noResultsCopy } from '@/components/ui/NoResults';
import { Field } from '@/components/ui/Field';
import { Input } from '@/components/ui/Input';
import { Sheet } from '@/components/ui/Sheet';
import { Tag, isTagDot } from '@/components/ui/Tag';
import { ICON_SIZE, IconBriefs, IconCheck, IconPipeline, IconSearch } from '@/components/ui/icons';
import { stageLabel } from '@/components/pages/pipeline/stage-meta';
import { fetchMemberRole } from '@/lib/chat/viewer-role';
import { cn } from '@/lib/cn';
import { formatLabel } from '@/lib/post-detail-presentation';
import { logger } from '@/lib/logger';
import { useSession } from '@/lib/session-context';
import { supabase } from '@/lib/supabase';
import { useWorkspace } from '@/lib/workspace-context';
import { PostCover, warmCoverImages } from '@/components/chat/PostCover';
import {
  coverFor,
  requestPostCovers,
  usePostCovers,
  type CoverLookup,
} from '@/lib/chat/post-covers';
import type { Client } from '@srtdio/rpc';
import type { PostCardFields } from '@srtdio/posts';
import {
  POST_PICKER_PAGE_COLUMNS,
  countPostsForPicker,
  listPostsForPickerPage,
  type PostPickerCursor,
  type PostPickerPageRow,
} from '../../../packages/posts/src/reads';
import {
  BRIEF_FILTERS,
  DEFAULT_BRIEF_FILTER,
  briefPostCountLabel,
  briefStatusLabel,
  filterBriefStatus,
  isBriefSelected,
  listBriefsForPicker,
  type BriefCardFields,
  type BriefFilter,
  type BriefPickerRow,
} from '@/lib/chat/briefs';
import { civilDay, formatDate, formatDueDate } from '@/lib/time';
import { formatCivilDayHeader } from '@/lib/plan-week';
import { ErrorNote } from '@/components/ui/ErrorNote';
import {
  PICKER_PAGE_SIZE,
  buildLinkSections,
  buildPickerSections,
  linkSelection,
  cursorAfter,
  hasMoreResults,
  isPostSelected,
  matchesLabel,
  olderApprovedFooter,
  parsePickerQuery,
  recentApprovedSince,
  draftsAllowed,
  pickerReads,
  searchStageFilter,
  shownOfLabel,
  type PickerMode,
  type PickerQuery,
  type PickerSection,
} from '@/components/chat/post-picker';
import { listSkeleton } from '@/components/chat/ListSkeleton';
import { errorText } from '@/lib/error-copy';
import { TEXT_ROLE } from '@/components/ui/Text';

/** Search debounce, in milliseconds. */
const SEARCH_DEBOUNCE_MS = 200;

interface PostPickerProps {
  open: boolean;
  /** Dismiss: the sheet's X, backdrop tap, swipe down, Escape and Back. */
  onClose: () => void;
  /**
   * The Done button. Absent, Done calls onClose (today's behaviour), so a
   * caller that commits picks on Done passes this and lets dismiss drop them.
   */
  onDone?: (() => void) | undefined;
  /** The composer's current shared-post selection (controlled). */
  selected: readonly PostCardFields[];
  /** Toggle one post in/out of the selection (adds/removes its chip). */
  onToggle: (post: PostCardFields) => void;
  /** The composer's current shared-brief selection (controlled). */
  selectedBriefs: readonly BriefCardFields[];
  /** Toggle one brief in/out of the selection. */
  onToggleBrief: (brief: BriefCardFields) => void;
  /** Post ids already shared in this chat; those rows say "in this chat". */
  sharedPostIds?: ReadonlySet<string> | undefined;
  /** Render the posts list alone (no sheet or search box), for the composer popover. */
  inline?: boolean;
  /** Controlled search text; the search box is not rendered when set inline. */
  query?: string | undefined;
  /** The sheet's mode (the tray tile that opened it). Ignored inline. Absent is 'posts'. */
  mode?: Exclude<PickerMode, 'inline'>;
  /**
   * Whether the open chat has a client among its other members; null or absent
   * while unknown. Drafts are read only when this is false and the viewer is on
   * the agency side.
   */
  channelHasClient?: boolean | null | undefined;
  /** Post ids not to list at all (a plan's posts, when adding to that plan). */
  excludePostIds?: ReadonlySet<string> | undefined;
  /**
   * Link mode (mode 'link', a concept's "Link a post"): the concept's plan day
   * ("YYYY-MM-DD"; posts due that day list first); null or absent for none.
   */
  linkDay?: string | null | undefined;
  /** Link mode: the picked post id (single select, controlled); null for none. */
  linkSelectedId?: string | null | undefined;
  /** Link mode: a row tap picks that post (the one selection). */
  onLinkSelect?: ((post: PostCardFields) => void) | undefined;
  /** Link mode: "Link this post" with a post picked. */
  onLinkConfirm?: (() => void) | undefined;
}

/** The sheet title per mode. */
const PICKER_TITLES: Record<Exclude<PickerMode, 'inline'>, string> = {
  posts: 'Share a post',
  drafts: 'Share a draft',
  briefs: 'Share a brief',
  link: 'Link a post',
};

/** Link mode's full-width confirm and its nothing-picked hint. */
export const LINK_CONFIRM = 'Link this post';
export const LINK_PICK_FIRST_HINT = 'Pick a post first.';

/** The default view's data: the sections plus the older-approved count. */
interface PickerSectionsData {
  sections: Array<PickerSection<PostPickerPageRow>>;
  olderApprovedCount: number;
}

/** The picker's error line when a posts read fails; the raw text is only logged. */
export const POSTS_LOAD_FAILED = errorText('load posts', null);

/** The picker's error line when the briefs read fails; the raw text is only logged. */
const BRIEFS_LOAD_FAILED = errorText('load briefs', null);

/** The briefs tab's error line for a read: fixed copy on failure (raw text logged), else null. */
export function briefsLoadError(
  result: { ok: true } | { ok: false; error: { message: string } },
): string | null {
  if (result.ok) return null;
  logger.warn('post picker: briefs load failed', { error: result.error.message });
  return BRIEFS_LOAD_FAILED;
}

/** The modes that read posts. */
type PostListMode = Exclude<PickerMode, 'briefs'>;

const EMPTY_SECTIONS: PickerSectionsData = { sections: [], olderApprovedCount: 0 };

/**
 * Load the default view for a mode, one read per section, all in parallel,
 * never one read per row. Posts: review, recent approved, parked, rejected plus
 * one head-only count of older approved posts. Inline: review, recent approved,
 * drafts only when `allowDrafts`, plus the count. Drafts: one drafts read when
 * `allowDrafts`, else no read at all. The first failure surfaces as the error.
 */
export async function loadPickerSections(
  client: Client,
  params: {
    workspaceId: string;
    role: string | null;
    now: Date;
    mode: PostListMode;
    allowDrafts: boolean;
    /** Link mode: the concept's plan day and the workspace zone its posts' days read on. */
    linkDay?: string | null;
    timeZone?: string | null;
  },
): Promise<{ ok: true; data: PickerSectionsData } | { ok: false; message: string }> {
  const { workspaceId, role, mode, allowDrafts } = params;
  if (mode === 'link') {
    return loadLinkSections(client, {
      workspaceId,
      day: params.linkDay ?? null,
      timeZone: params.timeZone ?? null,
    });
  }
  const page = (stage: 'review' | 'parked' | 'rejected' | 'draft') =>
    listPostsForPickerPage(client, { workspaceId, stage, limit: PICKER_PAGE_SIZE });
  if (mode === 'drafts') {
    if (!allowDrafts) return { ok: true, data: EMPTY_SECTIONS };
    const drafts = await page('draft');
    if (!drafts.ok) {
      logger.warn('post picker: drafts load failed', { error: drafts.error.message });
      return { ok: false, message: POSTS_LOAD_FAILED };
    }
    return {
      ok: true,
      data: {
        sections: buildPickerSections({
          mode,
          role,
          review: [],
          approved: [],
          drafts: drafts.data.rows,
        }),
        olderApprovedCount: 0,
      },
    };
  }
  const since = recentApprovedSince(params.now);
  const posts = mode === 'posts';
  const [review, approved, parked, rejected, drafts, older] = await Promise.all([
    page('review'),
    listPostsForPickerPage(client, {
      workspaceId,
      stage: 'approved',
      enteredSince: since,
      limit: PICKER_PAGE_SIZE,
    }),
    posts ? page('parked') : Promise.resolve(null),
    posts ? page('rejected') : Promise.resolve(null),
    !posts && allowDrafts ? page('draft') : Promise.resolve(null),
    countPostsForPicker(client, { workspaceId, stage: 'approved', enteredBefore: since }),
  ]);
  for (const result of [review, approved, parked, rejected, drafts, older]) {
    if (result !== null && !result.ok) {
      logger.warn('post picker: sections load failed', { error: result.error.message });
      return { ok: false, message: POSTS_LOAD_FAILED };
    }
  }
  if (!review.ok || !approved.ok || !older.ok) return { ok: false, message: POSTS_LOAD_FAILED };
  const rows = (result: typeof parked): PostPickerPageRow[] =>
    result !== null && result.ok ? result.data.rows : [];
  return {
    ok: true,
    data: {
      sections: buildPickerSections({
        mode,
        role,
        review: review.data.rows,
        approved: approved.data.rows,
        parked: rows(parked),
        rejected: rows(rejected),
        drafts: drafts !== null && drafts.ok ? drafts.data.rows : null,
      }),
      olderApprovedCount: older.data,
    },
  };
}

/**
 * Link mode's default view, two reads in parallel (never one per row): the
 * posts due on the concept's day (a day wider each side, then kept to that
 * civil day in the workspace zone), and the newest page of every post, any
 * stage (RLS shows drafts to the agency side only). Same day first, then other
 * dates newest first; no day reads only the newest page.
 */
export async function loadLinkSections(
  client: Client,
  params: { workspaceId: string; day: string | null; timeZone: string | null },
): Promise<{ ok: true; data: PickerSectionsData } | { ok: false; message: string }> {
  const { workspaceId, day } = params;
  const zone = params.timeZone ?? undefined;
  const sameDayRead =
    day !== null
      ? client
          .from('posts')
          .select(POST_PICKER_PAGE_COLUMNS)
          .eq('workspace_id', workspaceId)
          .is('deleted_at', null)
          .gte('target_date', `${shiftDay(day, -1)}T00:00:00Z`)
          .lt('target_date', `${shiftDay(day, 2)}T00:00:00Z`)
          .order('created_at', { ascending: false })
          .order('id', { ascending: false })
          .limit(PICKER_PAGE_SIZE)
      : null;
  const [newest, sameDay] = await Promise.all([
    listPostsForPickerPage(client, { workspaceId, limit: PICKER_PAGE_SIZE }),
    sameDayRead,
  ]);
  if (!newest.ok || (sameDay !== null && sameDay.error !== null)) {
    logger.warn('post picker: link sections load failed', {
      error: !newest.ok ? newest.error.message : (sameDay?.error?.message ?? ''),
    });
    return { ok: false, message: POSTS_LOAD_FAILED };
  }
  const onDay = (row: PostPickerPageRow): boolean =>
    day !== null && row.target_date !== null && civilDay(row.target_date, zone) === day;
  const dayRows = ((sameDay?.data ?? []) as PostPickerPageRow[]).filter(onDay);
  return {
    ok: true,
    data: {
      sections: buildLinkSections({
        dayLabel: day !== null ? formatCivilDayHeader(day) : null,
        sameDay: dayRows,
        others: newest.data.rows.filter((r) => !onDay(r)),
      }),
      olderApprovedCount: 0,
    },
  };
}

/** "YYYY-MM-DD" shifted by whole days (calendar maths, no zone). Pure. */
function shiftDay(day: string, by: number): string {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, (d ?? 1) + by)).toISOString().slice(0, 10);
}

/**
 * One search page over the whole workspace: title/caption ILIKE plus an exact
 * number match, with the mode's stage filter (searchStageFilter). Drafts mode
 * without drafts allowed reads nothing and finds nothing. The first page (no
 * cursor) carries count:'exact' for the header; later pages do not.
 */
export async function loadSearchPage(
  client: Client,
  params: {
    workspaceId: string;
    mode: PostListMode;
    allowDrafts: boolean;
    query: PickerQuery;
    cursor: PostPickerCursor | null;
  },
): Promise<
  { ok: true; rows: PostPickerPageRow[]; count: number | null } | { ok: false; message: string }
> {
  if (params.mode === 'drafts' && !params.allowDrafts) {
    return { ok: true, rows: [], count: params.cursor === null ? 0 : null };
  }
  const result = await listPostsForPickerPage(client, {
    workspaceId: params.workspaceId,
    text: params.query.text,
    ...(params.query.number !== null ? { number: params.query.number } : {}),
    ...searchStageFilter(params.mode, params.allowDrafts),
    ...(params.cursor !== null ? { cursor: params.cursor } : {}),
    limit: PICKER_PAGE_SIZE,
    withCount: params.cursor === null,
  });
  if (!result.ok) {
    logger.warn('post picker: search page load failed', { error: result.error.message });
    return { ok: false, message: POSTS_LOAD_FAILED };
  }
  return { ok: true, rows: result.data.rows, count: result.data.count };
}

interface SearchState {
  text: string;
  rows: PostPickerPageRow[];
  count: number;
  loadingMore: boolean;
}

/**
 * A row card on the bg body, 8px apart (the list's gap). PressableRow provides
 * the width, 44px minimum, left alignment and press; card gives the 12px corners.
 * Picked: lit-selected replaces lit-card.
 */
const ROW_BASE = 'flex gap-3 border bg-panel p-3 mv-tint';

function rowClass(active: boolean): string {
  return cn(ROW_BASE, 'items-start', active ? 'lit-selected' : 'lit-card');
}

/** A post row: the 48px cover sets the height, so the text centres beside it. */
function postRowClass(active: boolean): string {
  return cn(ROW_BASE, 'items-center', active ? 'lit-selected' : 'lit-card');
}

// ---------------------------------------------------------------------------
// Session warm store: the viewer's role and the default list per workspace,
// so the picker paints at once when it opens. A chat warms it when it opens
// (warmPostPicker); the picker still reads fresh on every open and replaces
// the warm list when that read lands.
// ---------------------------------------------------------------------------

/** A warm list younger than this paints on open; older ones wait for the read. */
const WARM_TTL_MS = 2 * 60_000;
/** Rows whose covers a warm-up reads and downloads ahead: about one screen. */
const WARM_COVER_ROWS = 8;

const roleMemo = new Map<string, string | null>();
const roleInflight = new Map<string, Promise<string | null>>();
const sectionsMemo = new Map<string, { data: PickerSectionsData; at: number }>();

function roleMemoKey(workspaceId: string, userId: string): string {
  return `${workspaceId}|${userId}`;
}

/** The role read for this viewer this session, or undefined when never read. */
function rememberedRole(workspaceId: string, userId: string): string | null | undefined {
  const key = roleMemoKey(workspaceId, userId);
  return roleMemo.has(key) ? (roleMemo.get(key) ?? null) : undefined;
}

/** The viewer's role: one fetchMemberRole read per session, shared by concurrent asks. */
function roleFor(workspaceId: string, userId: string): Promise<string | null> {
  const key = roleMemoKey(workspaceId, userId);
  const known = rememberedRole(workspaceId, userId);
  if (known !== undefined) return Promise.resolve(known);
  const running = roleInflight.get(key);
  if (running !== undefined) return running;
  const read = fetchMemberRole(supabase, workspaceId, userId)
    .then((next) => {
      roleMemo.set(key, next);
      return next;
    })
    .finally(() => {
      roleInflight.delete(key);
    });
  roleInflight.set(key, read);
  return read;
}

/** The warm-list key: everything the default list depends on. Pure. */
export function sectionsMemoKey(params: {
  workspaceId: string;
  mode: PostListMode;
  allowDrafts: boolean;
  role: string | null;
}): string {
  return [params.workspaceId, params.mode, params.allowDrafts, params.role ?? ''].join('|');
}

function rememberSections(key: string, data: PickerSectionsData): void {
  sectionsMemo.set(key, { data, at: Date.now() });
}

function freshSections(key: string): PickerSectionsData | null {
  const hit = sectionsMemo.get(key);
  return hit !== undefined && Date.now() - hit.at < WARM_TTL_MS ? hit.data : null;
}

/** The first `limit` post ids of a default list, in display order. Pure. */
export function leadingPostIds(data: PickerSectionsData, limit: number): string[] {
  return data.sections.flatMap((section) => section.rows.map((row) => row.id)).slice(0, limit);
}

/**
 * Warm the Share a post list for a chat: the viewer's role, the default list,
 * and the first rows' covers and their small pictures, so tapping Share a post
 * paints everything at once. Skips the list read when a fresh one is held.
 * Never throws; a failed step just leaves the picker to read on open.
 */
export async function warmPostPicker(params: {
  workspaceId: string;
  userId: string;
  channelHasClient: boolean | null;
}): Promise<void> {
  try {
    const role = await roleFor(params.workspaceId, params.userId);
    const allowDrafts = draftsAllowed(role, params.channelHasClient);
    const key = sectionsMemoKey({
      workspaceId: params.workspaceId,
      mode: 'posts',
      allowDrafts,
      role,
    });
    let data = freshSections(key);
    if (data === null) {
      const result = await loadPickerSections(supabase, {
        workspaceId: params.workspaceId,
        role,
        now: new Date(),
        mode: 'posts',
        allowDrafts,
      });
      if (!result.ok) return;
      rememberSections(key, result.data);
      data = result.data;
    }
    const ids = leadingPostIds(data, WARM_COVER_ROWS);
    await requestPostCovers(supabase, params.workspaceId, ids);
    warmCoverImages(ids.map((id) => coverFor(params.workspaceId, id)));
  } catch (error) {
    logger.warn('post picker: warm-up failed', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export function PostPicker(props: PostPickerProps): ReactElement {
  const { workspaceId, workspaceKey, workspaces } = useWorkspace();
  // Due dates are calendar days on the workspace zone (src/lib/time.ts).
  const workspaceZone = workspaces.find((w) => w.id === workspaceId)?.timezone ?? null;
  const sheetMode = props.mode ?? 'posts';
  const mode: PickerMode = props.inline === true ? 'inline' : sheetMode;
  const reads = pickerReads(mode);
  const listMode: PostListMode | null = reads.posts && mode !== 'briefs' ? mode : null;
  const [briefs, setBriefs] = useState<BriefPickerRow[]>([]);
  const [briefFilter, setBriefFilter] = useState<BriefFilter>(DEFAULT_BRIEF_FILTER);
  const [briefLoadedKey, setBriefLoadedKey] = useState<string | null>(null);
  const [briefError, setBriefError] = useState<string | null>(null);
  const [localQuery, setQuery] = useState('');
  const query = props.query ?? localQuery;
  const [debounced, setDebounced] = useState('');
  const [sections, setSections] = useState<PickerSectionsData | null>(null);
  const [search, setSearch] = useState<SearchState | null>(null);
  const [postError, setPostError] = useState<string | null>(null);
  const { session } = useSession();
  const userId = session?.user.id ?? null;
  // The viewer's role, read once per open through fetchMemberRole (the
  // workspace context does not carry it). No post read starts until it lands,
  // so drafts never appear and then vanish. Brief mode reads no post, so no role.
  // A role already read this session (by a warm-up or an earlier open) is used
  // at once, so a warmed picker paints its list on the first frame.
  const [fetchedRole, setRole] = useState<string | null>(null);
  const [fetchedLoaded, setRoleLoaded] = useState(false);
  const memoRole =
    workspaceId !== null && userId !== null ? rememberedRole(workspaceId, userId) : undefined;
  const roleLoaded = fetchedLoaded || memoRole !== undefined;
  const role = fetchedLoaded ? fetchedRole : (memoRole ?? null);
  const allowDrafts = roleLoaded && draftsAllowed(role, props.channelHasClient ?? null);
  // The live search box text, read by async handlers to drop stale responses.
  const queryRef = useRef('');
  queryRef.current = query;

  const briefRequestKey = [workspaceId, briefFilter, query].join('|');
  const trimmed = query.trim();

  // Link mode: "Link this post" tapped with nothing picked.
  const [linkHint, setLinkHint] = useState(false);
  const linkDay = props.linkDay ?? null;

  // Reset to the default view and empty search each time the picker opens.
  useEffect(() => {
    if (props.open) {
      setBriefFilter(DEFAULT_BRIEF_FILTER);
      setQuery('');
      setDebounced('');
      setSections(null);
      setSearch(null);
      setPostError(null);
      setLinkHint(false);
    }
  }, [props.open, mode]);

  useEffect(() => {
    if (!props.open || listMode === null || workspaceId === null || userId === null) return;
    let cancelled = false;
    setRole(null);
    setRoleLoaded(false);
    void roleFor(workspaceId, userId).then((next) => {
      if (cancelled) return;
      setRole(next);
      setRoleLoaded(true);
    });
    return () => {
      cancelled = true;
    };
  }, [props.open, listMode, workspaceId, userId]);

  useEffect(() => {
    const handle = setTimeout(() => setDebounced(query.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [query]);

  // Default sections: one batch per open (and per role and mode), never per
  // row, so a shown list never swaps under the viewer.
  useEffect(() => {
    if (!props.open || listMode === null || workspaceId === null || !roleLoaded) return;
    let cancelled = false;
    const memoKey = sectionsMemoKey({ workspaceId, mode: listMode, allowDrafts, role });
    void loadPickerSections(supabase, {
      workspaceId,
      role,
      now: new Date(),
      mode: listMode,
      allowDrafts,
      ...(listMode === 'link' ? { linkDay, timeZone: workspaceZone } : {}),
    }).then((result) => {
      if (cancelled) return;
      if (result.ok) {
        // Link mode's list is per concept day: never kept for another open.
        if (listMode !== 'link') rememberSections(memoKey, result.data);
        setSections(result.data);
      } else setPostError(result.message);
    });
    return () => {
      cancelled = true;
    };
  }, [props.open, listMode, workspaceId, role, roleLoaded, allowDrafts, linkDay, workspaceZone]);

  // Search first page: one read (with count) per settled search text.
  useEffect(() => {
    if (!props.open || listMode === null || workspaceId === null || !roleLoaded) return;
    const parsed = parsePickerQuery(debounced, workspaceKey);
    if (parsed === null) return;
    const text = parsed.text;
    const number = parsed.number;
    let cancelled = false;
    void loadSearchPage(supabase, {
      workspaceId,
      mode: listMode,
      allowDrafts,
      query: { text, number },
      cursor: null,
    }).then((result) => {
      if (cancelled || queryRef.current.trim() !== text) return;
      if (!result.ok) {
        setPostError(result.message);
        return;
      }
      setPostError(null);
      setSearch({ text, rows: result.rows, count: result.count ?? 0, loadingMore: false });
    });
    return () => {
      cancelled = true;
    };
  }, [props.open, listMode, workspaceId, allowDrafts, roleLoaded, debounced, workspaceKey]);

  // A Load-more answer that lands after the picker closed or unmounted is dropped.
  const liveRef = useRef(true);
  useEffect(() => {
    liveRef.current = true;
    return () => {
      liveRef.current = false;
    };
  }, []);

  function loadMore(): void {
    if (workspaceId === null || listMode === null || search === null || search.loadingMore) return;
    const cursor = cursorAfter(search.rows);
    const current = parsePickerQuery(search.text, workspaceKey);
    if (cursor === null || current === null) return;
    const text = search.text;
    setSearch({ ...search, loadingMore: true });
    void loadSearchPage(supabase, {
      workspaceId,
      mode: listMode,
      allowDrafts,
      query: current,
      cursor,
    }).then((result) => {
      if (!liveRef.current || queryRef.current.trim() !== text) return;
      setSearch((prev) => {
        if (prev === null || prev.text !== text) return prev;
        if (!result.ok) return { ...prev, loadingMore: false };
        return { ...prev, rows: [...prev.rows, ...result.rows], loadingMore: false };
      });
      if (!result.ok) setPostError(result.message);
    });
  }

  // Briefs: one RLS-scoped read per (workspace, filter, search) change.
  useEffect(() => {
    if (!props.open || workspaceId === null || !reads.briefs) return;
    let cancelled = false;
    const status = filterBriefStatus(briefFilter);
    void listBriefsForPicker(supabase, {
      workspaceId,
      titleQuery: query,
      ...(status !== undefined ? { status } : {}),
    }).then((result) => {
      if (cancelled) return;
      setBriefError(briefsLoadError(result));
      setBriefs(result.ok ? result.data : []);
      setBriefLoadedKey(briefRequestKey);
    });
    return () => {
      cancelled = true;
    };
  }, [props.open, workspaceId, briefFilter, query, reads.briefs, briefRequestKey]);

  const count = mode === 'briefs' ? props.selectedBriefs.length : props.selected.length;
  const rowProps: PostRowContext = {
    selected: props.selected,
    onToggle: props.onToggle,
    timeZone: workspaceZone,
    sharedPostIds: props.sharedPostIds,
    excludePostIds: props.excludePostIds,
  };

  // A list warmed or read in the last WARM_TTL_MS paints at once; the fresh
  // read above replaces it when it lands.
  const baseSections =
    sections ??
    (props.open && listMode !== null && listMode !== 'link' && workspaceId !== null && roleLoaded
      ? freshSections(sectionsMemoKey({ workspaceId, mode: listMode, allowDrafts, role }))
      : null);

  // Posts already in a plan are left out before rendering, so a section
  // never shows a heading over nothing and the match count stays honest.
  const exclude = props.excludePostIds;
  const shownSections = useMemo(
    () =>
      baseSections === null || exclude === undefined || exclude.size === 0
        ? baseSections
        : {
            ...baseSections,
            sections: baseSections.sections
              .map((s) => ({ ...s, rows: s.rows.filter((r) => !exclude.has(r.id)) }))
              .filter((s) => s.rows.length > 0),
          },
    [baseSections, exclude],
  );
  const searchRows =
    search === null || exclude === undefined
      ? (search?.rows ?? [])
      : search.rows.filter((r) => !exclude.has(r.id));
  const searchCount = search === null ? 0 : search.count - (search.rows.length - searchRows.length);

  // Every listed post's cover in one batched read per new set of ids (two
  // queries, never one per row); rows paint their picture once it is in.
  const coverIds = useMemo(
    () =>
      trimmed === ''
        ? (shownSections?.sections.flatMap((s) => s.rows.map((r) => r.id)) ?? [])
        : searchRows.map((r) => r.id),
    [trimmed, shownSections, searchRows],
  );
  const covers = usePostCovers(coverIds);
  // Link mode: one selection, by id, over the rows on screen; a tap picks.
  const linkMode = mode === 'link';
  const linkId = props.linkSelectedId ?? null;
  const shownRows: readonly PostPickerPageRow[] =
    trimmed === '' ? (shownSections?.sections.flatMap((sec) => sec.rows) ?? []) : searchRows;
  const onLinkSelect = props.onLinkSelect;
  const listProps: PostRowContext = linkMode
    ? {
        ...rowProps,
        selected: linkSelection(shownRows, linkId),
        onToggle: (post) => {
          setLinkHint(false);
          onLinkSelect?.(post);
        },
        cover: covers,
      }
    : { ...rowProps, cover: covers };
  const confirmLink = (): void => {
    if (linkId === null) {
      setLinkHint(true);
      return;
    }
    props.onLinkConfirm?.();
  };

  let postBody: ReactElement;
  if (postError !== null) {
    postBody = <PickerError message={postError} />;
  } else if (trimmed === '') {
    postBody =
      shownSections === null ? (
        <PickerSkeleton />
      ) : (
        <PostSectionsView data={shownSections} mode={mode} {...listProps} />
      );
  } else if (search === null || search.text !== trimmed) {
    postBody = <PickerSkeleton />;
  } else {
    postBody = (
      <SearchResultsView
        rows={searchRows}
        count={searchCount}
        query={trimmed}
        loadingMore={search.loadingMore}
        onLoadMore={loadMore}
        {...(props.query === undefined ? { onClearSearch: () => setQuery('') } : {})}
        {...listProps}
      />
    );
  }

  if (props.inline === true) {
    return <InlinePickerPanel open={props.open}>{postBody}</InlinePickerPanel>;
  }

  return (
    <Sheet
      open={props.open}
      onClose={props.onClose}
      title={PICKER_TITLES[sheetMode]}
      // At sm+ one fixed box from the first paint: loading, empty, results
      // and filters all fill it, so the sheet never grows or shrinks.
      fixedHeight
      footer={
        linkMode ? (
          <div className="flex w-full flex-col gap-2">
            {linkHint ? <ErrorNote>{LINK_PICK_FIRST_HINT}</ErrorNote> : null}
            <Button
              variant="primary"
              data-picker-link-confirm=""
              className="w-full md:w-auto"
              onClick={confirmLink}
            >
              {LINK_CONFIRM}
            </Button>
          </div>
        ) : (
          <Button variant="primary" className="ml-auto" onClick={props.onDone ?? props.onClose}>
            {count > 0 ? `Done (${count})` : 'Done'}
          </Button>
        )
      }
    >
      <div className="flex flex-col gap-3 sm:min-h-0 sm:flex-1" data-picker-mode={sheetMode}>
        <Field label="Search">
          {(id) => (
            <div className="group/sfield relative">
              <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-fg-3 group-focus-within/sfield:text-fg">
                <IconSearch size={ICON_SIZE.inline} />
              </span>
              <Input
                tone="search"
                id={id}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={mode === 'briefs' ? 'Search briefs' : 'Search posts'}
                className="pl-9"
              />
            </div>
          )}
        </Field>

        {mode !== 'briefs' ? (
          postBody
        ) : (
          <>
            <div className="flex flex-wrap gap-2">
              {BRIEF_FILTERS.map((option) => (
                <Chip
                  key={option.key}
                  label={option.label}
                  size="tap"
                  selected={briefFilter === option.key}
                  onClick={() => setBriefFilter(option.key)}
                />
              ))}
            </div>

            <BriefPickerList
              briefs={briefs}
              loading={briefLoadedKey !== briefRequestKey}
              error={briefError}
              selected={props.selectedBriefs}
              onToggle={props.onToggleBrief}
              workspaceZone={workspaceZone}
              query={trimmed}
              filtersActive={briefFilter !== DEFAULT_BRIEF_FILTER}
              onClear={() => {
                setQuery('');
                setBriefFilter(DEFAULT_BRIEF_FILTER);
              }}
            />
          </>
        )}
      </div>
    </Sheet>
  );
}

/**
 * The inline picker's panel: the posts list in a bordered panel, full width of
 * its anchor, capped in height. No motion; nothing renders while closed.
 */
export function InlinePickerPanel(props: {
  open: boolean;
  children: ReactElement;
}): ReactElement | null {
  if (!props.open) return null;
  return (
    <div
      data-post-picker-inline=""
      role="region"
      aria-label="Bring a post into the conversation"
      className="flex max-h-[45dvh] flex-col overflow-y-auto rounded-lg border bg-panel lit-overlay [&>ul]:mx-0 [&>ul]:max-h-none [&>ul]:border-t-0"
    >
      {props.children}
    </div>
  );
}

/** What every post row needs besides the row itself. */
export interface PostRowContext {
  selected: readonly PostCardFields[];
  onToggle: (post: PostCardFields) => void;
  /** The workspace zone each row's target (due) date renders on. Absent: the device zone. */
  timeZone?: string | null | undefined;
  sharedPostIds?: ReadonlySet<string> | undefined;
  /** Post ids whose rows are not rendered (already in the plan being added to). */
  excludePostIds?: ReadonlySet<string> | undefined;
  /** Each row's post with its cover; absent, rows show the neutral glyph. */
  cover?: CoverLookup | undefined;
}

const LIST_CLASS =
  '-mx-4 flex max-h-[50dvh] flex-col gap-2 overflow-y-auto bg-bg px-4 py-2 sm:max-h-none sm:min-h-0 sm:flex-1';

/** Loading state: three static placeholder rows (no motion). */
export function PickerSkeleton(): ReactElement {
  return (
    <ul aria-busy="true" aria-label="Loading posts" className={LIST_CLASS}>
      {[0, 1, 2].map((i) => (
        <li
          key={i}
          data-skeleton-row=""
          className="flex min-h-11 items-center gap-3 rounded-xl border bg-panel p-3 lit-card"
        >
          <span className="h-12 w-12 shrink-0 rounded-lg bg-panel-3" />
          <span className="flex min-w-0 flex-1 flex-col gap-1.5">
            <span className="h-3 w-2/3 rounded bg-panel-3" />
            <span className="h-3 w-1/3 rounded bg-panel-2" />
          </span>
        </li>
      ))}
    </ul>
  );
}

function PickerError({ message }: { message: string }): ReactElement {
  return (
    <div
      role="alert"
      className="rounded-xl border border-bad bg-bad-soft px-4 py-3 text-base text-bad lit-tint"
    >
      {message}
    </div>
  );
}

function SectionHeading({ label, mono }: { label: string; mono?: boolean }): ReactElement {
  return (
    <li
      className={cn(
        `px-1 pt-2 ${TEXT_ROLE.section}`,
        // A date heading (link mode's day section): font-mono like every date.
        mono === true && 'font-mono tabular-nums',
      )}
    >
      {label}
    </li>
  );
}

/** The default view: sections in order, then the older-approved footer. */
export function PostSectionsView(
  props: PostRowContext & { data: PickerSectionsData; mode?: PickerMode },
): ReactElement {
  const footer = olderApprovedFooter(props.data.olderApprovedCount);
  if (props.data.sections.length === 0 && footer === null) {
    const empty = sectionsEmptyCopy(props.mode ?? 'posts');
    return <EmptyState icon={<IconPipeline size={ICON_SIZE.tray} />} {...empty} />;
  }
  return (
    <ul className={LIST_CLASS}>
      {props.data.sections.map((section) => (
        <li key={section.key} data-section={section.key}>
          <ul className="flex flex-col gap-2">
            <SectionHeading label={section.label} mono={section.key === 'day'} />
            {section.rows.map((post) => (
              <PostRow key={post.id} post={post} {...props} />
            ))}
          </ul>
        </li>
      ))}
      {footer !== null ? <li className="px-4 py-3 text-sm text-fg-3">{footer}</li> : null}
    </ul>
  );
}

/** The empty default view's one line per mode. */
export function sectionsEmptyCopy(mode: PickerMode): { title: string } {
  if (mode === 'drafts') return { title: 'Drafts show up here.' };
  if (mode === 'inline') return { title: 'Posts in review and recently approved show up here.' };
  return { title: 'Posts show up here.' };
}

/** The search no-match line, naming the trimmed query (the NoResults copy). */
export function searchEmptyTitle(query: string): string {
  return noResultsCopy(query, false).title;
}

/** The briefs tab's empty line when no search or filter is narrowing it. */
export const BRIEFS_EMPTY_COPY = 'Briefs show up here.';

/** Search results: "<N> matches", the rows, and a "Load 50 more" row while more remain. */
export function SearchResultsView(
  props: PostRowContext & {
    rows: PostPickerPageRow[];
    count: number;
    /** The search text; the no-match line names it. */
    query: string;
    loadingMore: boolean;
    onLoadMore: () => void;
    /** Clears the search box; absent (inline, the composer owns the text) shows the line alone. */
    onClearSearch?: () => void;
  },
): ReactElement {
  if (props.rows.length === 0) {
    return props.onClearSearch !== undefined ? (
      <NoResults query={props.query} filtersActive={false} onClear={props.onClearSearch} />
    ) : (
      <EmptyState
        compact
        icon={<IconSearch size={ICON_SIZE.control} />}
        title={searchEmptyTitle(props.query)}
      />
    );
  }
  return (
    <ul className={LIST_CLASS}>
      <SectionHeading label={matchesLabel(props.count)} />
      {props.rows.map((post) => (
        <PostRow key={post.id} post={post} {...props} />
      ))}
      {hasMoreResults(props.rows.length, props.count) ? (
        <li>
          <PressableRow
            type="button"
            onClick={props.onLoadMore}
            disabled={props.loadingMore}
            flat
            className="flex items-center justify-between gap-3 px-4 py-3 text-base font-medium text-accent mv-tint disabled:text-fg-3"
          >
            <span>{`Load ${PICKER_PAGE_SIZE} more`}</span>
            <span className="text-sm font-normal tabular-nums text-fg-3">
              {shownOfLabel(props.rows.length, props.count)}
            </span>
          </PressableRow>
        </li>
      ) : null}
    </ul>
  );
}

/** One post row: 48px cover, title, format · date, stage or "in this chat". */
export function PostRow(props: PostRowContext & { post: PostPickerPageRow }): ReactElement | null {
  const { post } = props;
  if (props.excludePostIds?.has(post.id) === true) return null;
  const active = isPostSelected(props.selected, post.id);
  const inChat = props.sharedPostIds?.has(post.id) === true;
  const meta = [
    formatLabel(post.format),
    post.target_date !== null ? formatDueDate(post.target_date, props.timeZone) : '',
  ]
    .filter((part) => part !== '')
    .join(' · ');
  return (
    <li>
      <PressableRow
        type="button"
        aria-pressed={active}
        card
        onClick={() => props.onToggle(post)}
        className={postRowClass(active)}
      >
        <PostCover cover={props.cover !== undefined ? props.cover(post.id) : null} />
        <span className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="flex min-w-0 items-baseline gap-1.5">
            <span className="min-w-0 flex-1 truncate text-lg font-medium text-fg">
              {post.title}
            </span>
          </span>
          <span className="truncate text-sm text-fg-2">{meta}</span>
        </span>
        <span className="flex shrink-0 items-center gap-2">
          {inChat ? (
            <span className="text-sm text-fg-3">in this chat</span>
          ) : isTagDot(post.stage) ? (
            <Tag label={stageLabel(post.stage)} dot={post.stage} />
          ) : null}
          {active ? (
            <span className="text-accent">
              <IconCheck size={ICON_SIZE.nav} />
            </span>
          ) : null}
        </span>
      </PressableRow>
    </li>
  );
}

export function BriefPickerList(props: {
  briefs: BriefPickerRow[];
  loading: boolean;
  error: string | null;
  selected: readonly BriefCardFields[];
  onToggle: (brief: BriefCardFields) => void;
  /** For tests: the zone moments render in. The app passes none (the viewer's device zone). */
  timeZone?: string | undefined;
  /** The workspace zone each brief's due date renders on. Absent: the device zone. */
  workspaceZone?: string | null | undefined;
  /** The live search text; a search or a non-default filter turns zero rows into NoResults. */
  query?: string;
  filtersActive?: boolean;
  onClear?: () => void;
}): ReactElement {
  if (props.loading) {
    return listSkeleton('Loading briefs');
  }
  if (props.error !== null) {
    return (
      <div
        role="alert"
        className="rounded-xl border border-bad bg-bad-soft px-4 py-3 text-base text-bad lit-tint"
      >
        {props.error}
      </div>
    );
  }
  if (props.briefs.length === 0) {
    const narrowed = (props.query ?? '').trim() !== '' || props.filtersActive === true;
    if (narrowed && props.onClear !== undefined) {
      return (
        <NoResults
          query={props.query ?? ''}
          filtersActive={props.filtersActive === true}
          onClear={props.onClear}
        />
      );
    }
    return <EmptyState icon={<IconBriefs size={ICON_SIZE.tray} />} title={BRIEFS_EMPTY_COPY} />;
  }
  return (
    <ul className={LIST_CLASS}>
      {props.briefs.map((brief) => {
        const active = isBriefSelected(props.selected, brief.id);
        const target =
          brief.targetDate !== null ? formatDueDate(brief.targetDate, props.workspaceZone) : '';
        return (
          <li key={brief.id}>
            <PressableRow
              type="button"
              aria-pressed={active}
              card
              onClick={() => props.onToggle(brief)}
              className={rowClass(active)}
            >
              <span className="flex min-w-0 flex-1 flex-col gap-1">
                <span className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate text-lg font-medium text-fg">
                    {brief.title}
                  </span>
                  <Tag
                    label={briefStatusLabel(brief.status)}
                    tone={brief.status === 'closed' ? 'neutral' : 'good'}
                  />
                </span>
                {brief.objective.trim() !== '' ? (
                  <span className="line-clamp-2 text-base text-fg-2 [overflow-wrap:anywhere]">
                    {brief.objective}
                  </span>
                ) : null}
                <span className="flex flex-wrap items-center gap-2">
                  {brief.formatRequested !== null && brief.formatRequested !== '' ? (
                    <Tag label={formatLabel(brief.formatRequested)} />
                  ) : null}
                  {target !== '' ? (
                    <span className="text-sm text-fg-2">{`Target ${target}`}</span>
                  ) : null}
                  <span className="flex-1" />
                  <span className="text-sm text-fg-2">
                    {`${briefPostCountLabel(brief.postCount)} · Raised ${formatDate(brief.createdAt, undefined, props.timeZone)}`}
                  </span>
                </span>
              </span>
              {active ? (
                <span className="shrink-0 pt-0.5 text-accent">
                  <IconCheck size={ICON_SIZE.nav} />
                </span>
              ) : null}
            </PressableRow>
          </li>
        );
      })}
    </ul>
  );
}
