// The standalone Plan page (/plans/:planId?item=:itemId[&comment=:commentId],
// and /plan/:planId from the Plan tab): the chat's Plan screen opened outside a
// chat. The item named by ?item= opens on entry and takes no history step of
// its own, so one Back (the header's or the browser's) leaves the page. Back
// returns to the entry below when there is one, else replaces this entry with
// the page it sits beside (a cold deep link never strands the viewer). An
// unreadable plan (RLS empty, deleted, another workspace, a malformed id) shows
// the Plan screen's own "Plan not available" state, never a blank page.
// ?comment= scrolls to and highlights that comment once the item lists it.
// Laptop (md and up): the page beside the plan and the plan route share one
// layout (PlanBesideLayout.tsx: Notifications over /notifications and
// /plans/:planId, the Plan tab over /plan and /plan/:planId), so that page
// stays mounted (its scroll, filters and data) while the plan opens beside it
// as the same docked panel as in a chat, and closing returns to it without a
// remount. A plan opened from a plan replaces that entry, so Close is always
// one step back to the page. Phone: the plan alone, full page, as before.

import { useCallback, useEffect, useRef } from 'react';
import type { ReactElement } from 'react';
import {
  useLocation,
  useNavigate,
  useNavigationType,
  useParams,
  useSearchParams,
} from 'react-router-dom';
import { ICON_SIZE, IconPlan } from '@/components/ui/icons';
import { SearchWordsContext } from '@/components/ui/SearchHighlight';
import { readSearchJump } from '@/lib/search/jump';
import { PLAN_NOT_AVAILABLE } from '@/components/chat/plan-card';
import { PlanScreen, PlanPage as PlanFrame } from '@/components/chat/PlanScreen';
import { hasPreviousEntry } from '@/lib/chat/use-history-step';
import { useIsLaptop } from '@/lib/use-is-laptop';
import { useWorkspace } from '@/lib/workspace-context';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Whether a route or query value is a well-formed id (anything else reads nothing). Pure. */
export function isPlanId(value: string | null | undefined): value is string {
  return typeof value === 'string' && UUID.test(value);
}

/** Where the page's Back goes: one entry back, else the page beside it, in place. Pure. */
export function planPageBack(state: unknown): { kind: 'pop' } | { kind: 'fallback' } {
  return hasPreviousEntry(state) ? { kind: 'pop' } : { kind: 'fallback' };
}

/** Whether a path is a plan route (/plans/:planId or the Plan tab's /plan/:planId). Pure. */
export function isPlanPath(path: string): boolean {
  return path.startsWith('/plans/') || path.startsWith('/plan/');
}

/**
 * Laptop: a plan pushed over another plan takes that plan's entry instead
 * (one step back, then a replace), so the stack holds one plan above the page
 * beside it. Pure.
 */
export function replacesPlanEntry(input: {
  desktop: boolean;
  navType: 'POP' | 'PUSH' | 'REPLACE';
  prev: string | null;
  here: string;
}): boolean {
  return (
    input.desktop &&
    input.navType === 'PUSH' &&
    input.prev !== null &&
    input.prev !== input.here &&
    isPlanPath(input.prev) &&
    isPlanPath(input.here)
  );
}

// The layout lives in its own tiny module (Activity and the Plan tab load it
// without this page's chunk); re-exported here for existing importers.
export { PlanBesideLayout } from '@/components/pages/PlanBesideLayout';

/** `fallback`: where Back goes on a cold deep link (the page this plan sits beside). */
export function PlanPage(props: { fallback: string }): ReactElement {
  const { fallback } = props;
  const params = useParams<{ planId: string }>();
  const [search] = useSearchParams();
  const navigate = useNavigate();
  const navType = useNavigationType();
  const location = useLocation();
  const { workspaceId } = useWorkspace();
  const desktop = useIsLaptop();

  // A plan opened over a plan: step back, then replace with the new one; the
  // new plan shows throughout (no flash of the one it replaces).
  const here = `${location.pathname}${location.search}`;
  const prevRef = useRef<string | null>(null);
  const pendingRef = useRef<string | null>(null);
  useEffect(() => {
    const prev = prevRef.current;
    prevRef.current = here;
    const pending = pendingRef.current;
    if (pending !== null) {
      pendingRef.current = null;
      if (pending !== here) navigate(pending, { replace: true });
      return;
    }
    if (replacesPlanEntry({ desktop, navType, prev, here })) {
      pendingRef.current = here;
      navigate(-1);
    }
  }, [here, desktop, navType, navigate]);
  const shown = pendingRef.current !== null ? new URL(pendingRef.current, 'http://x') : null;
  const planId = shown !== null ? (shown.pathname.split('/')[2] ?? '') : params.planId;
  const itemId = (shown?.searchParams ?? search).get('item');
  const commentId = (shown?.searchParams ?? search).get('comment');
  // A search jump (the shared jump params): the item to scroll to and the words
  // to colour. Read from the url, never stripped: this page's own back logic
  // reads its entries, and the words go when the plan's entry does.
  const searchJump = readSearchJump(shown?.searchParams ?? search);

  const close = useCallback(() => {
    if (planPageBack(window.history.state).kind === 'pop') navigate(-1);
    else navigate(fallback, { replace: true });
  }, [navigate, fallback]);

  if (!isPlanId(planId)) {
    return (
      <PlanFrame
        open
        testId="plan"
        title={PLAN_NOT_AVAILABLE}
        backLabel="Back"
        closeLabel="Close plan"
        onBack={close}
      >
        <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-fg-2">
          <IconPlan size={ICON_SIZE.tray} />
          <p className="text-base">{PLAN_NOT_AVAILABLE}</p>
        </div>
      </PlanFrame>
    );
  }

  return (
    <SearchWordsContext.Provider value={searchJump.words}>
      <PlanScreen
        key={`${planId}:${itemId ?? ''}`}
        open
        planId={planId}
        {...(isPlanId(itemId) ? { initialItemId: itemId } : {})}
        {...(isPlanId(itemId) && isPlanId(commentId) ? { highlightCommentId: commentId } : {})}
        {...(isPlanId(searchJump.targetId) ? { jumpItemId: searchJump.targetId } : {})}
        {...(workspaceId !== null ? { onlyWorkspaceId: workspaceId } : {})}
        onClose={close}
      />
    </SearchWordsContext.Provider>
  );
}
