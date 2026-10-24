import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { appPresignCache } from '@/lib/shared-presign';
import type { PresignCache } from '@/lib/asset-presign';
import type { ReactElement } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Button } from '@/components/ui/Button';
import { Chip } from '@/components/ui/Chip';
import { EmptyState } from '@/components/ui/EmptyState';
import { LoadError } from '@/components/ui/LoadError';
import { useOptionalToast } from '@/components/ui/toast';
import type { ToastOptions } from '@/components/ui/toast/types';
import { SectionHeader } from '@/components/shell/SectionHeader';
import { IconBriefs } from '@/components/ui/icons';
import { BriefCard, BRIEF_STATUS } from '@/components/pages/BriefCard';
import { CreateBriefSheet, type BriefCreated } from '@/components/pages/CreateBriefSheet';
import { dispatchSorted } from '@/lib/events';
import { useWorkspaceDataChanged } from '@/lib/use-workspace-data-changed';
import { env } from '@/lib/env';
import { supabase } from '@/lib/supabase';
import { useWorkspace } from '@/lib/workspace-context';
import { useWorkspaceCapability } from '@/lib/workspace-context-capability';
import { entityUrlPath } from '@/lib/entityRef';
import { filterByTitle } from '@/lib/list-sort';
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
  listWorkspaceBriefs,
  parseBriefFilter,
  type BriefFilter,
} from '@/lib/brief-list';
import {
  groupBriefsByDay,
  groupBriefsByTime,
  type BriefCalendar,
  type BriefGroup,
} from '@/lib/brief-groups';
import { cn } from '@/lib/cn';
import { BRIEFS_PAGE_SIZE, listBriefs } from '@srtdio/briefs';
import type { BriefWithThumbnail } from '@srtdio/briefs';
import { INDUCTION_KEYS } from '@/lib/induction';

// Filter chips: All shows everything; Open/Closed key off brief.status. The
// status keys come from the @srtdio/briefs type, never inline literals.
const FILTERS: { key: BriefFilter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: BRIEF_STATUS.open, label: 'Open' },
  { key: BRIEF_STATUS.closed, label: 'Closed' },
];

interface BriefsHeaderProps {
  search: string;
  onSearchChange: (value: string) => void;
  filter: BriefFilter;
  onFilterChange: (filter: BriefFilter) => void;
  /** Whether the viewer holds brief.create; the "+" shows only then (same gate as Topbar). */
  canCreate: boolean;
  /**
   * The agency-side sort (Due date / Recently updated), in the same SortMenu as
   * Pipeline. Omitted for client approvers: their list stays grouped by time.
   */
  sort?: { value: BriefSort; onChange: (value: BriefSort) => void };
}

/**
 * The Briefs header chrome: the shared SectionHeader (search, sort for the
 * agency side, accent create) with the All / Open / Closed chips in the filter
 * slot. Client approvers get no sort: their list is grouped inline by time (see
 * {@link groupBriefsByTime}). Pure (no hooks) so the wiring is unit-tested by
 * walking the returned tree.
 */
export function briefsHeader(props: BriefsHeaderProps): ReactElement {
  return (
    <SectionHeader
      search={{
        value: props.search,
        onChange: props.onSearchChange,
        placeholder: 'Search briefs',
      }}
      {...(props.sort !== undefined
        ? {
            sort: {
              options: BRIEF_SORT_OPTIONS,
              value: props.sort.value,
              onChange: props.sort.onChange,
            },
          }
        : {})}
      {...(props.canCreate
        ? {
            primaryAction: {
              node: (
                <Button
                  variant="primary"
                  data-induction={INDUCTION_KEYS.briefsNew}
                  className="shrink-0 whitespace-nowrap"
                  onClick={() => dispatchSorted('sorted:create-brief')}
                >
                  New brief
                </Button>
              ),
            },
          }
        : {})}
    >
      {FILTERS.map((item) => (
        <Chip
          key={item.key}
          label={item.label}
          selected={props.filter === item.key}
          size="tap"
          onClick={() => props.onFilterChange(item.key)}
        />
      ))}
    </SectionHeader>
  );
}

