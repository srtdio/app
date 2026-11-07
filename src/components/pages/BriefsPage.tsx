import { mark } from '@/lib/perf-marks';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { appPresignCache } from '@/lib/shared-presign';
import type { PresignCache } from '@/lib/asset-presign';
import type { ReactElement } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Button } from '@/components/ui/Button';
import { Chip } from '@/components/ui/Chip';
import { EmptyState } from '@/components/ui/EmptyState';
import { SortMenu } from '@/components/ui/SortMenu';
import { LoadError } from '@/components/ui/LoadError';
import { useOptionalToast } from '@/components/ui/toast';
import type { ToastOptions } from '@/components/ui/toast/types';
import { PageHead } from '@/components/shell/PageHead';
import { SectionHeader } from '@/components/shell/SectionHeader';
import { TopbarPlus, useTopbarActions } from '@/components/shell/topbar-actions';
import { ICON_SIZE, IconBriefs } from '@/components/ui/icons';
import { BriefCard, BRIEF_STATUS } from '@/components/pages/BriefCard';
import { CreateBriefSheet, type BriefCreated } from '@/components/pages/CreateBriefSheet';
import { dispatchSorted } from '@/lib/events';
import { useWorkspaceDataChanged } from '@/lib/use-workspace-data-changed';
import { env } from '@/lib/env';
import { supabase } from '@/lib/supabase';
import { useWorkspace } from '@/lib/workspace-context';
import { useWorkspaceCapability } from '@/lib/workspace-context-capability';
import { entityUrlPath } from '@/lib/entityRef';
import { useSort } from '@/lib/use-sort';
import {
  BRIEF_SORT_DEFAULT,
  BRIEF_SORT_OPTIONS,
  sanitizeBriefSort,
  sortBriefs,
  type BriefSort,
} from '@/lib/brief-sort';
import {
  BRIEF_NOTE_PARAM,
  briefListParams,
  filterBriefsByStatus,
  listBriefsFirstPage,
  listBriefsPage,
  mergeBriefPages,
  parseBriefFilter,
  BRIEF_FILTER_DEFAULT,
  withBriefThumbnails,
  type BriefFilter,
  type BriefPageNext,
} from '@/lib/brief-list';
import { countBriefsByFilter } from '@/lib/brief-counts';
import {
  briefsPaintNeedsThumbs,
  keptBriefCounts,
  keptBriefsList,
  primeBriefsList,
  readBriefCounts,
  readBriefsFirstPage,
  staleBriefsReads,
  withKeptBriefsTail,
} from '@/lib/brief-list-shared';
import { getPrefetchContext } from '@/lib/prefetch-context';
import { keptViewKey, useKeptScroll, useKeptState, useUntouched } from '@/lib/kept-view';
import { SHELL_STICKY_TOP_CLASS } from '@/lib/scroll-mode';
import { logger } from '@/lib/logger';
import { READ_TIMEOUT_MS } from '@/lib/chat-reads';
import {
  groupBriefsByDay,
  groupBriefsByTime,
  type BriefCalendar,
  type BriefGroup,
} from '@/lib/brief-groups';
import { cn } from '@/lib/cn';
import { LIST_CARD_GRID, ListCardBox } from '@/components/ui/ListCard';
import { useMinuteClock } from '@/components/ui/use-minute-clock';
import { GUTTER } from '@/components/ui/layout';
import { Bone, BoxSkeleton, useHadBoxes, useSettleOnLanding } from '@/lib/motion';
import type { BriefWithThumbnail } from '@srtdio/briefs';
import { INDUCTION_KEYS } from '@/lib/induction';
import { errorText } from '@/lib/error-copy';
import { Text } from '@/components/ui/Text';

// Filter chips: All shows everything; Open/Closed key off brief.status. The
// status keys come from the @srtdio/briefs type, never inline literals.
const FILTERS: { key: BriefFilter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: BRIEF_STATUS.open, label: 'Open' },
  { key: BRIEF_STATUS.closed, label: 'Closed' },
];

interface BriefsHeaderProps {
  filter: BriefFilter;
  onFilterChange: (filter: BriefFilter) => void;
  /**
   * Per-chip brief counts, read on the server, never from the loaded page; a
   * chip shows its count only above 0, as plain text.
   */
  counts?: Partial<Record<BriefFilter, number>>;
}

