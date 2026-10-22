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
import { SectionHeader } from '@/components/shell/SectionHeader';
import { IconBriefs, IconPlus } from '@/components/ui/icons';
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
import {
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
}

/**
 * The Briefs header chrome: the shared SectionHeader (search, accent "+" create)
 * with the All / Open / Closed chips in the filter slot. Sorting is gone: the
 * list is grouped inline by time (see {@link groupBriefsByTime}), so the header
 * carries no sort control. Pure (no hooks) so the wiring is unit-tested by
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
      {...(props.canCreate
        ? {
            primaryAction: {
              node: (
                <Button
                  variant="primary"
                  size="lg"
                  aria-label="Create brief"
                  data-induction={INDUCTION_KEYS.briefsNew}
                  className="w-11 px-0"
                  onClick={() => dispatchSorted('sorted:create-brief')}
                >
                  <IconPlus size={18} />
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

/** "{n} brief" / "{n} briefs" with correct singular. */
function briefUnit(count: number): string {
  return count === 1 ? 'brief' : 'briefs';
}

/**
 * The summary line under the header, reflecting the chip and search: "12 briefs"
 * when everything shows, "3 of 12 briefs" when the filter narrows it.
 */
export function briefsCountLine(shown: number, total: number): string {
  if (shown === total) return `${total} ${briefUnit(total)}`;
  return `${shown} of ${total} ${briefUnit(total)}`;
}

/**
 * The zero-result heading when briefs exist but none show: a search names the
 * query; otherwise the heading names the active chip. Pure.
 */
export function briefsNoneTitle(filter: BriefFilter, search: string): string {
  const query = search.trim();
  if (query !== '') return `Nothing called "${query}"`;
  if (filter === BRIEF_STATUS.open) return 'No open briefs right now';
  if (filter === BRIEF_STATUS.closed) return 'No closed briefs yet';
  return 'No briefs yet';
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
const DAY_HEADING_CLASS = 'pt-3 pb-1 text-xs font-medium text-fg-2';

/**
 * One section per time group: a sticky label + count header, then, for every
 * civil day inside that group (newest-first, workspace zone), a day heading
 * followed by the existing card grid for that day's briefs. Pure (no hooks) so
 * the section labels, counts, day headings and per-group card wiring are
 * unit-tested by walking the tree, mirroring briefCardList.
 */
export function briefSections(deps: BriefSectionsDeps): ReactElement[] {
  const { groups, timeZone, ...cardDeps } = deps;
  return groups.map((group) => (
    <section key={group.key}>
      <div className={SECTION_HEADER_CLASS}>
        <h3 className="text-sm font-semibold text-fg">{group.label}</h3>
        <span className="text-sm text-fg-3">
          {group.items.length} {briefUnit(group.items.length)}
        </span>
      </div>
      {groupBriefsByDay(group.items, timeZone).flatMap((day) => [
        <div key={`${day.key}-label`} className={DAY_HEADING_CLASS}>
          {day.label}
        </div>,
        <div key={day.key} className="pt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {briefCardList({ ...cardDeps, briefs: day.items })}
        </div>,
      ])}
    </section>
  ));
}

export function BriefsPage() {
  const navigate = useNavigate();
  const toast = useOptionalToast();
  const { workspaceId, workspaceKey, workspaces } = useWorkspace();
  // New brief is an approver action: the "+" shows only where the role holds brief.create.
  const canCreateBrief = useWorkspaceCapability('brief.create') === true;
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

  const shownCount = useMemo(
    () => groups.reduce((sum, group) => sum + group.items.length, 0),
    [groups],
  );

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
    toast?.show({
      title: created.noteFailed
        ? "Brief created, but your note didn't post. Add it in the comments."
        : 'Brief created',
      tone: 'success',
      action: { label: 'Open', onPress: () => navigate(`/briefs/${created.briefId}`) },
    });
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
      })}

      {!loadFailed && !listLoading ? (
        <div className="px-4 md:px-6 pt-3 text-sm text-fg-3">
          {briefsCountLine(shownCount, workspaceBriefs.length)}
        </div>
      ) : null}

      {loadFailed ? (
        <div className="px-4 md:px-6 mt-4">
          <LoadError title="briefs" onRetry={() => void loadBriefs()} retrying={loading} />
        </div>
      ) : listLoading ? (
        <div className="px-4 md:px-6 py-10 text-sm text-fg-3">Loading briefs</div>
      ) : workspaceBriefs.length === 0 ? (
        <EmptyState
          icon={<IconBriefs size={24} />}
          title="No briefs yet"
          description={
            canCreateBrief
              ? 'Tell the agency what you need next.'
              : 'Briefs from approvers will show up here.'
          }
          {...(canCreateBrief
            ? {
                action: (
                  <Button variant="primary" size="lg" onClick={() => setCreateOpen(true)}>
                    Write your first brief
                  </Button>
                ),
              }
            : {})}
        />
      ) : groups.length === 0 ? (
        <EmptyState
          icon={<IconBriefs size={24} />}
          title={briefsNoneTitle(filter, search)}
          action={
            <Button size="lg" onClick={() => setListState('all', '')}>
              Clear search
            </Button>
          }
        />
      ) : (
        <div ref={listRef} className="px-4 md:px-6 py-4 flex flex-col gap-6">
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
