// The idea shared into a message (chat_plan_item_share), as a ui/ChatCard (the
// card is the bubble): the bank glyph and the idea's title, then "{where} · {n} comments"
// where {where} is "Bank", "Bank · archived" or "{plan} · {date}", all read
// live from plan_items (never a snapshot on the message). A tap opens the
// bank idea (/plan/bank?item=) or the plan item (/plan/{plan}?item=). A viewer
// RLS hides the idea from sees "You don't have access to this idea." and no
// tap. Every idea id across one thread page is read in one batch after paint
// (idea-cards.ts: one plan_items and one comments read, then one plans read);
// cards never read on their own. A message the chat open bundle carried
// without its idea ids (empty-looking) is resolved in the same pass with one
// chat_messages read. Tokens only; ChatCard's bubble surface (muted ink for no
// access).

import { useEffect, useMemo, useSyncExternalStore } from 'react';
import type { ReactElement, ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { Bone } from '@/lib/motion';
import { ChatCard } from '@/components/ui/ChatCard';
import { IconBank } from '@/components/ui/icons';
import {
  CouldntLoadCard,
  cardGroupClass,
  metaForLast,
  type CardPlacement,
} from '@/components/chat/PostCard';
import {
  IDEA_NO_ACCESS,
  createIdeaCardStore,
  ideaHref,
  ideaLine,
  readIdeaCards,
  type IdeaCardStore,
  type IdeaCardView,
} from '@/lib/chat/idea-cards';
import { PLAN_CHANGED_EVENT } from '@/lib/chat/plans';
import { supabase } from '@/lib/supabase';

let shared: IdeaCardStore | null = null;

/** The app's one idea card store (session long; values refresh on plan changes). */
export function ideaCardStore(): IdeaCardStore {
  if (shared === null) {
    shared = createIdeaCardStore({
      ideas: (ids) => readIdeaCards(supabase, ids),
    });
    if (typeof window !== 'undefined') {
      const store = shared;
      // A plan write anywhere re-reads the ideas held (one batch).
      window.addEventListener(PLAN_CHANGED_EVENT, () => store.refresh(store.held()));
    }
  }
  return shared;
}

/** Tests only: start from an empty store. */
export function resetIdeaCardStoreForTests(store: IdeaCardStore | null = null): void {
  shared = store;
}

/** Re-render on every store change. */
function useIdeaStoreVersion(store: IdeaCardStore): number {
  return useSyncExternalStore(store.subscribe, store.version, store.version);
}

/** The first readable idea's title (the menu's Copy), or null. */
export function ideaTitleOf(message: { sharedPlanItemIds?: string[] | undefined }): string | null {
  const store = ideaCardStore();
  for (const id of message.sharedPlanItemIds ?? []) {
    const view = store.get(id);
    if (view !== undefined && view !== 'failed' && view.kind === 'idea') return view.title;
  }
  return null;
}

/** The idea cards of one message (ids from its row), one batched read per thread page. */
export function SharedIdeaCards(
  props: { ideaIds: readonly string[] } & CardPlacement,
): ReactElement {
  const store = ideaCardStore();
  const version = useIdeaStoreVersion(store);
  const key = props.ideaIds.join(',');
  useEffect(() => {
    if (props.ideaIds.length > 0) store.request(props.ideaIds);
    // Keyed by the ids.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store, key]);
  const views = useMemo(
    () => props.ideaIds.map((id) => ({ id, view: store.get(id) })),
    // Keyed by the ids and the store version.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [store, key, version],
  );
  const count = props.ideaIds.length;
  if (count === 0) return <></>;
  return (
    <div className={cardGroupClass(props.inBubble ?? true)}>
      {views.map(({ id, view }, i) => {
        const cardMeta = metaForLast(i, count, props.cardMeta);
        if (view === undefined) return <IdeaCardSkeleton key={id} cardMeta={cardMeta} />;
        if (view === 'failed') {
          return (
            <CouldntLoadCard
              key={id}
              icon={IconBank}
              onRetry={() => store.refresh([id])}
              cardMeta={cardMeta}
            />
          );
        }
        return <LiveIdeaCard key={id} view={view} cardMeta={cardMeta} />;
      })}
    </div>
  );
}

/** One read card: a tap goes to the idea's route. */
function LiveIdeaCard(props: { view: IdeaCardView; cardMeta?: ReactNode }): ReactElement {
  const navigate = useNavigate();
  return (
    <PlanItemCardBody
      view={props.view}
      onOpen={(v) => navigate(ideaHref(v))}
      cardMeta={props.cardMeta}
    />
  );
}

/** A loading idea card: ui/ChatCard with the card's own lines as bones, at its height. */
export function IdeaCardSkeleton(props: { cardMeta?: ReactNode } = {}): ReactElement {
  return (
    <ChatCard
      icon={IconBank}
      title={<Bone lit="flat" as="span" className="h-5 w-40 rounded" />}
      meta={<Bone lit="flat" as="span" className="h-4 w-32 rounded" />}
      time={props.cardMeta}
      rootProps={{ 'aria-hidden': true, 'data-idea-skeleton': '' }}
    />
  );
}

/**
 * The card itself: a pure render (no reads), so every state is tested
 * statically. ui/ChatCard (the card is the bubble): the bank glyph and the
 * idea's title on line 1, "{where} · {n} comments" on line 2; a tap opens it.
 * No access: the muted card with the line, no tap.
 */
export function PlanItemCardBody(props: {
  view: IdeaCardView;
  onOpen: (view: Extract<IdeaCardView, { kind: 'idea' }>) => void;
  cardMeta?: ReactNode;
}): ReactElement {
  const { view } = props;
  if (view.kind === 'none') {
    return (
      <ChatCard
        icon={IconBank}
        title={IDEA_NO_ACCESS}
        muted
        time={props.cardMeta}
        rootProps={{ 'data-idea-card': 'none' }}
      />
    );
  }
  return (
    <ChatCard
      icon={IconBank}
      title={<span data-idea-title="">{view.title}</span>}
      meta={
        <span data-idea-line="" className="truncate text-sm text-fg-2">
          {ideaLine(view)}
        </span>
      }
      onOpen={() => props.onOpen(view)}
      openLabel={`Open idea ${view.title}`}
      time={props.cardMeta}
      rootProps={{ 'data-idea-card': view.id }}
    />
  );
}