/**
 * The Briefs chip row (decisions A, B): the shared SectionHeader with the All
 * / Open / Closed chips. Sort and New brief live in the app top bar
 * ({@link briefsTopbarActions}); search lives only in the top bar's command
 * palette. Pure (no hooks) so the wiring is unit-tested by walking the
 * returned tree.
 */
export function briefsHeader(props: BriefsHeaderProps): ReactElement {
  return (
    <SectionHeader>
      {FILTERS.map((item) => (
        <Chip
          key={item.key}
          label={item.label}
          {...(props.counts?.[item.key] !== undefined ? { count: props.counts[item.key] } : {})}
          selected={props.filter === item.key}
          size="tap"
          className="flex-none whitespace-nowrap"
          onClick={() => props.onFilterChange(item.key)}
        />
      ))}
    </SectionHeader>
  );
}

/** What Briefs publishes into the app top bar. */
export interface BriefsTopbarProps {
  /** Whether the viewer holds brief.create; the "+" shows only then. */
  canCreate: boolean;
  /**
   * The agency-side sort (Due date / Newest first). Omitted for client
   * approvers: their list stays grouped by time, so they get no sort.
   */
  sort?: { value: BriefSort; onChange: (value: BriefSort) => void };
}

/**
 * The top bar's sort and primary for Briefs (decision A): sort is the shared
 * SortMenu over BRIEF_SORT_OPTIONS (agency side only); primary is the filled
 * "+" labelled "New brief", carrying the old New brief induction key, only
 * where the person holds brief.create. Pure (no hooks).
 */
export function briefsTopbarActions(props: BriefsTopbarProps): {
  sort: ReactElement | undefined;
  primary: ReactElement | undefined;
} {
  return {
    sort:
      props.sort !== undefined ? (
        <SortMenu
          options={BRIEF_SORT_OPTIONS}
          value={props.sort.value}
          onChange={props.sort.onChange}
          label="Sort"
        />
      ) : undefined,
    primary: props.canCreate ? (
      <TopbarPlus
        label="New brief"
        induction={INDUCTION_KEYS.briefsNew}
        onClick={() => dispatchSorted('sorted:create-brief')}
      />
    ) : undefined,
  };
}

interface BriefCardListDeps {
  briefs: BriefWithThumbnail[];
  /** The ONE page-owned cache, threaded unchanged into every card (no per-card cache). */
  cache: PresignCache;
  presignEnabled: boolean;
  /** The detail path for a brief (pretty /b/KEY-N when known). */
  hrefFor: (brief: BriefWithThumbnail) => string;
  /** The workspace zone each card's due date reads on. Absent: the device zone. */
  timeZone?: string;
  /** The list's one clock (useMinuteClock) every card's time reads against. Default: now. */
  now?: Date;
}

/**
 * Map the visible briefs to their cards, threading the single shared presign cache
 * and presignEnabled into each. Pure (no hooks) so the wiring (one cache shared
 * across cards, per-brief link) is unit-tested without rendering the
 * page, mirroring briefsHeader.
 */
export function briefCardList(deps: BriefCardListDeps): ReactElement[] {
  return deps.briefs.map((brief) => (
    <BriefCard
      key={brief.id}
      brief={brief}
      cache={deps.cache}
      presignEnabled={deps.presignEnabled}
      href={deps.hrefFor(brief)}
      timeZone={deps.timeZone}
      now={deps.now}
    />
  ));
}

/** Which empty state the list shows when no card is visible. */
export type BriefsEmpty =
  /** A client with no open briefs: one line (the header's New brief is the only create). */
  | { kind: 'client-empty' }
  /** The agency side with no briefs at all: one line, no heading. */
  | { kind: 'agency-empty' }
  /** A chip with nothing under it: one line only. */
  | { kind: 'filtered'; title: string };

/**
 * Pick the empty state. A workspace with no briefs at all (client or agency
 * copy), then the chip: Closed has its own heading; a client on Open (nothing
 * open) gets the "Open briefs show up here." state. Pure.
 */
export function briefsEmptyState(
  filter: BriefFilter,
  total: number,
  canCreate: boolean,
): BriefsEmpty {
  if (total === 0) return canCreate ? { kind: 'client-empty' } : { kind: 'agency-empty' };
  if (filter === BRIEF_STATUS.closed)
    return { kind: 'filtered', title: 'Closed briefs show up here.' };
  if (canCreate) return { kind: 'client-empty' };
  return { kind: 'filtered', title: 'Open briefs show up here.' };
}

