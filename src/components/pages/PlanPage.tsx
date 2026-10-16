// The standalone Plan page (/plans/:planId?item=:itemId[&comment=:commentId]):
// the chat's Plan screen opened outside a chat, from an Activity plan row. The
// item named by ?item= opens on entry and takes no history step of its own, so
// one Back (the header's or the browser's) leaves the page. Back returns to
// the entry below when there is one (Activity), else replaces this entry with
// /activity (a cold deep link never strands the viewer). An unreadable plan
// (RLS empty, deleted, another workspace, a malformed id) shows the Plan
// screen's own "Plan not available" state, never a blank page. ?comment=
// scrolls to and highlights that comment once the item lists it.
// Laptop (md and up): /activity and /plans/:planId share one layout
// (ActivityPlanLayout), so Activity stays mounted (its scroll, filters and
// data) while the plan opens beside it as the same docked panel as in a chat,
// and closing returns to it without a remount. A plan opened from a plan
// replaces that entry, so Close is always one step back to Activity. Phone:
// the plan alone, full page, as before.

import { useCallback, useEffect, useRef } from 'react';
import type { ReactElement } from 'react';
import {
  Outlet,
  useLocation,
  useMatch,
  useNavigate,
  useNavigationType,
  useParams,
  useSearchParams,
} from 'react-router-dom';
import { IconPlan } from '@/components/ui/icons';
import { SearchWordsContext } from '@/components/ui/SearchHighlight';
import { readSearchJump } from '@/lib/search/jump';
import { PLAN_NOT_AVAILABLE } from '@/components/chat/plan-card';
import { ActivityPage } from '@/components/pages/ActivityPage';
import { PlanScreen, PlanPage as PlanFrame } from '@/components/chat/PlanScreen';
import { hasPreviousEntry } from '@/lib/chat/use-history-step';
import { cn } from '@/lib/cn';
import { LAPTOP_QUERY, useMediaQuery } from '@/lib/use-media-query';
import { useWorkspace } from '@/lib/workspace-context';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Whether a route or query value is a well-formed id (anything else reads nothing). Pure. */
export function isPlanId(value: string | null | undefined): value is string {
  return typeof value === 'string' && UUID.test(value);
}

/** Where the page's Back goes: one entry back, else Activity in place. Pure. */
export function planPageBack(state: unknown): { kind: 'pop' } | { kind: 'activity' } {
  return hasPreviousEntry(state) ? { kind: 'pop' } : { kind: 'activity' };
}

/**
 * Laptop: a plan pushed over another plan takes that plan's entry instead
 * (one step back, then a replace), so the stack holds one plan above
 * Activity. Pure.
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
    input.prev.startsWith('/plans/') &&
    input.here.startsWith('/plans/')
  );
}

/**
 * The route layout over /activity and /plans/:planId: Activity in one fixed
 * place (never remounted between the two) on a laptop and on /activity, with
 * the plan route beside it. From 1180px Activity narrows by the panel's
 * width; below, the panel overlays it.
 */
export function ActivityPlanLayout(): ReactElement {
  const plan = useMatch('/plans/:planId') !== null;
  const desktop = useMediaQuery(LAPTOP_QUERY);
  return (
    <>
      {!plan || desktop ? (
        <div data-activity-beside="" className={cn(plan && 'min-[1180px]:mr-[440px]')}>
          <ActivityPage />
        </div>
      ) : null}
      <Outlet />
    </>
  );
}

export function PlanPage(): ReactElement {
  const params = useParams<{ planId: string }>();
  const [search] = useSearchParams();
  const navigate = useNavigate();
  const navType = useNavigationType();
  const location = useLocation();
  const { workspaceId } = useWorkspace();
  const desktop = useMediaQuery(LAPTOP_QUERY);

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
    else navigate('/activity', { replace: true });
  }, [navigate]);

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
          <IconPlan size={22} />
          <p className="text-sm">{PLAN_NOT_AVAILABLE}</p>
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
