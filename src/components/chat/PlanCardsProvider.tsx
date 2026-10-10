// The thread's plan cards, read in batches: every plan id across the loaded
// messages (threadCardIds) is asked of ONE cache per chat, which reads plans,
// then their items, then the items' reviews, then the post items' stages, each
// a plain select by an id list in chunks of 100 (plans.ts). Cards never read on
// their own. Failed reads retry like the shared post cards (tab visible,
// online, connected, on their own after 5s, up to 3 tries). A plan write
// anywhere dispatches PLAN_CHANGED_EVENT and the plan is re-read here; a post
// change re-reads every plan holding that post (its stage feeds progress).
// The provider also carries the chat's open-plan action and its title, so a
// card can open the Plan screen without props threaded through every bubble.

import { createContext, useContext, useEffect, useMemo, useRef } from 'react';
import type { ReactElement, ReactNode } from 'react';
import { watchCardRetries } from '@/components/chat/PostCard';
import { POST_CHANGED_EVENT } from '@/components/chat/post-card';
import {
  PLAN_CHANGED_EVENT,
  createPlanCardCache,
  planChangedId,
  readPlanBundles,
  type PlanCardCache,
} from '@/lib/chat/plans';
import { supabase } from '@/lib/supabase';
import type { ChatMessageRow } from '@/lib/chat/thread';

/** What the Plan screen needs to open from a card. */
export interface OpenPlanRequest {
  planId: string;
  /** The message sender's name (the client's "Shared by"). */
  senderName: string;
}

export interface PlanCardsContextValue {
  cache: PlanCardCache;
  /** The open chat's title (the agency's "Shared with"). */
  chatTitle: string;
  openPlan: (request: OpenPlanRequest) => void;
  /** The open chat's channel id. */
  channelId: string;
  /** Put a recorded own row into the open thread (and publish it live). */
  addRowHere: (row: ChatMessageRow, traceId: string) => void;
}

const PlanCardsContext = createContext<PlanCardsContextValue | null>(null);

/** The thread's plan cards context, or null outside a chat. */
export function usePlanCards(): PlanCardsContextValue | null {
  return useContext(PlanCardsContext);
}

/** The post id a POST_CHANGED_EVENT names, or null. Pure. */
export function postChangedId(event: Event): string | null {
  const detail = (event as CustomEvent<unknown>).detail;
  if (typeof detail !== 'object' || detail === null) return null;
  const id = (detail as Record<string, unknown>).postId;
  return typeof id === 'string' && id !== '' ? id : null;
}

/** The first readable plan's title for a plan message, or null (not loaded or not visible). */
export function planTitleOf(
  ctx: PlanCardsContextValue | null,
  message: { sharedPlanIds?: string[] | undefined },
): string | null {
  const ids = message.sharedPlanIds ?? [];
  if (ctx === null || ids.length === 0) return null;
  const bundles = ctx.cache.snapshot(ids).bundles;
  for (const id of ids) {
    const bundle = bundles.get(id);
    if (bundle !== undefined) return bundle.plan.title;
  }
  return null;
}

export function PlanCardsProvider(props: {
  workspaceId: string | null;
  channelId: string | null;
  planIds: readonly string[];
  chatTitle: string;
  onOpenPlan: (request: OpenPlanRequest) => void;
  /** A plan message recorded into this chat from a card (Forward here). */
  onRowHere: (row: ChatMessageRow, traceId: string) => void;
  /** The chat connection status: each transition to 'connected' retries failed reads. */
  status?: string;
  children: ReactNode;
}): ReactElement {
  const { workspaceId, channelId } = props;
  const cache = useMemo(
    () =>
      workspaceId !== null && channelId !== null
        ? createPlanCardCache((ids, signal) => readPlanBundles(supabase, ids, signal))
        : null,
    [workspaceId, channelId],
  );
  // StrictMode runs this cleanup and the effect again with the same cache.
  useEffect(() => {
    cache?.resume();
    return () => cache?.dispose();
  }, [cache]);
  const key = props.planIds.join(',');
  const idsRef = useRef(props.planIds);
  idsRef.current = props.planIds;
  useEffect(() => {
    if (idsRef.current.length > 0) cache?.request(idsRef.current);
  }, [cache, key]);
  useEffect(() => {
    if (cache === null) return;
    return watchCardRetries({ window, document }, () => cache.retryFailed());
  }, [cache]);
  const status = props.status;
  useEffect(() => {
    if (status === 'connected') cache?.retryFailed();
  }, [cache, status]);
  // A plan write (here or in a screen) re-reads that plan; a post change
  // re-reads every plan shown here that holds the post.
  useEffect(() => {
    if (cache === null) return;
    const onPlan = (event: Event): void => {
      const planId = planChangedId(event);
      if (planId !== null) cache.refresh([planId]);
    };
    const onPost = (event: Event): void => {
      const postId = postChangedId(event);
      if (postId === null) return;
      const snap = cache.snapshot(idsRef.current);
      const holding = [...snap.bundles.values()]
        .filter((b) => b.items.some((i) => i.post_id === postId))
        .map((b) => b.plan.id);
      if (holding.length > 0) cache.refresh(holding);
    };
    window.addEventListener(PLAN_CHANGED_EVENT, onPlan);
    window.addEventListener(POST_CHANGED_EVENT, onPost);
    return () => {
      window.removeEventListener(PLAN_CHANGED_EVENT, onPlan);
      window.removeEventListener(POST_CHANGED_EVENT, onPost);
    };
  }, [cache]);
  const onOpenPlan = props.onOpenPlan;
  const openRef = useRef(onOpenPlan);
  openRef.current = onOpenPlan;
  const rowHereRef = useRef(props.onRowHere);
  rowHereRef.current = props.onRowHere;
  const chatTitle = props.chatTitle;
  const value = useMemo<PlanCardsContextValue | null>(
    () =>
      cache !== null && channelId !== null
        ? {
            cache,
            chatTitle,
            channelId,
            openPlan: (request) => openRef.current(request),
            addRowHere: (row, traceId) => rowHereRef.current(row, traceId),
          }
        : null,
    [cache, chatTitle, channelId],
  );
  return <PlanCardsContext.Provider value={value}>{props.children}</PlanCardsContext.Provider>;
}