interface BriefCardListDeps {
  briefs: BriefWithThumbnail[];
  /** The ONE page-owned cache, threaded unchanged into every card (no per-card cache). */
  cache: PresignCache;
  presignEnabled: boolean;
  /** The detail path for a brief (pretty /b/KEY-N when known). */
  hrefFor: (brief: BriefWithThumbnail) => string;
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
    />
  ));
}

/** Which empty state the list shows when no card is visible. */
export type BriefsEmpty =
  /** A typed search matched nothing: one line + Clear (clears the search only). */
  | { kind: 'no-results'; title: string }
  /** A client with no open briefs: heading, line and New brief. */
  | { kind: 'client-empty' }
  /** The agency side with no briefs at all: one line, no heading. */
  | { kind: 'agency-empty' }
  /** A chip with nothing under it (no search typed): a heading only. */
  | { kind: 'filtered'; title: string };

/**
 * Pick the empty state. A typed search always wins and is the only state with
 * Clear. Then a workspace with no briefs at all (client or agency copy), then
 * the chip: Closed has its own heading; a client on Open (nothing open) gets the
 * "No open briefs yet" state with New brief. Pure.
 */
export function briefsEmptyState(
  filter: BriefFilter,
  search: string,
  total: number,
  canCreate: boolean,
): BriefsEmpty {
  const query = search.trim();
  if (query !== '') {
    return { kind: 'no-results', title: `No briefs with “${query}” in the title` };
  }
  if (total === 0) return canCreate ? { kind: 'client-empty' } : { kind: 'agency-empty' };
  if (filter === BRIEF_STATUS.closed) return { kind: 'filtered', title: 'No closed briefs yet' };
  if (canCreate) return { kind: 'client-empty' };
  return { kind: 'filtered', title: 'No open briefs right now' };
}

/**
 * The agency-side flat list: status chip, then title search, then the chosen
 * sort. Re-narrows each surviving row back to its BriefWithThumbnail (same
 * object reference) via an id map, as {@link deriveBriefGroups} does. Pure.
 */
export function deriveSortedBriefs(
  briefs: BriefWithThumbnail[],
  filter: BriefFilter,
  search: string,
  sort: BriefSort,
): BriefWithThumbnail[] {
  const byId = new Map(briefs.map((brief) => [brief.id, brief]));
  const filtered = filterByTitle(filterBriefsByStatus(briefs, filter), search);
  const narrowed = filtered.flatMap((brief) => {
    const full = byId.get(brief.id);
    return full !== undefined ? [full] : [];
  });
  return sortBriefs(narrowed, sort);
}

const LIST_CLASS = 'px-4 md:px-6 py-4 flex flex-col gap-6';
const GRID_CLASS = 'pt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3';

/**
 * The loading state: a static skeleton in the real list's shape (a section
 * header bar, a day label, then card-shaped blocks with the 64px tile, title,
 * objective and status pill lines), in the same container and grid, so nothing
 * jumps when the cards arrive. Token fills only; no motion.
 */