/**
 * The agency-side flat list: status chip, then the chosen sort. Re-narrows
 * each surviving row back to its BriefWithThumbnail (same object reference)
 * via an id map, as {@link deriveBriefGroups} does. Pure.
 */
export function deriveSortedBriefs(
  briefs: BriefWithThumbnail[],
  filter: BriefFilter,
  sort: BriefSort,
): BriefWithThumbnail[] {
  const byId = new Map(briefs.map((brief) => [brief.id, brief]));
  const filtered = filterBriefsByStatus(briefs, filter);
  const narrowed = filtered.flatMap((brief) => {
    const full = byId.get(brief.id);
    return full !== undefined ? [full] : [];
  });
  return sortBriefs(narrowed, sort);
}

const LIST_CLASS = cn(GUTTER, 'py-4 flex flex-col gap-6');
// ui/ListCard's page grid: one column on phone, auto-fill columns (at least 360)
// on laptop, 12 between cards.
const GRID_CLASS = cn('pt-3', LIST_CARD_GRID);

/** The longest the first paint waits for the chip counts once the rows are in. */
export const BRIEF_COUNTS_PAINT_WAIT_MS = 5_000;

/** The Load more failure toast: "Couldn't {action}. {reason}". */
export const BRIEFS_LOAD_MORE_FAILED = errorText('load more briefs', null);

/**
 * The Load more control under the list: the shared secondary Button (44 tall,
 * token classes only, so light and dark match), shown only while another page
 * exists. Pure (no hooks) so the show/hide rule is unit-tested directly.
 */
export function briefsLoadMore(
  next: BriefPageNext,
  loadingMore: boolean,
  onLoadMore: () => void,
): ReactElement[] {
  if (next.done) return [];
  return [
    <div key="load-more" className={cn(GUTTER, 'pb-6 flex justify-center')}>
      <Button
        variant="secondary"
        type="button"
        data-briefs-load-more=""
        disabled={loadingMore}
        aria-busy={loadingMore}
        onClick={onLoadMore}
      >
        Load more
      </Button>
    </div>,
  ];
}

/**
 * The loading state: a static skeleton in the real list's shape (a section
 * header bar, a day label, then ui/ListCardBox: the ListCard's 74 frame, 48
 * picture and two lines), in the same container and grid, so nothing
 * jumps when the cards arrive. Shared Bone boxes (a top-lit sweep, never a pulse).
 */
export function BriefsListSkeleton(): ReactElement {
  return (
    <BoxSkeleton
      lit="flat"
      label="Loading briefs"
      data-testid="briefs-skeleton"
      className={LIST_CLASS}
    >
      <section>
        <div className="py-2">
          <Bone lit="flat" as="div" className="h-5 w-24 rounded" />
        </div>
        <div className="pt-3 pb-1">
          <Bone lit="flat" as="div" className="h-4 w-14 rounded" />
        </div>
        <div className={GRID_CLASS}>
          {[0, 1, 2].map((key) => (
            <ListCardBox key={key} data-brief-card-skeleton="" />
          ))}
        </div>
      </section>
    </BoxSkeleton>
  );
}

/**
 * Derive the rendered time sections from the loaded list: status chip, then
 * time grouping (newest-first, workspace weeks, month buckets). `calendar`
 * carries the workspace zone and week start, so the sections read the same on
 * every machine. Section counts therefore reflect the active chip.
 * filterBriefsByStatus is typed over the bare Brief, so
 * re-narrow each surviving row back to its BriefWithThumbnail (same object
 * reference) via an id map; the cards need thumbnailAssetVersionId. Pure so the
 * wiring is unit-tested without rendering.
 */
export function deriveBriefGroups(
  briefs: BriefWithThumbnail[],
  filter: BriefFilter,
  now: Date,
  calendar: BriefCalendar,
): BriefGroup<BriefWithThumbnail>[] {
  const byId = new Map(briefs.map((brief) => [brief.id, brief]));
  const filtered = filterBriefsByStatus(briefs, filter);
  const narrowed = filtered.flatMap((brief) => {
    const full = byId.get(brief.id);
    return full !== undefined ? [full] : [];
  });
  return groupBriefsByTime(narrowed, now, calendar);
}

