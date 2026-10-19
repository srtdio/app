// The phone decision bar (T12 / FN8): Park / Reject / Approve pinned above the
// safe area, below md only. Rendered only for someone who can act on the
// current stage (an empty action set renders nothing). Approve is the one
// accent-filled button; the rest are plain. Hookless, so the tree is unit
// tested by walking it. The page adds its own bottom padding so the bar never
// covers the comment composer.

import type { ReactElement } from 'react';
import { Button } from '@/components/ui/Button';
import { INDUCTION_KEYS } from '@/lib/induction';
import type { StageAction } from '@/components/pages/pcs/stage-actions';
import type { Stage } from '@srtdio/posts';

/** Height the page reserves under its content so the bar covers nothing (px, plus the safe area). */
export const DECISION_BAR_SPACE_PX = 76;

/** Approve last, so it sits at the trailing edge; the rest keep their order. Pure. */
export function decisionBarOrder(actions: readonly StageAction[]): StageAction[] {
  const others = actions.filter((action) => action.to !== 'approved');
  const approve = actions.filter((action) => action.to === 'approved');
  return [...others, ...approve];
}

export function PostDecisionBar(props: {
  actions: readonly StageAction[];
  transitioning: boolean;
  onPick: (to: Stage) => void;
}): ReactElement | null {
  if (props.actions.length === 0) return null;
  const ordered = decisionBarOrder(props.actions);
  return (
    <div
      data-decision-bar=""
      className="fixed inset-x-0 bottom-0 z-40 border-t border-border bg-panel px-4 pt-3 pb-[max(12px,env(safe-area-inset-bottom))] md:hidden"
    >
      <div className="flex items-center gap-2">
        {ordered.map((action) => {
          const approve = action.to === 'approved';
          return (
            <Button
              key={action.to}
              size="lg"
              variant={approve ? 'primary' : 'default'}
              disabled={props.transitioning}
              onClick={() => props.onPick(action.to)}
              {...(approve ? { 'data-induction': INDUCTION_KEYS.postApprove } : {})}
              className={
                approve
                  ? 'min-w-[44px] flex-1'
                  : action.to === 'rejected'
                    ? 'min-w-[44px] flex-1 text-bad'
                    : 'min-w-[44px] flex-1'
              }
            >
              {action.label}
            </Button>
          );
        })}
      </div>
    </div>
  );
}
