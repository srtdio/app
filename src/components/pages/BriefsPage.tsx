import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ReactElement } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/Button';
import { Chip } from '@/components/ui/Chip';
import { EmptyState } from '@/components/ui/EmptyState';
import { SectionHeader } from '@/components/shell/SectionHeader';
import { IconBriefs, IconPlus } from '@/components/ui/icons';
import { BriefCard, BRIEF_STATUS, isBriefClosed } from '@/components/pages/BriefCard';
import { CreateBriefSheet } from '@/components/pages/CreateBriefSheet';
import { dispatchSorted } from '@/lib/events';
import { env } from '@/lib/env';
import { fetchWithTrace } from '@/lib/fetch';
import { PresignCache } from '@/lib/asset-presign';
import { supabase } from '@/lib/supabase';
import { useWorkspace } from '@/lib/workspace-context';
import { useNewTrace } from '@/lib/trace-context';
import { filterByTitle } from '@/lib/list-sort';
import { filterBriefsByStatus, type BriefFilter } from '@/lib/brief-list';
import { groupBriefsByTime, type BriefGroup } from '@/lib/brief-groups';
import { cn } from '@/lib/cn';
import { briefClose } from '@srtdio/rpc';
import { listBriefs } from '@srtdio/briefs';
import type { BriefWithThumbnail } from '@srtdio/briefs';

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
      primaryAction={{
        node: (
          <Button
            variant="primary"
            size="lg"
            aria-label="Create brief"
            className="w-11 px-0"
            onClick={() => dispatchSorted('sorted:create-brief')}
          >
            <IconPlus size={18} />
          </Button>
        ),
      }}
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
  closingId: string | null;
  closeError: { id: string; message: string } | null;
  onClose: (briefId: string) => void;
  onOpen: (briefId: string) => void;
}

/**
 * Map the visible briefs to their cards, threading the single shared presign cache
 * and presignEnabled into each. Pure (no hooks) so the wiring (one cache shared
 * across cards, per-brief closing/error/open) is unit-tested without rendering the
 * page, mirroring briefsHeader.
 */
export function briefCardList(deps: BriefCardListDeps): ReactElement[] {
  return deps.briefs.map((brief) => (
    <BriefCard
      key={brief.id}
      brief={brief}
      cache={deps.cache}
      presignEnabled={deps.presignEnabled}
      closing={deps.closingId === brief.id}
      closeError={deps.closeError?.id === brief.id ? deps.closeError.message : null}
      onConfirmClose={() => deps.onClose(brief.id)}
      onOpen={() => deps.onOpen(brief.id)}
    />
  ));
}

/** "{n} brief" / "{n} briefs" with correct singular. */
function briefUnit(count: number): string {
  return count === 1 ? 'brief' : 'briefs';
}

/** The summary line under the header: total briefs and how many are open. */
export function briefsCountLine(total: number, open: number): string {
  return `${total} ${briefUnit(total)} · ${open} open`;
}

/**
 * Derive the rendered time sections from the loaded list: status chip, then
 * title search, then time grouping (newest-first, Monday weeks, month buckets).
 * Section counts therefore reflect the active chip + search. filterBriefsByStatus
 * is typed over the bare Brief, so re-narrow each surviving row back to its
 * BriefWithThumbnail (same object reference) via an id map; the cards need
 * thumbnailAssetVersionId. Pure so the wiring is unit-tested without rendering.
 */
export function deriveBriefGroups(
  briefs: BriefWithThumbnail[],
  filter: BriefFilter,
  search: string,
  now: Date,
): BriefGroup<BriefWithThumbnail>[] {
  const byId = new Map(briefs.map((brief) => [brief.id, brief]));
  const filtered = filterByTitle(filterBriefsByStatus(briefs, filter), search);
  const narrowed = filtered.flatMap((brief) => {
    const full = byId.get(brief.id);
    return full !== undefined ? [full] : [];
  });
  return groupBriefsByTime(narrowed, now);
}

