// The standalone Plan page (/plans/:planId?item=:itemId[&comment=:commentId]):
// the chat's Plan screen opened outside a chat, from an Activity plan row. The
// item named by ?item= opens on entry and takes no history step of its own, so
// one Back (the header's or the browser's) leaves the page. Back returns to
// the entry below when there is one (Activity), else replaces this entry with
// /activity (a cold deep link never strands the viewer). An unreadable plan
// (RLS empty, deleted, another workspace, a malformed id) shows the Plan
// screen's own "Plan not available" state, never a blank page. ?comment=
// scrolls to and highlights that comment once the item lists it.

import { useCallback } from 'react';
import type { ReactElement } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { IconPlan } from '@/components/ui/icons';
import { PLAN_NOT_AVAILABLE } from '@/components/chat/plan-card';
import { PlanScreen, PlanPage as PlanFrame } from '@/components/chat/PlanScreen';
import { hasPreviousEntry } from '@/lib/chat/use-history-step';
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

export function PlanPage(): ReactElement {
  const { planId } = useParams<{ planId: string }>();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const { workspaceId } = useWorkspace();
  const itemId = params.get('item');
  const commentId = params.get('comment');

  const close = useCallback(() => {
    if (planPageBack(window.history.state).kind === 'pop') navigate(-1);
    else navigate('/activity', { replace: true });
  }, [navigate]);

  if (!isPlanId(planId)) {
    return (
      <PlanFrame open testId="plan" title={PLAN_NOT_AVAILABLE} backLabel="Back" onBack={close}>
        <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-fg-2">
          <IconPlan size={22} />
          <p className="text-sm">{PLAN_NOT_AVAILABLE}</p>
        </div>
      </PlanFrame>
    );
  }

  return (
    <PlanScreen
      key={`${planId}:${itemId ?? ''}`}
      open
      planId={planId}
      {...(isPlanId(itemId) ? { initialItemId: itemId } : {})}
      {...(isPlanId(itemId) && isPlanId(commentId) ? { highlightCommentId: commentId } : {})}
      {...(workspaceId !== null ? { onlyWorkspaceId: workspaceId } : {})}
      onClose={close}
    />
  );
}
