// The idea shared into a message (chat_plan_item_share), as a card: eyebrow
// IDEA with the bank icon, the idea's title, and "{where} · {n} comments"
// where {where} is "Bank", "Bank · archived" or "{plan} · {date}", all read
// live from plan_items (never a snapshot on the message). A tap opens the
// bank idea (/plan/bank?item=) or the plan item (/plan/{plan}?item=). A viewer
// RLS hides the idea from sees "You don't have access to this idea." and no
// tap. Every idea id across one thread page is read in one batch after paint
// (idea-cards.ts: one plan_items and one comments read, then one plans read);
// cards never read on their own. A message the chat open bundle carried
// without its idea ids (empty-looking) is resolved in the same pass with one
// chat_messages read. Tokens only; lit-card (live) and lit-card-muted (no
// access, failed).

import { useEffect, useMemo, useSyncExternalStore } from 'react';
import type { ReactElement } from 'react';
import { useNavigate } from 'react-router-dom';
import { Bone } from '@/lib/motion';
import { PressableRow } from '@/components/ui/PressableRow';
import { ICON_SIZE, IconBank } from '@/components/ui/icons';
import { CouldntLoadCard } from '@/components/chat/PostCard';
import {
  IDEA_EYEBROW,
  IDEA_NO_ACCESS,
  createIdeaCardStore,
  ideaHref,
  ideaLine,
  readIdeaCards,
  readMessageIdeaIds,
  type IdeaCardStore,
  type IdeaCardView,
} from '@/lib/chat/idea-cards';
import { PLAN_CHANGED_EVENT } from '@/lib/chat/plans';
import { cn } from '@/lib/cn';
import { supabase } from '@/lib/supabase';

/** The idea card frame: one width, card corners, one-line text. */
export const IDEA_CARD =
  'flex w-60 max-w-full flex-col gap-1 rounded-xl border px-3 py-2 text-left bg-panel lit-card';
/** The no-access and loading box: the same frame on the muted fill. */
export const IDEA_CARD_MUTED =
  'flex w-60 max-w-full flex-col gap-1 rounded-xl border px-3 py-2 text-left bg-panel-2 lit-card-muted';

let shared: IdeaCardStore | null = null;

/** The app's one idea card store (session long; values refresh on plan changes). */
export function ideaCardStore(): IdeaCardStore {
  if (shared === null) {
    shared = createIdeaCardStore({
      ideas: (ids) => readIdeaCards(supabase, ids),
      messages: (ids) => readMessageIdeaIds(supabase, ids),
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

/** A message's idea ids: its own, else (an empty-looking bundle row) the ones read for it. */
export function useMessageIdeaIds(
  messageId: string,
  own: readonly string[],
  ask: boolean,
): string[] {
  const store = ideaCardStore();
  useIdeaStoreVersion(store);
  useEffect(() => {
    if (ask && own.length === 0) store.requestMessages([messageId]);
  }, [store, ask, messageId, own.length]);
  if (own.length > 0) return [...own];
  return ask ? [...(store.messageIdeas(messageId) ?? [])] : [];
}

/** Whether an empty-looking message is still waiting for its idea ids. */
export function useMessageIdeasPending(messageId: string, ask: boolean): boolean {
  const store = ideaCardStore();
  useIdeaStoreVersion(store);
  return ask && store.messageIdeas(messageId) === undefined;
}

/**
 * The message with its idea ids: its own, else the ones the batch read for an
 * empty-looking bundle row (so menus treat it as an idea message). Pure over
 * the store's current values.
 */
export function withIdeaIds<M extends { id: string; sharedPlanItemIds?: string[] | undefined }>(
  message: M,
): M {
  if ((message.sharedPlanItemIds ?? []).length > 0) return message;
  const read = ideaCardStore().messageIdeas(message.id);
  return read !== undefined && read.length > 0
    ? { ...message, sharedPlanItemIds: [...read] }
    : message;
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

/** The idea cards of one message (`pending`: a bundle row whose ids are not read yet). */
export function SharedIdeaCards(props: { ideaIds: string[]; pending?: boolean }): ReactElement {
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
  if (props.pending === true && props.ideaIds.length === 0) {
    return (
      <div className="mt-1 flex flex-col items-start gap-1 text-fg">
        <IdeaCardSkeleton />
      </div>
    );
  }
  if (props.ideaIds.length === 0) return <></>;
  return (
    <div className="mt-1 flex flex-col items-start gap-1 text-fg">
      {views.map(({ id, view }) => {
        if (view === undefined) return <IdeaCardSkeleton key={id} />;
        if (view === 'failed') {
          return <CouldntLoadCard key={id} onRetry={() => store.refresh([id])} />;
        }
        return <LiveIdeaCard key={id} view={view} />;
      })}
    </div>
  );
}

/** One read card: a tap goes to the idea's route. */
function LiveIdeaCard(props: { view: IdeaCardView }): ReactElement {
  const navigate = useNavigate();
  return <PlanItemCardBody view={props.view} onOpen={(v) => navigate(ideaHref(v))} />;
}

/** A loading idea card: the card's own lines as bones, at its height. */
export function IdeaCardSkeleton(): ReactElement {
  return (
    <div data-idea-skeleton="" className={IDEA_CARD_MUTED}>
      <Bone lit="flat" as="div" className="h-4 w-12 rounded" />
      <Bone lit="flat" as="div" className="h-6 w-40 rounded" />
      <Bone lit="flat" as="div" className="h-4 w-32 rounded" />
    </div>
  );
}

/** The card itself: a pure render (no reads), so every state is tested statically. */
export function PlanItemCardBody(props: {
  view: IdeaCardView;
  onOpen: (view: Extract<IdeaCardView, { kind: 'idea' }>) => void;
}): ReactElement {
  const { view } = props;
  const eyebrow = (
    <span className="flex h-4 items-center gap-2 text-sm font-semibold uppercase tracking-[0.06em] text-fg-2">
      <IconBank size={ICON_SIZE.inline} />
      {IDEA_EYEBROW}
    </span>
  );
  if (view.kind === 'none') {
    return (
      <div data-idea-card="none" className={cn(IDEA_CARD_MUTED, 'text-fg-2')}>
        {eyebrow}
        <span className="truncate text-base font-medium">{IDEA_NO_ACCESS}</span>
      </div>
    );
  }
  return (
    <PressableRow
      inline
      card
      type="button"
      data-idea-card={view.id}
      onClick={() => props.onOpen(view)}
      className={IDEA_CARD}
    >
      {eyebrow}
      <span data-idea-title="" className="w-full truncate text-base font-medium text-fg">
        {view.title}
      </span>
      <span data-idea-line="" className="w-full truncate text-sm text-fg-2">
        {ideaLine(view)}
      </span>
    </PressableRow>
  );
}