interface BriefSectionsDeps extends Omit<BriefCardListDeps, 'briefs'> {
  groups: BriefGroup<BriefWithThumbnail>[];
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

/**
 * One section per time group: a sticky label + count header followed by the
 * existing card grid for that group's briefs. Pure (no hooks) so the section
 * labels, counts and per-group card wiring are unit-tested by walking the tree,
 * mirroring briefCardList.
 */
export function briefSections(deps: BriefSectionsDeps): ReactElement[] {
  const { groups, ...cardDeps } = deps;
  return groups.map((group) => (
    <section key={group.key}>
      <div className={SECTION_HEADER_CLASS}>
        <h3 className="text-sm font-semibold text-fg">{group.label}</h3>
        <span className="text-sm text-fg-3">
          {group.items.length} {briefUnit(group.items.length)}
        </span>
      </div>
      <div className="pt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {briefCardList({ ...cardDeps, briefs: group.items })}
      </div>
    </section>
  ));
}

export function BriefsPage() {
  const navigate = useNavigate();
  const { workspaceId } = useWorkspace();
  const newTrace = useNewTrace();
  const [filter, setFilter] = useState<BriefFilter>('all');
  const [search, setSearch] = useState('');

  const [briefs, setBriefs] = useState<BriefWithThumbnail[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [closingId, setClosingId] = useState<string | null>(null);
  const [closeError, setCloseError] = useState<{ id: string; message: string } | null>(null);

  // One presign cache + presignEnabled for the WHOLE list (the wiring fix: the page
  // previously built none, so image thumbnails could never resolve). Built exactly as
  // BriefDetailPage builds it, and shared across every card so they share one
  // concurrency cap and warm-URL cache; cards lazy-resolve via useInView.
  const presignEnabled = env.VITE_ASSET_READ_URL !== undefined;
  const cache = useMemo(
    () =>
      new PresignCache({
        endpoint: env.VITE_ASSET_READ_URL ?? null,
        getAccessToken: async () =>
          (await supabase.auth.getSession()).data.session?.access_token ?? null,
        fetcher: (input, init) => fetchWithTrace(input, init),
      }),
    [],
  );

  // One read for the whole surface (no N+1): listBriefs once, then group and
  // filter in memory. Reads are direct RLS selects, no proc, no per-status call.
  const loadBriefs = useCallback(async () => {
    if (workspaceId === null) return;
    setLoading(true);
    setError(null);
    const result = await listBriefs(supabase);
    setLoading(false);
    if (!result.ok) {
      setError(result.error.message);
      return;
    }
    setBriefs(result.data);
  }, [workspaceId]);

  useEffect(() => {
    void loadBriefs();
  }, [loadBriefs]);

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

  // Scope to the active workspace client-side (listBriefs is RLS-scoped to the
  // caller's memberships, which can span workspaces).
  const workspaceBriefs = useMemo(
    () => briefs.filter((brief) => brief.workspace_id === workspaceId),
    [briefs, workspaceId],
  );

  // Search + grouping are pure, derived over the loaded list (no refetch, no
  // N+1): status chip, then title search, then time grouping. Section counts
  // therefore reflect the active chip + search.
  const groups = useMemo(
    () => deriveBriefGroups(workspaceBriefs, filter, search, new Date()),
    [workspaceBriefs, filter, search],
  );

  const openCount = useMemo(
    () => workspaceBriefs.filter((brief) => !isBriefClosed(brief)).length,
    [workspaceBriefs],
  );

  async function handleClose(briefId: string): Promise<void> {
    setClosingId(briefId);
    setCloseError(null);
    const result = await briefClose(supabase, { p_brief_id: briefId, p_trace_id: newTrace() });
    setClosingId(null);
    if (!result.ok) {
      setCloseError({ id: briefId, message: result.error.message });
      return;
    }
    // Reflect server truth: re-fetch so the brief shows Closed, no optimism.
    await loadBriefs();
  }

  const listLoading = workspaceId === null || (loading && briefs.length === 0);

  return (
    <>
      {briefsHeader({
        search,
        onSearchChange: setSearch,
        filter,
        onFilterChange: setFilter,
      })}

      <div className="px-4 md:px-6 pt-3 text-sm text-fg-3">
        {briefsCountLine(workspaceBriefs.length, openCount)}
      </div>

      {error !== null ? (
        <div className="px-4 md:px-6 mt-4">
          <div role="alert" className="rounded-xl border border-bad px-4 py-3 text-sm text-bad">
            Could not load briefs. {error}
          </div>
        </div>
      ) : listLoading ? (
        <div className="px-4 md:px-6 py-10 text-sm text-fg-3">Loading briefs</div>
      ) : groups.length === 0 ? (
        <EmptyState
          icon={<IconBriefs size={24} />}
          title="No briefs yet"
          description="Briefs from clients will show up here."
        />
      ) : (
        <div className="px-4 md:px-6 py-4 flex flex-col gap-6">
          {briefSections({
            groups,
            cache,
            presignEnabled,
            closingId,
            closeError,
            onClose: (briefId) => void handleClose(briefId),
            onOpen: (briefId) => navigate(`/briefs/${briefId}`),
          })}
        </div>
      )}

      <CreateBriefSheet
        open={createOpen}
        workspaceId={workspaceId}
        onClose={() => setCreateOpen(false)}
        onCreated={() => {
          setCreateOpen(false);
          void loadBriefs();
        }}
      />
    </>
  );
}
