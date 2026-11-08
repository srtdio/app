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
// /plan/bank?item=:itemId[&comment=:commentId] opens a bank idea (a concept
// with no plan) in the Item screen with no bundle: the kept idea paints first,
// then one shared planItemRead runs after paint. Back goes to the Plan tab with
// the Bank chip picked (/plan?week=bank).

import { mark } from '@/lib/perf-marks';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
import {
  BANK_BACK_LABEL,
  BANK_ITEM_TITLE,
  BANK_LABEL,
  PlanItemScreen,
  sharedBankItemRead,
} from '@/components/chat/PlanItemScreen';
import { bankItemReadWhat, PLAN_CHANGED_EVENT, type PlanItemRead } from '@/lib/chat/plans';
import { useViewerSide } from '@/lib/chat/viewer-role';
import { PLAN_BANK_CHIP, PLAN_WEEK_PARAM } from '@/lib/plan-tab';
import { Bone } from '@/lib/motion';
import { peekKept, readKey } from '@/lib/session-read';
import { useSession } from '@/lib/session-context';
import type { Result } from '@srtdio/rpc';
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
  mark('plan:open');
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

/** The bank idea route's path (?item= names the idea). */
export const PLAN_BANK_PATH = '/plan/bank';

/** A bank idea's route, with the comment to land on when given. Pure. */
export function planBankItemRoute(itemId: string, commentId?: string | null): string {
  const q = new URLSearchParams({ item: itemId });
  if (commentId !== null && commentId !== undefined) q.set('comment', commentId);
  return `${PLAN_BANK_PATH}?${q.toString()}`;
}

/** Where a bank idea's Back goes: the Plan tab, Bank chip picked. Pure. */
export function planBankBack(): string {
  return `/plan?${new URLSearchParams({ [PLAN_WEEK_PARAM]: PLAN_BANK_CHIP }).toString()}`;
}

/**
 * /plan/bank?item=: one bank idea. Paints the kept read at once (session or
 * device), else the frame with one box; the read starts after paint (an
 * effect) and the screen joins it (sharedRead, one network read).
 */
export function PlanBankItemPage(): ReactElement {
  const [search] = useSearchParams();
  const navigate = useNavigate();
  const { workspaceId } = useWorkspace();
  const { session } = useSession();
  const me = session?.user.id ?? null;
  const { side } = useViewerSide(workspaceId);
  const rawItem = search.get('item');
  const itemId = isPlanId(rawItem) ? rawItem : null;
  const rawComment = search.get('comment');
  const commentId = isPlanId(rawComment) ? rawComment : null;
  const key =
    me !== null && workspaceId !== null && itemId !== null
      ? readKey(me, workspaceId, bankItemReadWhat(itemId))
      : null;
  // What this route last settled, by its key; the kept read paints until then.
  const [settled, setSettled] = useState<{ key: string; result: Result<PlanItemRead> } | null>(
    null,
  );
  useEffect(() => {
    if (key === null || me === null || workspaceId === null || itemId === null) return;
    let live = true;
    void sharedBankItemRead(me, workspaceId, itemId).then((result) => {
      if (live) setSettled({ key, result });
    });
    return () => {
      live = false;
    };
  }, [key, me, workspaceId, itemId]);
  // A write anywhere (Edit > Save on this idea, a flag, a move) re-reads this
  // idea: the writer marks the kept read stale first (invalidateReads), so the
  // shared read goes to the network. The idea on screen stays until it lands
  // (no box); a key change ends the listener (live), so a result for a key
  // that is no longer current is dropped.
  useEffect(() => {
    if (key === null || me === null || workspaceId === null || itemId === null) return;
    let live = true;
    const onChanged = (): void => {
      void sharedBankItemRead(me, workspaceId, itemId).then((result) => {
        if (live) setSettled({ key, result });
      });
    };
    window.addEventListener(PLAN_CHANGED_EVENT, onChanged);
    return () => {
      live = false;
      window.removeEventListener(PLAN_CHANGED_EVENT, onChanged);
    };
  }, [key, me, workspaceId, itemId]);
  const kept = key !== null ? peekKept<Result<PlanItemRead>>(key) : undefined;
  const fresh = settled !== null && settled.key === key ? settled.result : null;
  // A failed refresh keeps the kept idea on screen.
  const read = fresh !== null && fresh.ok ? fresh : (kept ?? fresh);
  const bankLink = useMemo(
    () =>
      read !== null && read.ok
        ? { postStages: read.data.postStages, postInfo: read.data.postInfo }
        : undefined,
    [read],
  );
  const close = useCallback(() => navigate(planBankBack(), { replace: true }), [navigate]);

  if (read !== null && read.ok) {
    return (
      <PlanItemScreen
        open
        item={read.data.item}
        {...(bankLink !== undefined ? { bankLink } : {})}
        side={side}
        {...(commentId !== null ? { highlightCommentId: commentId } : {})}
        onClose={close}
      />
    );
  }
  const missing = itemId === null || (read !== null && !read.ok);
  return (
    <PlanFrame
      open
      testId="item"
      title={missing ? PLAN_NOT_AVAILABLE : BANK_ITEM_TITLE}
      {...(missing ? {} : { subtitle: BANK_LABEL })}
      backLabel={BANK_BACK_LABEL}
      closeLabel="Close plan"
      onBack={close}
    >
      {missing ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-fg-2">
          <IconPlan size={ICON_SIZE.tray} />
          <p className="text-base">{PLAN_NOT_AVAILABLE}</p>
        </div>
      ) : (
        <div className="flex flex-col gap-3 p-4">
          <Bone lit="flat" as="div" className="h-28 rounded-lg" />
        </div>
      )}
    </PlanFrame>
  );
}