export function BriefsListSkeleton(): ReactElement {
  return (
    <div data-testid="briefs-skeleton" aria-busy="true" className={LIST_CLASS}>
      <section>
        <div className="py-2">
          <div className="h-5 w-24 rounded bg-panel-2" />
        </div>
        <div className="pt-3 pb-1">
          <div className="h-4 w-14 rounded bg-panel-2" />
        </div>
        <div className={GRID_CLASS}>
          {[0, 1, 2].map((key) => (
            <div
              key={key}
              data-brief-card-skeleton=""
              className="rounded-xl border border-border bg-panel p-4 flex gap-3 min-w-0"
            >
              <div className="w-16 shrink-0 aspect-square rounded-lg bg-panel-2" />
              <div className="flex min-w-0 flex-1 flex-col gap-2.5">
                <div className="flex items-start gap-3">
                  <div className="h-4 flex-1 rounded bg-panel-2" />
                  <div className="h-6 w-14 shrink-0 rounded-full bg-panel-2" />
                </div>
                <div className="h-4 w-4/5 rounded bg-panel-2" />
                <div className="h-3 w-16 rounded bg-panel-2" />
              </div>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

/**
 * Derive the rendered time sections from the loaded list: status chip, then
 * title search, then time grouping (newest-first, workspace weeks, month
 * buckets). `calendar` carries the workspace zone and week start, so the
 * sections read the same on every machine. Section counts therefore reflect the
 * active chip + search. filterBriefsByStatus is typed over the bare Brief, so
 * re-narrow each surviving row back to its BriefWithThumbnail (same object
 * reference) via an id map; the cards need thumbnailAssetVersionId. Pure so the
 * wiring is unit-tested without rendering.
 */
export function deriveBriefGroups(
  briefs: BriefWithThumbnail[],
  filter: BriefFilter,
  search: string,
  now: Date,
  calendar: BriefCalendar,
): BriefGroup<BriefWithThumbnail>[] {
  const byId = new Map(briefs.map((brief) => [brief.id, brief]));
  const filtered = filterByTitle(filterBriefsByStatus(briefs, filter), search);
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
  /** The clock the day headings' year rule reads. Default: now. */
  now?: Date;
}

// Sticky per-section header: pinned to the top of the scroll area (below the app
// top bar) with a translucent token background + blur so cards scroll under it.
// var(--bg) flips with the theme, so light/dark parity is automatic; z-20 sits
// above the card grid, matching SectionHeader's sticky choice. Positioning only:
// no transforms, no transitions.
const SECTION_HEADER_CLASS = cn(
  'sticky top-0 z-20 -mx-4 md:-mx-6 px-4 md:px-6 py-2 flex items-center justify-between',
  'bg-[color-mix(in_srgb,var(--bg)_80%,transparent)] backdrop-blur',
);

// The day heading inside a time section: which day the briefs below it were
// raised on, in the workspace zone. Deliberately NOT sticky and not interactive
// (the section header above it already pins), so it is a plain label: token
// colours only, so light/dark parity is automatic, and no motion.
const DAY_HEADING_CLASS = 'pt-3 pb-1 text-legacy-xs font-medium text-fg-2';

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
        <h3 className="text-legacy-sm font-semibold text-fg">{group.label}</h3>
      </div>
      {groupBriefsByDay(group.items, timeZone, now).flatMap((day) => [
        <div key={`${day.key}-label`} className={DAY_HEADING_CLASS}>
          {day.label}
        </div>,
        <div key={day.key} className={GRID_CLASS}>
          {briefCardList({ ...cardDeps, briefs: day.items })}
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
 * Render a {@link BriefsEmpty}. Clear only on a typed search and it clears the
 * search only (the chip stays). The agency's empty line has no heading, so it is
 * drawn here in EmptyState's shape rather than through EmptyState's required
 * title. Pure (no hooks).
 */
export function briefsEmptyView(
  state: BriefsEmpty,
  onClearSearch: () => void,
  onNewBrief: () => void,
): ReactElement {
  const icon = <IconBriefs size={24} />;
  switch (state.kind) {
    case 'no-results':
      return (
        <EmptyState
          icon={icon}
          title={state.title}
          action={<Button onClick={onClearSearch}>Clear</Button>}
        />
      );
    case 'client-empty':
      return (
        <EmptyState
          icon={icon}
          title="No open briefs yet"
          description="Tell the agency what you need next."
          action={
            <Button variant="primary" onClick={onNewBrief}>
              New brief
            </Button>
          }
        />
      );
    case 'agency-empty':
      return (
        <div className="flex flex-col items-center justify-center text-center px-6 py-14 gap-1.5 min-h-[320px]">
          <div className="w-[54px] h-[54px] rounded-xl bg-panel-2 border border-border flex items-center justify-center text-fg-3 mb-1.5">
            {icon}
          </div>
          <p className="text-fg-3 text-legacy-sm max-w-[300px]">
            Briefs from the client show up here.
          </p>
        </div>
      );
    case 'filtered':
      return <EmptyState icon={icon} title={state.title} />;
  }
}

export function BriefsPage() {
  const navigate = useNavigate();
  const toast = useOptionalToast();
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

  // The chip and the search live in the URL (?status=&q=), so a Back from a
  // brief lands on the same filtered list. Default chip: Open.
  const [searchParams, setSearchParams] = useSearchParams();
  const filter = parseBriefFilter(searchParams.get('status'));
  const search = searchParams.get('q') ?? '';
  const setListState = useCallback(
    (nextFilter: BriefFilter, nextSearch: string) => {
      setSearchParams((prev) => briefListParams(prev, nextFilter, nextSearch), { replace: true });
    },
    [setSearchParams],
  );

  const [briefs, setBriefs] = useState<BriefWithThumbnail[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);

  // One presign cache + presignEnabled for the WHOLE list (the wiring fix: the page
  // previously built none, so image thumbnails could never resolve). Built exactly as
  // BriefDetailPage builds it, and shared across every card so they share one
  // concurrency cap and warm-URL cache; cards lazy-resolve via useInView.
  const presignEnabled = env.VITE_ASSET_READ_URL !== undefined;
  const cache = appPresignCache();

  // The active workspace's briefs, read on the server by workspace_id page by
  // page, then grouped and filtered in memory. A failure shows LoadError (never
  // the server's text); Retry runs this same read again.
  const loadBriefs = useCallback(async () => {
    if (workspaceId === null) return;
    setLoading(true);
    setLoadFailed(false);
    const result = await listWorkspaceBriefs(workspaceId, BRIEFS_PAGE_SIZE, (filters) =>
      listBriefs(supabase, filters),
    );
    setLoading(false);
    if (!result.ok) {
      setLoadFailed(true);
      return;
    }
    setBriefs(result.data);
  }, [workspaceId]);

  useEffect(() => {
    void loadBriefs();
  }, [loadBriefs]);
  useWorkspaceDataChanged(() => void loadBriefs());

  // The New brief button and the command palette dispatch this event; the sheet
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

  // Search + grouping are pure, derived over the loaded list (no refetch, no
  // N+1): status chip, then title search, then time grouping. Section counts
  // therefore reflect the active chip + search.
  const groups = useMemo(
    () =>
      deriveBriefGroups(workspaceBriefs, filter, search, new Date(), { timeZone, weekStartDay }),
    [workspaceBriefs, filter, search, timeZone, weekStartDay],
  );

  const sortedBriefs = useMemo(
    () => (showSort ? deriveSortedBriefs(workspaceBriefs, filter, search, sort) : []),
    [showSort, workspaceBriefs, filter, search, sort],
  );

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

  // BriefCard renders its own root, so the first rendered card is marked for the
  // induction from here (attribute only). Re-run each render: the chip or search
  // can change which card is first, so a stale mark is cleared first.
  const listRef = useRef<HTMLDivElement>(null);
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

  return (
    <>
      {briefsHeader({
        search,
        onSearchChange: (value) => setListState(filter, value),
        filter,
        onFilterChange: (value) => setListState(value, search),
        canCreate: canCreateBrief,
        ...(showSort ? { sort: { value: sort, onChange: setSort } } : {}),
      })}

      {loadFailed ? (
        <div className="px-4 md:px-6 mt-4">
          <LoadError title="briefs" onRetry={() => void loadBriefs()} retrying={loading} />
        </div>
      ) : listLoading ? (
        <BriefsListSkeleton />
      ) : shownCount === 0 ? (
        briefsEmptyView(
          briefsEmptyState(filter, search, workspaceBriefs.length, canCreateBrief),
          () => setListState(filter, ''),
          () => setCreateOpen(true),
        )
      ) : showSort ? (
        <div ref={listRef} className={LIST_CLASS}>
          <div className={GRID_CLASS}>
            {briefCardList({ briefs: sortedBriefs, cache, presignEnabled, hrefFor })}
          </div>
        </div>
      ) : (
        <div ref={listRef} className={LIST_CLASS}>
          {briefSections({ groups, timeZone, cache, presignEnabled, hrefFor })}
        </div>
      )}

      <CreateBriefSheet
        open={createOpen}
        workspaceId={workspaceId}
        onClose={() => setCreateOpen(false)}
        onCreated={onCreated}
      />
    </>
  );
}