interface BriefSectionsDeps extends Omit<BriefCardListDeps, 'briefs'> {
  groups: BriefGroup<BriefWithThumbnail>[];
  /** The workspace zone the day headings inside each section are read in. */
  timeZone: string;
  /** The clock the day headings' year rule and every card's time read. Default: now. */
  now?: Date;
}

// Sticky per-section header: pinned to the top of the scroll area (below the app
// top bar) on a solid bg-bg, lit as a header (lit-header) so cards slide under
// its shade. var(--bg) flips with the theme, so light/dark parity is automatic; z-sticky sits
// above the card grid, matching SectionHeader's sticky choice. Positioning only:
// no transforms, no transitions.
// In page mode on a phone or a touch tablet the window scrolls, so it pins
// below the sticky Topbar instead (SHELL_STICKY_TOP_CLASS; 0 in <main> and on laptop).
const SECTION_HEADER_CLASS = cn(
  'sticky z-sticky -mx-4 md:-mx-6 px-4 md:px-6 py-2 flex items-center justify-between',
  SHELL_STICKY_TOP_CLASS,
  'bg-bg lit-header',
);

// The day heading inside a time section: which day the briefs below it were
// raised on, in the workspace zone. Deliberately NOT sticky and not interactive
// (the section header above it already pins), so it is a plain label: token
// colours only, so light/dark parity is automatic, and no motion.
const DAY_HEADING_CLASS = 'pt-3 pb-1 text-sm font-medium text-fg-2';

/**
 * One section per time group: a sticky label header, then, for every
 * civil day inside that group (newest-first, workspace zone), a day heading
 * followed by the existing card grid for that day's briefs. Pure (no hooks) so
 * the section labels, day headings and per-group card wiring are
 * unit-tested by walking the tree, mirroring briefCardList.
 */
export function briefSections(deps: BriefSectionsDeps): ReactElement[] {
  const { groups, timeZone, now = new Date(), ...cardDeps } = deps;
  return groups.map((group) => (
    <section key={group.key}>
      {/* No count here: counts live on the chips only. */}
      <div className={SECTION_HEADER_CLASS}>
        <Text as="h3" role="section">
          {group.label}
        </Text>
      </div>
      {groupBriefsByDay(group.items, timeZone, now).flatMap((day) => [
        <div key={`${day.key}-label`} className={DAY_HEADING_CLASS}>
          {day.label}
        </div>,
        <div key={day.key} className={GRID_CLASS}>
          {briefCardList({ ...cardDeps, timeZone, now, briefs: day.items })}
        </div>,
      ])}
    </section>
  ));
}

/**
 * The toast after Create. A lost note is a partial failure: the error tone with
 * "Add note", which opens the new brief with its comment box focused; never the
 * success style. Pure apart from the navigate it is handed.
 */
export function createdToast(created: BriefCreated, navigate: (to: string) => void): ToastOptions {
  if (created.noteFailed) {
    return {
      title: 'Brief created. Your note did not post.',
      tone: 'error',
      action: {
        label: 'Add note',
        onPress: () => navigate(`/briefs/${created.briefId}?${BRIEF_NOTE_PARAM}=1`),
      },
    };
  }
  return {
    title: 'Brief created',
    tone: 'success',
    action: { label: 'Open', onPress: () => navigate(`/briefs/${created.briefId}`) },
  };
}

/**
 * Render a {@link BriefsEmpty}: the shared EmptyState with its one line. An
 * empty page has no create button of its own; the top bar's "+" is the only
 * one. Pure (no hooks).
 */
export function briefsEmptyView(state: BriefsEmpty): ReactElement {
  const icon = <IconBriefs size={ICON_SIZE.status} />;
  switch (state.kind) {
    case 'client-empty':
      return <EmptyState icon={icon} title="Open briefs show up here." />;
    case 'agency-empty':
      return <EmptyState icon={icon} title="Briefs from the client show up here." />;
    case 'filtered':
      return <EmptyState icon={icon} title={state.title} />;
  }
}

