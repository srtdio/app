// Renders the briefs shared into one message as cards, mirroring PostCard: the
// ids resolve through the thread's card cache, so every brief shared across the
// loaded thread comes back in ONE workspace-scoped RLS read (chunks of 100, 5s
// each), never one read per bubble. A brief the viewer cannot see (RLS)
// renders as an "unavailable" card; a read that failed or timed out keeps the
// skeleton and is re-read (tab visible, online, connected, into view, or on
// its own after 5s), up to 3 tries, then shows "Couldn't load" with a tap to
// retry. Tapping a card opens the brief in the app.

import { useEffect, useMemo, useRef } from 'react';
import type { ReactElement } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  CouldntLoadCard,
  SHARED_CARD,
  useRetryInView,
  useThreadCardCache,
  type ThreadCardCache,
} from '@/components/chat/PostCard';
import { ICON_SIZE, IconBriefs } from '@/components/ui/icons';
import { PressableRow } from '@/components/ui/PressableRow';
import { BriefStatusPill } from '@/components/pages/BriefCard';
import { briefRoute, sharedBriefViews, type SharedBriefView } from '@/lib/chat/briefs';

function useSharedBriefs(briefIds: string[]): {
  views: SharedBriefView[];
  loading: boolean;
  failed: string[];
  cache: ThreadCardCache | null;
} {
  const cache = useThreadCardCache();
  const key = briefIds.join(',');
  const idsRef = useRef(briefIds);
  idsRef.current = briefIds;

  useEffect(() => {
    if (idsRef.current.length > 0) cache?.request({ briefIds: idsRef.current });
  }, [cache, key]);

  const snapshot =
    cache !== null && briefIds.length > 0
      ? cache.briefs(briefIds)
      : { loading: false, briefs: [], failed: [] };
  const version = cache?.version() ?? 0;
  const views = useMemo(
    () => sharedBriefViews(briefIds, snapshot.briefs),
    // The snapshot is keyed by the ids and the cache version.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [key, cache, version],
  );
  return { views, loading: snapshot.loading, failed: snapshot.failed, cache };
}

export function SharedBriefCards({ briefIds }: { briefIds: string[] }): ReactElement {
  const { views, loading, failed, cache } = useSharedBriefs(briefIds);
  const retryInView = useRetryInView(cache, { briefIds }, loading);
  if (briefIds.length === 0) return <></>;
  if (loading) {
    // A read that failed keeps this skeleton and retries (tab visible, online,
    // connected, or scrolled into view); "Brief unavailable" is only for RLS.
    return (
      <div ref={retryInView} className="mt-1.5 flex flex-col items-start gap-1.5">
        {briefIds.map((id) => (
          <div
            key={id}
            className="h-[54px] w-[240px] animate-pulse rounded-lg border border-border bg-panel-2"
          />
        ))}
      </div>
    );
  }
  return (
    <div className="mt-1.5 flex flex-col items-start gap-1.5">
      {views.map((view) =>
        failed.includes(view.briefId) ? (
          <CouldntLoadCard
            key={view.briefId}
            onRetry={() => cache?.retry({ briefIds: [view.briefId] })}
          />
        ) : (
          <BriefCardItem key={view.briefId} view={view} />
        ),
      )}
    </div>
  );
}

export function BriefCardItem({ view }: { view: SharedBriefView }): ReactElement {
  const navigate = useNavigate();
  if (view.kind === 'unavailable') {
    return (
      <div className={`${SHARED_CARD} text-fg-3`}>
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-panel-3">
          <IconBriefs size={ICON_SIZE.nav} />
        </span>
        <span className="text-base font-medium">Brief unavailable</span>
      </div>
    );
  }
  return (
    <PressableRow
      type="button"
      inline
      aria-label={`Open brief ${view.title}`}
      onClick={() => navigate(briefRoute(view.briefId))}
      className={`${SHARED_CARD} transition-colors`}
    >
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-panel-3 text-fg-3">
        <IconBriefs size={ICON_SIZE.nav} />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="truncate text-base font-medium text-fg" title={view.title}>
          {view.title}
        </span>
        {/* The same pill as the Briefs list and detail: Open (accent, dot) and
            Closed (grey, lock) read clearly apart. */}
        <span className="flex">
          <BriefStatusPill status={view.status} />
        </span>
      </span>
    </PressableRow>
  );
}
