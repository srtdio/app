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

import { useEffect, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { Button } from '@/components/ui/Button';
import { Chip } from '@/components/ui/Chip';
import { EmptyState } from '@/components/ui/EmptyState';
import { Field } from '@/components/ui/Field';
import { Input } from '@/components/ui/Input';
import { Sheet } from '@/components/ui/Sheet';
import { Tag, isTagDot } from '@/components/ui/Tag';
import { IconBriefs, IconCheck, IconPipeline, IconSearch } from '@/components/ui/icons';
import { stageLabel } from '@/components/pages/pipeline/stage-meta';
import { fetchMemberRole } from '@/lib/chat/viewer-role';
import { cn } from '@/lib/cn';
import { formatEntityRef } from '@/lib/entityRef';
import { formatLabel } from '@/lib/post-detail-presentation';
import { logger } from '@/lib/logger';
import { useSession } from '@/lib/session-context';
import { supabase } from '@/lib/supabase';
import { useWorkspace } from '@/lib/workspace-context';
import type { Client } from '@srtdio/rpc';
import type { PostCardFields } from '@srtdio/posts';
import {
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
import { formatShortDate, formatShortDateOnly, workspaceTimeZone } from '@/lib/chat/time-format';
import {
  PICKER_PAGE_SIZE,
  buildPickerSections,
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

/** Search debounce, in milliseconds. */
export const SEARCH_DEBOUNCE_MS = 200;

interface PostPickerProps {
  open: boolean;
  onClose: () => void;
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
}

/** The sheet title per mode. */
export const PICKER_TITLES: Record<Exclude<PickerMode, 'inline'>, string> = {
  posts: 'Share a post',
  drafts: 'Share a draft',
  briefs: 'Share a brief',
};

/** The default view's data: the sections plus the older-approved count. */
export interface PickerSectionsData {
  sections: Array<PickerSection<PostPickerPageRow>>;
  olderApprovedCount: number;
}

/** The picker's error line when a posts read fails; the raw text is only logged. */
export const POSTS_LOAD_FAILED = "Couldn't load posts, try again";

/** The picker's error line when the briefs read fails; the raw text is only logged. */
export const BRIEFS_LOAD_FAILED = "Couldn't load briefs, try again";

/** The briefs tab's error line for a read: fixed copy on failure (raw text logged), else null. */
export function briefsLoadError(
  result: { ok: true } | { ok: false; error: { message: string } },
): string | null {
  if (result.ok) return null;
  logger.warn('post picker: briefs load failed', { error: result.error.message });
  return BRIEFS_LOAD_FAILED;
}

/** The modes that read posts. */
export type PostListMode = Exclude<PickerMode, 'briefs'>;

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
  },
): Promise<{ ok: true; data: PickerSectionsData } | { ok: false; message: string }> {
  const { workspaceId, role, mode, allowDrafts } = params;
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

/** Full-width row: hairline divider, 44px minimum, no rounded card. */
function rowClass(active: boolean): string {
  return cn(
    'flex w-full items-start gap-3 border-b border-border px-4 py-3 min-h-[44px] text-left transition-colors',
    active ? 'bg-accent-soft' : 'hover:bg-panel-2',
  );
}

export function PostPicker(props: PostPickerProps): ReactElement {
  const { workspaceId, workspaceKey, workspaces } = useWorkspace();
  const timeZone = workspaceTimeZone(workspaces.find((w) => w.id === workspaceId)?.timezone);
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
  const [role, setRole] = useState<string | null>(null);
  const [roleLoaded, setRoleLoaded] = useState(false);
  const allowDrafts = roleLoaded && draftsAllowed(role, props.channelHasClient ?? null);
  // The live search box text, read by async handlers to drop stale responses.
  const queryRef = useRef('');
  queryRef.current = query;

  const briefRequestKey = [workspaceId, briefFilter, query].join('|');
  const trimmed = query.trim();

  // Reset to the default view and empty search each time the picker opens.
  useEffect(() => {
    if (props.open) {
      setBriefFilter(DEFAULT_BRIEF_FILTER);
      setQuery('');
      setDebounced('');
      setSections(null);
      setSearch(null);
      setPostError(null);
    }
  }, [props.open, mode]);

  useEffect(() => {
    if (!props.open || listMode === null || workspaceId === null || userId === null) return;
    let cancelled = false;
    setRole(null);
    setRoleLoaded(false);
    void fetchMemberRole(supabase, workspaceId, userId).then((next) => {
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
    void loadPickerSections(supabase, {
      workspaceId,
      role,
      now: new Date(),
      mode: listMode,
      allowDrafts,
    }).then((result) => {
      if (cancelled) return;
      if (result.ok) setSections(result.data);
      else setPostError(result.message);
    });
    return () => {
      cancelled = true;
    };
  }, [props.open, listMode, workspaceId, role, roleLoaded, allowDrafts]);

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
    workspaceKey,
    timeZone,
    sharedPostIds: props.sharedPostIds,
  };

  let postBody: ReactElement;
  if (postError !== null) {
    postBody = <PickerError message={postError} />;
  } else if (trimmed === '') {
    postBody =
      sections === null ? (
        <PickerSkeleton />
      ) : (
        <PostSectionsView data={sections} mode={mode} {...rowProps} />
      );
  } else if (search === null || search.text !== trimmed) {
    postBody = <PickerSkeleton />;
  } else {
    postBody = (
      <SearchResultsView
        rows={search.rows}
        count={search.count}
        loadingMore={search.loadingMore}
        onLoadMore={loadMore}
        {...rowProps}
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
      footer={
        <Button variant="primary" size="lg" className="ml-auto" onClick={props.onClose}>
          {count > 0 ? `Done (${count})` : 'Done'}
        </Button>
      }
    >
      <div className="flex flex-col gap-3" data-picker-mode={sheetMode}>
        <Field label="Search">
          <div className="relative">
            <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-fg-3">
              <IconSearch size={16} />
            </span>
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={mode === 'briefs' ? 'Search all briefs' : 'Search by word or number'}
              className="pl-9"
            />
          </div>
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
              workspaceKey={workspaceKey}
              timeZone={timeZone}
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
      className="flex max-h-[45vh] flex-col overflow-y-auto rounded-lg border border-border bg-panel [&>ul]:mx-0 [&>ul]:max-h-none [&>ul]:border-t-0"
    >
      {props.children}
    </div>
  );
}

/** What every post row needs besides the row itself. */
export interface PostRowContext {
  selected: readonly PostCardFields[];
  onToggle: (post: PostCardFields) => void;
  workspaceKey: string | null;
  timeZone: string;
  sharedPostIds?: ReadonlySet<string> | undefined;
}

const LIST_CLASS = '-mx-[18px] flex max-h-[50vh] flex-col overflow-y-auto border-t border-border';

/** Loading state: three static placeholder rows (no motion). */
export function PickerSkeleton(): ReactElement {
  return (
    <ul aria-busy="true" aria-label="Loading posts" className={LIST_CLASS}>
      {[0, 1, 2].map((i) => (
        <li
          key={i}
          data-skeleton-row=""
          className="flex min-h-[44px] items-center gap-3 border-b border-border px-4 py-3"
        >
          <span className="h-9 w-9 shrink-0 rounded-md bg-panel-3" />
          <span className="flex min-w-0 flex-1 flex-col gap-1.5">
            <span className="h-3.5 w-2/3 rounded bg-panel-3" />
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
      className="rounded-xl border border-bad bg-bad-soft px-4 py-3 text-sm text-bad"
    >
      {message}
    </div>
  );
}

function SectionHeading({ label }: { label: string }): ReactElement {
  return (
    <li className="border-b border-border bg-panel-2 px-4 py-2 text-xs font-medium text-fg-2">
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
    return <EmptyState icon={<IconPipeline size={22} />} {...empty} />;
  }
  return (
    <ul className={LIST_CLASS}>
      {props.data.sections.map((section) => (
        <li key={section.key} data-section={section.key}>
          <ul>
            <SectionHeading label={section.label} />
            {section.rows.map((post) => (
              <PostRow key={post.id} post={post} {...props} />
            ))}
          </ul>
        </li>
      ))}
      {footer !== null ? <li className="px-4 py-3 text-xs text-fg-3">{footer}</li> : null}
    </ul>
  );
}

/** The empty default view's copy per mode. */
export function sectionsEmptyCopy(mode: PickerMode): { title: string; description: string } {
  if (mode === 'drafts') return { title: 'No drafts', description: 'No post is in draft.' };
  if (mode === 'inline') {
    return { title: 'No posts', description: 'Nothing is waiting or recently approved.' };
  }
  return {
    title: 'No posts',
    description: 'Nothing is waiting, approved, parked or rejected.',
  };
}

/** Search results: "<N> matches", the rows, and a "Load 50 more" row while more remain. */
export function SearchResultsView(
  props: PostRowContext & {
    rows: PostPickerPageRow[];
    count: number;
    loadingMore: boolean;
    onLoadMore: () => void;
  },
): ReactElement {
  if (props.rows.length === 0) {
    return (
      <EmptyState
        icon={<IconPipeline size={22} />}
        title="No matches"
        description="Try another word or a post number."
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
          <button
            type="button"
            onClick={props.onLoadMore}
            disabled={props.loadingMore}
            className="flex min-h-[44px] w-full items-center justify-between gap-3 px-4 py-3 text-left text-sm font-medium text-accent transition-colors hover:bg-panel-2 disabled:text-fg-3"
          >
            <span>{`Load ${PICKER_PAGE_SIZE} more`}</span>
            <span className="text-xs font-normal tabular-nums text-fg-3">
              {shownOfLabel(props.rows.length, props.count)}
            </span>
          </button>
        </li>
      ) : null}
    </ul>
  );
}

/** One post row: placeholder thumb, KEY · title, format · date, stage or "in this chat". */
export function PostRow(props: PostRowContext & { post: PostPickerPageRow }): ReactElement {
  const { post } = props;
  const active = isPostSelected(props.selected, post.id);
  const inChat = props.sharedPostIds?.has(post.id) === true;
  const meta = [
    formatLabel(post.format),
    post.target_date !== null ? formatShortDate(post.target_date, props.timeZone) : '',
  ]
    .filter((part) => part !== '')
    .join(' · ');
  return (
    <li>
      <button
        type="button"
        aria-pressed={active}
        onClick={() => props.onToggle(post)}
        className={rowClass(active)}
      >
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-panel-3 text-fg-3">
          <IconPipeline size={18} />
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="flex min-w-0 items-baseline gap-1.5">
            {props.workspaceKey !== null ? (
              <>
                <span className="shrink-0 font-mono text-xs tabular-nums text-fg-3">
                  {formatEntityRef(props.workspaceKey, post.number)}
                </span>
                <span className="shrink-0 text-xs text-fg-3">·</span>
              </>
            ) : null}
            <span className="min-w-0 flex-1 truncate text-[15px] font-medium text-fg">
              {post.title}
            </span>
          </span>
          <span className="truncate text-xs text-fg-2">{meta}</span>
        </span>
        <span className="flex shrink-0 items-center gap-2 pt-0.5">
          {inChat ? (
            <span className="text-xs text-fg-3">in this chat</span>
          ) : isTagDot(post.stage) ? (
            <Tag label={stageLabel(post.stage)} dot={post.stage} />
          ) : null}
          {active ? (
            <span className="text-accent">
              <IconCheck size={18} />
            </span>
          ) : null}
        </span>
      </button>
    </li>
  );
}

function BriefPickerList(props: {
  briefs: BriefPickerRow[];
  loading: boolean;
  error: string | null;
  selected: readonly BriefCardFields[];
  onToggle: (brief: BriefCardFields) => void;
  workspaceKey: string | null;
  timeZone: string;
}): ReactElement {
  if (props.loading) {
    return <p className="px-1 py-3 text-sm text-fg-3">Loading briefs</p>;
  }
  if (props.error !== null) {
    return (
      <div
        role="alert"
        className="rounded-xl border border-bad bg-bad-soft px-4 py-3 text-sm text-bad"
      >
        {props.error}
      </div>
    );
  }
  if (props.briefs.length === 0) {
    return (
      <EmptyState
        icon={<IconBriefs size={22} />}
        title="No briefs"
        description="No briefs match this filter."
      />
    );
  }
  return (
    <ul className="-mx-[18px] flex max-h-[50vh] flex-col overflow-y-auto border-t border-border">
      {props.briefs.map((brief) => {
        const active = isBriefSelected(props.selected, brief.id);
        const target = brief.targetDate !== null ? formatShortDateOnly(brief.targetDate) : '';
        return (
          <li key={brief.id}>
            <button
              type="button"
              aria-pressed={active}
              onClick={() => props.onToggle(brief)}
              className={rowClass(active)}
            >
              <span className="flex min-w-0 flex-1 flex-col gap-1">
                <span className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate text-[15px] font-medium text-fg">
                    {brief.title}
                  </span>
                  {props.workspaceKey !== null ? (
                    <span className="shrink-0 font-mono text-xs tabular-nums text-fg-3">
                      {formatEntityRef(props.workspaceKey, brief.number)}
                    </span>
                  ) : null}
                  <Tag
                    label={briefStatusLabel(brief.status)}
                    tone={brief.status === 'closed' ? 'neutral' : 'good'}
                  />
                </span>
                {brief.objective.trim() !== '' ? (
                  <span className="line-clamp-2 text-sm text-fg-2 [overflow-wrap:anywhere]">
                    {brief.objective}
                  </span>
                ) : null}
                <span className="flex flex-wrap items-center gap-2">
                  {brief.formatRequested !== null && brief.formatRequested !== '' ? (
                    <Tag label={formatLabel(brief.formatRequested)} />
                  ) : null}
                  {target !== '' ? (
                    <span className="text-xs text-fg-2">{`Target ${target}`}</span>
                  ) : null}
                  <span className="flex-1" />
                  <span className="text-xs text-fg-2">
                    {`${briefPostCountLabel(brief.postCount)} · Raised ${formatShortDate(brief.createdAt, props.timeZone)}`}
                  </span>
                </span>
              </span>
              {active ? (
                <span className="shrink-0 pt-0.5 text-accent">
                  <IconCheck size={18} />
                </span>
              ) : null}
            </button>
          </li>
        );
      })}
    </ul>
  );
}
