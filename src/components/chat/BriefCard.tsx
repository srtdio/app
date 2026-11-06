// Renders the briefs shared into one message as cards, mirroring PostCard: the
// ids resolve through the thread's card cache, so every brief shared across the
// loaded thread comes back in ONE workspace-scoped RLS read (chunks of 100, 5s
// each), never one read per bubble. A brief the viewer cannot see (RLS)
// renders as an "unavailable" card; a read that failed or timed out keeps the
// skeleton and is re-read (tab visible, online, connected, into view, or on
// its own after 5s), up to 3 tries, then shows "Couldn't load" with a tap to
// retry. Tapping a card opens the brief in the app. Every state (loading,
// loaded, unavailable, couldn't load) is one fixed 72px box (BRIEF_CARD_HEIGHT),
// so a card fills in place and never moves a row; the last card of a
// card-only message also holds its time row, and there every state takes the
// same rows' height instead (ui/ChatCard: the card is the bubble).

import { useEffect, useMemo, useRef } from 'react';
import type { ReactElement, ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  CouldntLoadCard,
  cardGroupClass,
  metaForLast,
  useRetryInView,
  useThreadCardCache,
  type CardPlacement,
  type ThreadCardCache,
} from '@/components/chat/PostCard';
import { IconBriefs } from '@/components/ui/icons';
import { ChatCard } from '@/components/ui/ChatCard';
import { Bone } from '@/lib/motion';
import { BriefStatusPill } from '@/components/pages/BriefCard';
import { briefRoute, sharedBriefViews, type SharedBriefView } from '@/lib/chat/briefs';

/**
 * The brief card's one outer height (72): ChatCard's 12 inset twice + the title
 * over the status pill (20 + 4 + 20). The skeleton, the unavailable card and
 * the retry card take it too.
 */
export const BRIEF_CARD_HEIGHT = 'h-18';

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

export function SharedBriefCards({
  briefIds,
  inBubble = true,
  cardMeta,
}: { briefIds: string[] } & CardPlacement): ReactElement {
  const { views, loading, failed, cache } = useSharedBriefs(briefIds);
  const retryInView = useRetryInView(cache, { briefIds }, loading);
  if (briefIds.length === 0) return <></>;
  if (loading) {
    // A read that failed keeps this skeleton and retries (tab visible, online,
    // connected, or scrolled into view); "Brief unavailable" is only for RLS.
    // The skeleton is the card's own rows (bones), so the card fills in place.
    return (
      <div ref={retryInView} className={cardGroupClass(inBubble)}>
        {briefIds.map((id, i) => {
          const meta = metaForLast(i, briefIds.length, cardMeta);
          return (
            <ChatCard
              key={id}
              icon={IconBriefs}
              title={<Bone lit="flat" as="span" className="h-5 w-32 rounded" />}
              meta={<Bone lit="flat" as="span" className="h-5 w-12 rounded" />}
              time={meta}
              rootProps={{ 'aria-hidden': true, 'data-brief-skeleton': '' }}
              {...briefHeight(meta)}
            />
          );
        })}
      </div>
    );
  }
  return (
    <div className={cardGroupClass(inBubble)}>
      {views.map((view, i) => {
        const meta = metaForLast(i, views.length, cardMeta);
        return failed.includes(view.briefId) ? (
          <CouldntLoadCard
            key={view.briefId}
            icon={IconBriefs}
            onRetry={() => cache?.retry({ briefIds: [view.briefId] })}
            cardMeta={meta}
            {...briefHeight(meta)}
          />
        ) : (
          <BriefCardItem key={view.briefId} view={view} cardMeta={meta} />
        );
      })}
    </div>
  );
}

/**
 * The fixed brief box (BRIEF_CARD_HEIGHT), or none on the card that carries
 * the message's time: every state then takes its rows' own height (the same
 * title line, line 2 and time row), so the swap still never moves a row.
 */
function briefHeight(cardMeta: ReactNode): { className?: string } {
  return cardMeta === undefined ? { className: BRIEF_CARD_HEIGHT } : {};
}

export function BriefCardItem({
  view,
  cardMeta,
}: {
  view: SharedBriefView;
  cardMeta?: ReactNode;
}): ReactElement {
  const navigate = useNavigate();
  if (view.kind === 'unavailable') {
    return (
      <ChatCard
        icon={IconBriefs}
        title="Brief unavailable"
        // With the time row the box is its rows' height: an empty line 2
        // keeps it the skeleton's height.
        meta={cardMeta !== undefined ? <span className="h-5" /> : undefined}
        muted
        time={cardMeta}
        {...briefHeight(cardMeta)}
      />
    );
  }
  // ui/ChatCard: kind icon + title on line 1, the status Tag on line 2 (the
  // same pill as the Briefs list and detail: Open accent, Closed grey).
  return (
    <ChatCard
      icon={IconBriefs}
      title={<span title={view.title}>{view.title}</span>}
      meta={<BriefStatusPill status={view.status} />}
      onOpen={() => navigate(briefRoute(view.briefId))}
      openLabel={`Open brief ${view.title}`}
      time={cardMeta}
      {...briefHeight(cardMeta)}
    />
  );
}