export function BriefsPage() {
  const navigate = useNavigate();
  const toast = useOptionalToast();
  // The provider's stable show (the wrapper object is new each render).
  const showToast = toast?.show;
  const { workspaceId, workspaceKey, workspaces } = useWorkspace();
  // New brief is an approver action: the "+" shows only where the role holds brief.create.
  const canCreateBrief = useWorkspaceCapability('brief.create') === true;
  // The agency side (no brief.create) sorts a flat list; the client keeps the
  // time sections. Persisted per page like Pipeline; a stale value heals.
  const { value: storedSort, setValue: setSort } = useSort<BriefSort>('briefs', BRIEF_SORT_DEFAULT);
  const sort = sanitizeBriefSort(storedSort);
  const showSort = !canCreateBrief;
  // The active workspace's civil calendar: the sections and the day headings are
  // read on the WORKSPACE zone and week start, never the browser's. Derived the
  // same way the Pipeline surface derives it; the helpers re-validate the zone,
  // so a blank or stale stored value is still safe.
  const activeWorkspace = workspaces.find((w) => w.id === workspaceId);
  const timeZone = activeWorkspace?.timezone ?? 'UTC';
  const weekStartDay = activeWorkspace?.week_start_day ?? 1;

  // Who the shared first reads are keyed to: the user the shell's nav press
  // started them for (src/lib/route-data.ts), when it is this workspace. Null:
  // nothing is shared and the page reads on its own.
  const sharedUserId = useCallback((): string | null => {
    const ctx = getPrefetchContext();
    return ctx !== null && ctx.workspaceId === workspaceId ? ctx.userId : null;
  }, [workspaceId]);
  const viewUserId = sharedUserId();
  const viewKey = (part: string): string | null =>
    viewUserId !== null && workspaceId !== null ? keptViewKey(viewUserId, workspaceId, part) : null;

  // The chip lives in the URL (?status=), so a Back from a brief lands on the
  // same filtered list. Default chip: Open, or the chip
  // kept this session when the URL names none (a tab return).
  const [searchParams, setSearchParams] = useSearchParams();
  const [keptFilter, setKeptFilter] = useKeptState<BriefFilter>(
    viewKey('briefs:filter'),
    BRIEF_FILTER_DEFAULT,
  );
  const statusParam = searchParams.get('status');
  const filter = statusParam === null ? keptFilter : parseBriefFilter(statusParam);
  // A stale ?q= from the old screen search is dropped on the next chip tap.
  const setFilter = useCallback(
    (nextFilter: BriefFilter) => {
      setKeptFilter(nextFilter);
      setSearchParams((prev) => briefListParams(prev, nextFilter, ''), { replace: true });
    },
    [setSearchParams, setKeptFilter],
  );

  // A return to Briefs paints the list (every page loaded) and the chip counts
  // this session kept, at any age, then the mount refreshes them quietly.
  const [kept] = useState(() =>
    viewUserId !== null && workspaceId !== null
      ? {
          list: keptBriefsList(viewUserId, workspaceId),
          counts: keptBriefCounts(viewUserId, workspaceId),
        }
      : null,
  );
  const [briefs, setBriefs] = useState<BriefWithThumbnail[]>(() => kept?.list?.items ?? []);
  // Loading from the first render (unless the kept list painted): the read
  // starts in an effect, after the first paint, so a false start would flash a
  // zero state for a frame.
  const [loading, setLoading] = useState(kept?.list === undefined);
  const [loadFailed, setLoadFailed] = useState(false);
  // Keyset paging: where the next page starts, or done. Load more appends it.
  const [next, setNext] = useState<BriefPageNext>(() => kept?.list?.next ?? { done: true });
  const [loadingMore, setLoadingMore] = useState(false);
  // Bumped by every first-page load, so a Load more that resolves after a
  // reload (or a workspace switch) never appends onto the fresh list.
  const loadGeneration = useRef(0);
  // The workspace whose list `briefs` holds (kept or read), so only a mount
  // over that workspace's painted list refreshes quietly.
  const shownFor = useRef<string | null>(kept?.list !== undefined ? workspaceId : null);
  // Whether the person has acted on the page since it mounted: a quiet
  // refresh lands only while they have not.
  const untouched = useUntouched();
  const briefsRef = useRef(briefs);
  briefsRef.current = briefs;
  const nextRef = useRef(next);
  nextRef.current = next;
  const [createOpen, setCreateOpen] = useState(false);
  // The chips' real counts (server HEAD counts, never the loaded rows). Empty
  // until the first read lands, and after a failed one: a chip then shows its
  // label alone rather than a wrong number.
  const [chipCounts, setChipCounts] = useState<Partial<Record<BriefFilter, number>>>(
    () => kept?.counts ?? {},
  );
  const countsGeneration = useRef(0);

  // One presign cache + presignEnabled for the WHOLE list (the wiring fix: the page
  // previously built none, so image thumbnails could never resolve). Built exactly as
  // BriefDetailPage builds it, and shared across every card so they share one
  // concurrency cap and warm-URL cache; cards lazy-resolve via useInView.
  const presignEnabled = env.VITE_ASSET_READ_URL !== undefined;
  const cache = appPresignCache();

  // Every chip's count, in parallel; only the newest read lands.
  // The first load (`join`) joins the counts a nav press already started. A
  // `quiet` run (the kept counts painted) keeps them through a failure and
  // lands only while untouched.
  const loadCounts = useCallback(
    async (join = false, quiet = false) => {
      if (workspaceId === null) return;
      countsGeneration.current += 1;
      const generation = countsGeneration.current;
      const userId = join ? sharedUserId() : null;
      const result =
        userId === null
          ? await countBriefsByFilter(supabase, workspaceId, '')
          : await readBriefCounts(supabase, userId, workspaceId, '', countBriefsByFilter);
      mark('briefs:counts-in');
      if (generation !== countsGeneration.current) return;
      if (quiet && (!result.ok || !untouched())) return;
      setChipCounts(result.ok ? result.data : {});
    },
    [workspaceId, sharedUserId, untouched],
  );

  // The list the page shows after a load, Load more or a quiet refresh is kept
  // for the next visit, for this workspace's list only. primeBriefsList is
  // idempotent, so the updater stays safe to run twice.
  const setBriefsAndKeep = useCallback(
    (update: (prev: BriefWithThumbnail[]) => BriefWithThumbnail[], page?: BriefPageNext): void => {
      const userId = sharedUserId();
      setBriefs((prev) => {
        const items = update(prev);
        if (userId !== null && workspaceId !== null && shownFor.current === workspaceId) {
          primeBriefsList(userId, workspaceId, { items, next: page ?? nextRef.current });
        }
        return items;
      });
    },
    [workspaceId, sharedUserId],
  );

  // The active workspace's newest briefs, one keyset page read on the server by
  // workspace_id, then grouped and filtered in memory over what is loaded. A
  // failure shows LoadError (never the server's text); Retry runs this same
  // read again. Every reload starts over from the newest page.
  //
  // The list paints once the rows and the chip counts are both in (read in
  // parallel), so the chips never gain numbers after the cards. The thumbnails
  // (a second round: they need the rows' ids) fill each card's fixed tile when
  // they land, unless a card's height depends on them (briefsPaintNeedsThumbs),
  // when the paint waits for them as before. Only the mount (`join`) joins the
  // reads a nav press started; every reload marks them stale and reads anew.
  //
  // When the kept list painted, the mount's read is a quiet refresh: no
  // skeleton and no wait for the counts, a failure keeps the kept list, and
  // the rows (thumbnails filled, the older pages the person loaded kept under
  // them) land only while untouched; otherwise they are kept for the next visit.
  const loadBriefs = useCallback(
    async (join = false) => {
      if (workspaceId === null) return;
      const userId = sharedUserId();
      if (userId !== null && !join) staleBriefsReads(userId, workspaceId);
      const quiet = join && shownFor.current === workspaceId;
      // The counts reload on every event the list reloads on, alongside it.
      const counted = loadCounts(true, quiet);
      loadGeneration.current += 1;
      const generation = loadGeneration.current;
      if (!quiet) {
        setLoading(true);
        setLoadFailed(false);
      }
      // A counts read that never answers holds the paint no longer than the
      // bound; the chips then take their numbers when it lands.
      const countsOrBound = quiet
        ? Promise.resolve()
        : Promise.race([
            counted,
            new Promise<void>((resolve) => window.setTimeout(resolve, BRIEF_COUNTS_PAINT_WAIT_MS)),
          ]);
      const [result] = await Promise.all([
        userId === null
          ? listBriefsFirstPage(supabase, workspaceId)
          : readBriefsFirstPage(supabase, userId, workspaceId, listBriefsFirstPage),
        countsOrBound,
      ]);
      mark('briefs:rows-in');
      if (generation !== loadGeneration.current) return;
      if (quiet) {
        if (!result.ok) return;
        const thumbnails = await result.data.thumbs;
        mark('briefs:thumbs-in');
        if (generation !== loadGeneration.current || !thumbnails.ok) return;
        const rows = withBriefThumbnails(result.data.items, thumbnails.data);
        const fresh = withKeptBriefsTail(
          { items: rows, next: result.data.next },
          { items: briefsRef.current, next: nextRef.current },
        );
        if (!untouched()) {
          if (userId !== null) primeBriefsList(userId, workspaceId, fresh);
          return;
        }
        setBriefsAndKeep(() => fresh.items, fresh.next);
        setNext(fresh.next);
        mark('briefs:quiet-applied');
        return;
      }
      if (!result.ok) {
        setLoading(false);
        setLoadingMore(false);
        setLoadFailed(true);
        return;
      }
      const { items, next: page, thumbs } = result.data;
      shownFor.current = workspaceId;
      if (briefsPaintNeedsThumbs(items)) {
        // A link card's height depends on its thumbnail, so the paint waits for
        // it, but never past READ_TIMEOUT_MS. A late or failed read paints the
        // rows without thumbnails; it never fails the list.
        let timer = 0;
        const raced = await Promise.race([
          thumbs.then((value) => ({ value })),
          new Promise<null>((resolve) => {
            timer = window.setTimeout(() => resolve(null), READ_TIMEOUT_MS);
          }),
        ]);
        window.clearTimeout(timer);
        if (generation !== loadGeneration.current) return;
        if (raced !== null) {
          mark('briefs:thumbs-in');
          setLoading(false);
          setLoadingMore(false);
          const thumbnails = raced.value;
          if (!thumbnails.ok) {
            logger.warn('briefs: thumbnails read failed', { error: thumbnails.error.message });
            setBriefsAndKeep(() => items, page);
          } else {
            const map = thumbnails.data;
            setBriefsAndKeep(() => withBriefThumbnails(items, map), page);
          }
          setNext(page);
          return;
        }
        // Timed out: paint the rows now; the thumbnails apply below if they land
        // while this load is still current.
      }
      setLoading(false);
      setLoadingMore(false);
      setBriefsAndKeep(() => items, page);
      setNext(page);
      const thumbnails = await thumbs;
      mark('briefs:thumbs-in');
      if (generation !== loadGeneration.current) return;
      if (!thumbnails.ok) {
        // The cards keep their icon tiles; nothing else depends on the images.
        logger.warn('briefs: thumbnails read failed', { error: thumbnails.error.message });
        return;
      }
      if (thumbnails.data.size === 0) return;
      // Fill only the first page's rows: a Load more page carries its own.
      setBriefsAndKeep((prev) => withBriefThumbnails(prev, thumbnails.data));
    },
    [workspaceId, loadCounts, sharedUserId, untouched, setBriefsAndKeep],
  );

  // The next page, appended with duplicates (by id) dropped. A failure keeps
  // what is loaded and says so in a toast; the button stays for another try.
  const loadMore = useCallback(async () => {
    if (workspaceId === null || next.done || loadingMore) return;
    const generation = loadGeneration.current;
    setLoadingMore(true);
    const result = await listBriefsPage(supabase, workspaceId, next.cursor);
    if (generation !== loadGeneration.current) return;
    setLoadingMore(false);
    if (!result.ok) {
      showToast?.({ title: errorText('load more briefs', result.error), tone: 'error' });
      return;
    }
    setBriefsAndKeep((prev) => mergeBriefPages(prev, result.data.items), result.data.next);
    setNext(result.data.next);
  }, [workspaceId, next, loadingMore, showToast, setBriefsAndKeep]);

  useEffect(() => {
    mark('briefs:mount');
    void loadBriefs(true);
  }, [loadBriefs]);
  useWorkspaceDataChanged(() => {
    void loadBriefs();
  });

  // The top bar's "+" and the command palette dispatch this event; the sheet
  // lives here so the list can re-fetch on success.
  useEffect(() => {
    function openCreate(): void {
      setCreateOpen(true);
    }
    window.addEventListener('sorted:create-brief', openCreate);
    return () => {
      window.removeEventListener('sorted:create-brief', openCreate);
    };
  }, []);

  // The read is already workspace-scoped; this guards a stale list for a moment
  // after a workspace switch.
  const workspaceBriefs = useMemo(
    () => briefs.filter((brief) => brief.workspace_id === workspaceId),
    [briefs, workspaceId],
  );

  // Grouping is pure, derived over the loaded list (no refetch, no N+1):
  // status chip, then time grouping. Section counts therefore reflect the chip.
  const groups = useMemo(
    () => deriveBriefGroups(workspaceBriefs, filter, new Date(), { timeZone, weekStartDay }),
    [workspaceBriefs, filter, timeZone, weekStartDay],
  );

  const sortedBriefs = useMemo(
    () => (showSort ? deriveSortedBriefs(workspaceBriefs, filter, sort) : []),
    [showSort, workspaceBriefs, filter, sort],
  );

  // The list's one clock: every card's time ("Today", "2d late", "3h")
  // reads the same instant and ages once a minute; no timer per card.
  const nowMs = useMinuteClock();

  const shownCount = showSort
    ? sortedBriefs.length
    : groups.reduce((sum, group) => sum + group.items.length, 0);

  const hrefFor = useCallback(
    (brief: BriefWithThumbnail): string =>
      // Prefer the pretty link (/b/KEY-N); the classic /briefs/:id route stays a
      // working fallback when the key is unavailable.
      workspaceKey !== null
        ? entityUrlPath('brief', workspaceKey, brief.number)
        : `/briefs/${brief.id}`,
    [workspaceKey],
  );

  function onCreated(created: BriefCreated): void {
    setCreateOpen(false);
    void loadBriefs();
    toast?.show(createdToast(created, navigate));
  }

  const listLoading = workspaceId === null || (loading && briefs.length === 0);
  const listFailed = loadFailed;
  if (!listLoading && !listFailed) mark('briefs:paint');
  // Back on Briefs, the scroll lands where it was once the cards painted.
  useKeptScroll(viewKey('briefs:scroll'), !listLoading && !loadFailed);

  // BriefCard renders its own root, so the first rendered card is marked for the
  // induction from here (attribute only). Re-run each render: the chip or sort
  // can change which card is first, so a stale mark is cleared first.
  const listRef = useRef<HTMLDivElement>(null);
  // Boxes only while nothing is held; the cards settle once when they land
  // after the boxes (a kept list paints at once and never settles).
  const hadBoxes = useHadBoxes(listLoading && !listFailed);
  useSettleOnLanding(listRef, !listLoading && !listFailed, hadBoxes);
  useEffect(() => {
    const root = listRef.current;
    if (root === null) return;
    const cards = root.querySelectorAll('[data-brief-card]');
    cards.forEach((card, index) => {
      if (index === 0) card.setAttribute('data-induction', INDUCTION_KEYS.briefsFirstCard);
      else if (card.getAttribute('data-induction') === INDUCTION_KEYS.briefsFirstCard) {
        card.removeAttribute('data-induction');
      }
    });
  });

  // Sort (agency side) and New brief ride the app top bar (decision A);
  // memoised so the bar only re-renders when one of them changes.
  const topbar = useMemo(
    () =>
      briefsTopbarActions({
        canCreate: canCreateBrief,
        ...(showSort ? { sort: { value: sort, onChange: setSort } } : {}),
      }),
    [canCreateBrief, showSort, sort, setSort],
  );
  useTopbarActions(topbar);

  return (
    <>
      <PageHead title="Briefs" hidden />
      {briefsHeader({
        filter,
        onFilterChange: setFilter,
        counts: chipCounts,
      })}

      {listFailed ? (
        <div className={cn(GUTTER, 'mt-4')}>
          <LoadError title="briefs" onRetry={() => void loadBriefs()} retrying={loading} />
        </div>
      ) : listLoading ? (
        <BriefsListSkeleton />
      ) : shownCount === 0 ? (
        briefsEmptyView(briefsEmptyState(filter, workspaceBriefs.length, canCreateBrief))
      ) : showSort ? (
        <div ref={listRef} className={LIST_CLASS}>
          <div className={GRID_CLASS}>
            {briefCardList({
              briefs: sortedBriefs,
              cache,
              presignEnabled,
              hrefFor,
              timeZone,
              now: new Date(nowMs),
            })}
          </div>
        </div>
      ) : (
        <div ref={listRef} className={LIST_CLASS}>
          {briefSections({
            groups,
            timeZone,
            now: new Date(nowMs),
            cache,
            presignEnabled,
            hrefFor,
          })}
        </div>
      )}

      {/* Older briefs load a page at a time; chips and sort narrow what is
          loaded, while the chip counts are server totals. */}
      {!listFailed && !listLoading
        ? briefsLoadMore(next, loadingMore, () => void loadMore())
        : null}

      <CreateBriefSheet
        open={createOpen}
        workspaceId={workspaceId}
        onClose={() => setCreateOpen(false)}
        onCreated={onCreated}
      />
    </>
  );
}
